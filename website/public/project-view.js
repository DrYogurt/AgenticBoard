// AgenticBoard — Project View / Workflow (ADW) Editor
//
// Standalone module: builds its own modal (#modal-project-view), injects it
// into the DOM on first use, and edits a project's `adws[]` (id/name/path/
// model/agents/parameters) with a searchable model picker fed by
// GET /api/v1/models. Nothing is persisted until "save changes", which
// sends the whole adws array via the generic /api/v1/command endpoint
// (update_project).
//
// Public API: window.ProjectView = { open, bindProjectRows, refresh }

const ProjectView = (() => {
  let modal = null;
  let currentProjectId = null;
  let currentDraft = null;
  let dirty = false;
  let pickerCleanups = [];

  let modelsCache = null;
  let modelsError = null;
  let modelsLoadAttempted = false;

  let fetchedProjectsCache = null;
  let usedFallbackFetch = false;

  // ── helpers ──────────────────────────────────────────────────────────

  function getAppState() {
    try {
      if (typeof state !== 'undefined' && state && Array.isArray(state.projects)) {
        return state;
      }
    } catch (e) { /* TDZ or not declared yet — fall through to fetch */ }
    try {
      if (window.state && Array.isArray(window.state.projects)) return window.state;
    } catch (e) { }
    return null;
  }

  async function apiCallLocal(endpoint, method, body) {
    if (typeof apiCall === 'function') {
      return apiCall(endpoint, method, body);
    }
    const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(endpoint, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.success === false)) {
      throw new Error((data && data.error) || `HTTP error ${res.status}`);
    }
    return data && data.data !== undefined ? data.data : data;
  }

  async function getProjectsList() {
    const appState = getAppState();
    if (appState) return appState.projects;
    if (fetchedProjectsCache) return fetchedProjectsCache;
    usedFallbackFetch = true;
    try {
      const projects = await apiCallLocal('/api/v1/projects');
      fetchedProjectsCache = Array.isArray(projects) ? projects : [];
    } catch (e) {
      console.error('ProjectView: failed to fetch projects', e);
      fetchedProjectsCache = [];
    }
    return fetchedProjectsCache;
  }

  function mkFormGroup(labelText, inputEl, extraClass) {
    const g = document.createElement('div');
    g.className = 'form-group' + (extraClass ? ' ' + extraClass : '');
    const l = document.createElement('label');
    l.textContent = labelText;
    g.appendChild(l);
    g.appendChild(inputEl);
    return g;
  }

  function mkTextInput(value, placeholder, onInput, extraClass) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input' + (extraClass ? ' ' + extraClass : '');
    input.placeholder = placeholder || '';
    input.value = value || '';
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function markDirty() {
    dirty = true;
    const banner = document.getElementById('pv-save-banner');
    if (banner) banner.innerHTML = '';
  }

  function showBanner(msg, ok) {
    const banner = document.getElementById('pv-save-banner');
    if (!banner) return;
    banner.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'pv-save-banner ' + (ok ? 'pv-ok' : 'pv-err');
    el.textContent = msg;
    banner.appendChild(el);
  }

  // ── model list (lazy fetch, cached for page lifetime) ──────────────────

  async function ensureModelsLoaded() {
    if (modelsLoadAttempted) return;
    modelsLoadAttempted = true;
    try {
      const res = await fetch('/api/v1/models');
      if (res.status === 404) {
        modelsError = 'model list endpoint not available yet';
        modelsCache = [];
        return;
      }
      const data = await res.json().catch(() => null);
      const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
      modelsCache = list;
      if (data && typeof data.error === 'string' && data.error) {
        modelsError = data.error;
      } else if (!res.ok) {
        modelsError = (data && data.error) || `HTTP ${res.status}`;
      }
    } catch (e) {
      modelsError = 'failed to reach model list endpoint';
      modelsCache = [];
    }
  }

  function filterModels(query) {
    const q = (query || '').trim().toLowerCase();
    const list = modelsCache || [];
    if (!q) return list;
    return list.filter((m) =>
      (m.provider && String(m.provider).toLowerCase().includes(q)) ||
      (m.model && String(m.model).toLowerCase().includes(q)) ||
      (m.id && String(m.id).toLowerCase().includes(q))
    );
  }

  const MODEL_RESULT_CAP = 50;

  function createModelPicker(adw, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-model-picker';

    const selectedRow = document.createElement('div');
    selectedRow.className = 'pv-model-picker-selected';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.placeholder = 'search or type a model...';
    input.value = adw.model || '';
    input.autocomplete = 'off';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pv-model-clear-btn';
    clearBtn.title = 'clear model';
    clearBtn.textContent = '✕';
    clearBtn.style.display = adw.model ? '' : 'none';

    selectedRow.appendChild(input);
    selectedRow.appendChild(clearBtn);

    const dropdown = document.createElement('div');
    dropdown.className = 'pv-model-dropdown hidden';

    wrap.appendChild(selectedRow);
    wrap.appendChild(dropdown);

    let activeIndex = -1;
    let capped = [];
    let userTyped = false;

    function commit(value) {
      adw.model = value || undefined;
      input.value = value || '';
      clearBtn.style.display = value ? '' : 'none';
      onChange();
    }

    function highlightActive() {
      const opts = dropdown.querySelectorAll('.pv-model-option');
      opts.forEach((o, i) => o.classList.toggle('pv-active', i === activeIndex));
      if (opts[activeIndex]) opts[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function renderDropdown() {
      dropdown.innerHTML = '';
      activeIndex = -1;
      capped = [];

      if (modelsError) {
        const note = document.createElement('div');
        note.className = 'pv-model-dropdown-note';
        note.textContent = `model list unavailable — type a model string manually (${modelsError})`;
        dropdown.appendChild(note);
      }

      if (!modelsCache || modelsCache.length === 0) {
        if (!modelsError) {
          const empty = document.createElement('div');
          empty.className = 'pv-model-dropdown-empty';
          empty.textContent = 'no models loaded';
          dropdown.appendChild(empty);
        }
        return;
      }

      // Until the user types, ignore the prefilled model — otherwise reopening a
      // picker that already has one filters down to just that entry.
      const matches = filterModels(userTyped ? input.value : '');
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pv-model-dropdown-empty';
        empty.textContent = 'no matches';
        dropdown.appendChild(empty);
        return;
      }

      capped = matches.slice(0, MODEL_RESULT_CAP);
      capped.forEach((m) => {
        const opt = document.createElement('div');
        opt.className = 'pv-model-option';
        opt.setAttribute('role', 'option');
        const badge = document.createElement('span');
        badge.className = 'pv-model-provider-badge';
        badge.textContent = m.provider || '?';
        const name = document.createElement('span');
        name.className = 'pv-model-name';
        name.textContent = m.model || m.id || '';
        opt.appendChild(badge);
        opt.appendChild(name);
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(m.id || `${m.provider}/${m.model}`);
          hideDropdown();
        });
        dropdown.appendChild(opt);
      });

      if (matches.length > capped.length) {
        const hint = document.createElement('div');
        hint.className = 'pv-model-dropdown-hint';
        hint.textContent = `…${matches.length - capped.length} more, keep typing`;
        dropdown.appendChild(hint);
      }
    }

    function showDropdown() {
      dropdown.classList.remove('hidden');
      renderDropdown();
    }
    function hideDropdown() {
      dropdown.classList.add('hidden');
      activeIndex = -1;
    }

    input.addEventListener('focus', async () => {
      userTyped = false;
      dropdown.innerHTML = '<div class="pv-model-dropdown-hint">loading models…</div>';
      dropdown.classList.remove('hidden');
      await ensureModelsLoaded();
      renderDropdown();
    });

    input.addEventListener('input', () => {
      userTyped = true;
      adw.model = input.value.trim() || undefined;
      clearBtn.style.display = input.value ? '' : 'none';
      onChange();
      if (!dropdown.classList.contains('hidden')) renderDropdown();
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (capped.length === 0) return;
        activeIndex = (activeIndex + 1) % capped.length;
        highlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (capped.length === 0) return;
        activeIndex = (activeIndex - 1 + capped.length) % capped.length;
        highlightActive();
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0 && capped[activeIndex]) {
          e.preventDefault();
          const m = capped[activeIndex];
          commit(m.id || `${m.provider}/${m.model}`);
        }
        hideDropdown();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideDropdown();
      }
    });

    clearBtn.addEventListener('click', () => {
      commit('');
      input.focus();
    });

    function onDocMouseDown(e) {
      if (!wrap.contains(e.target)) hideDropdown();
    }
    document.addEventListener('mousedown', onDocMouseDown);

    return {
      el: wrap,
      cleanup: () => document.removeEventListener('mousedown', onDocMouseDown)
    };
  }

  // ── agents / parameters editors ─────────────────────────────────────

  function renderAgentsList(adw, container) {
    container.innerHTML = '';
    (adw.agents || []).forEach((agentName, idx) => {
      const row = document.createElement('div');
      row.className = 'pv-agent-row';
      const input = mkTextInput(agentName, 'agent name', (v) => {
        adw.agents[idx] = v;
        markDirty();
      }, 'flex-1');
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'pv-icon-btn';
      rmBtn.title = 'remove agent';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', () => {
        adw.agents.splice(idx, 1);
        renderAgentsList(adw, container);
        markDirty();
      });
      row.appendChild(input);
      row.appendChild(rmBtn);
      container.appendChild(row);
    });
  }

  function renderParamsList(adw, container) {
    container.innerHTML = '';
    (adw.parameters || []).forEach((param, idx) => {
      const row = document.createElement('div');
      row.className = 'pv-param-row';

      const nameInput = mkTextInput(param.name || '', 'name', (v) => { param.name = v; markDirty(); }, 'flex-1');
      const flagInput = mkTextInput(param.flag || '', 'flag (--foo)', (v) => { param.flag = v; markDirty(); }, 'flex-1');

      const typeSelect = document.createElement('select');
      typeSelect.className = 'form-input pv-param-type-select';
      ['string', 'number', 'boolean'].forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        if ((param.type || 'string') === t) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => { param.type = typeSelect.value; markDirty(); });

      const labelInput = mkTextInput(param.label || '', 'label (optional)', (v) => {
        if (v) param.label = v; else delete param.label;
        markDirty();
      }, 'flex-1');

      const defaultInput = mkTextInput(param.default !== undefined ? String(param.default) : '', 'default (optional)', (v) => {
        if (v === '') delete param.default; else param.default = v;
        markDirty();
      }, 'flex-1');

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'pv-icon-btn';
      rmBtn.title = 'remove parameter';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', () => {
        const arr = adw.parameters;
        const i = arr.indexOf(param);
        if (i >= 0) arr.splice(i, 1);
        renderParamsList(adw, container);
        markDirty();
      });

      row.appendChild(nameInput);
      row.appendChild(flagInput);
      row.appendChild(typeSelect);
      row.appendChild(labelInput);
      row.appendChild(defaultInput);
      row.appendChild(rmBtn);
      container.appendChild(row);
    });
  }

  // ── ADW card ─────────────────────────────────────────────────────────

  function renderAdwCard(adw) {
    const originalId = adw.id;
    const card = document.createElement('div');
    card.className = 'pv-adw-card';

    const header = document.createElement('div');
    header.className = 'pv-adw-card-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'pv-adw-card-title';
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = adw.name || adw.id || '(new workflow)';
    const idTag = document.createElement('span');
    idTag.className = 'pv-adw-id-tag';
    idTag.textContent = adw.id ? `[${adw.id}]` : '[unsaved]';
    titleWrap.appendChild(nameSpan);
    titleWrap.appendChild(idTag);

    const caret = document.createElement('span');
    caret.className = 'pv-adw-caret';
    caret.textContent = '▸';

    header.appendChild(titleWrap);
    header.appendChild(caret);
    header.addEventListener('click', () => card.classList.toggle('pv-expanded'));

    const body = document.createElement('div');
    body.className = 'pv-adw-card-body';

    const warnEl = document.createElement('div');
    warnEl.className = 'pv-warning';
    warnEl.textContent = 'Renaming this workflow id can orphan existing tasks that reference the old id.';
    warnEl.style.display = 'none';

    const row1 = document.createElement('div');
    row1.className = 'form-row';
    const idInput = mkTextInput(adw.id, 'e.g. build-feature', (v) => {
      adw.id = v;
      idTag.textContent = v ? `[${v}]` : '[unsaved]';
      nameSpan.textContent = adw.name || v || '(new workflow)';
      warnEl.style.display = (originalId && v !== originalId) ? '' : 'none';
      markDirty();
    });
    const nameInput = mkTextInput(adw.name || '', 'e.g. Build Feature', (v) => {
      adw.name = v;
      nameSpan.textContent = v || adw.id || '(new workflow)';
      markDirty();
    });
    row1.appendChild(mkFormGroup('workflow id', idInput, 'flex-1'));
    row1.appendChild(mkFormGroup('display name', nameInput, 'flex-1'));
    body.appendChild(row1);
    body.appendChild(warnEl);

    const pathInput = mkTextInput(adw.path, 'e.g. adws/build_feature.py', (v) => { adw.path = v; markDirty(); });
    body.appendChild(mkFormGroup('script path (within project)', pathInput));

    const modelGroup = document.createElement('div');
    modelGroup.className = 'form-group';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'model';
    modelGroup.appendChild(modelLabel);
    const picker = createModelPicker(adw, markDirty);
    pickerCleanups.push(picker.cleanup);
    modelGroup.appendChild(picker.el);
    body.appendChild(modelGroup);

    // agents
    const agentsSection = document.createElement('div');
    const agentsHeader = document.createElement('div');
    agentsHeader.className = 'pv-section-header';
    const agentsH = document.createElement('label');
    agentsH.textContent = 'agents';
    const addAgentBtn = document.createElement('button');
    addAgentBtn.type = 'button';
    addAgentBtn.className = 'btn btn-secondary pv-small-btn';
    addAgentBtn.textContent = '+ agent';
    agentsHeader.appendChild(agentsH);
    agentsHeader.appendChild(addAgentBtn);
    agentsSection.appendChild(agentsHeader);
    const agentsListEl = document.createElement('div');
    agentsListEl.className = 'pv-agents-list';
    agentsSection.appendChild(agentsListEl);
    if (!adw.agents) adw.agents = [];
    renderAgentsList(adw, agentsListEl);
    addAgentBtn.addEventListener('click', () => {
      adw.agents.push('');
      renderAgentsList(adw, agentsListEl);
      markDirty();
    });
    body.appendChild(agentsSection);

    // parameters
    const paramsSection = document.createElement('div');
    const paramsHeader = document.createElement('div');
    paramsHeader.className = 'pv-section-header';
    const paramsH = document.createElement('label');
    paramsH.textContent = 'parameters';
    const addParamBtn = document.createElement('button');
    addParamBtn.type = 'button';
    addParamBtn.className = 'btn btn-secondary pv-small-btn';
    addParamBtn.textContent = '+ parameter';
    paramsHeader.appendChild(paramsH);
    paramsHeader.appendChild(addParamBtn);
    paramsSection.appendChild(paramsHeader);
    const paramsListEl = document.createElement('div');
    paramsListEl.className = 'pv-params-list';
    paramsSection.appendChild(paramsListEl);
    if (!adw.parameters) adw.parameters = [];
    renderParamsList(adw, paramsListEl);
    addParamBtn.addEventListener('click', () => {
      adw.parameters.push({ name: '', flag: '', type: 'string' });
      renderParamsList(adw, paramsListEl);
      markDirty();
    });
    body.appendChild(paramsSection);

    // footer
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const spacer = document.createElement('div');
    spacer.className = 'flex-spacer';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger pv-small-btn';
    delBtn.textContent = 'delete workflow';
    delBtn.addEventListener('click', () => {
      const label = adw.name || adw.id || '(unnamed workflow)';
      if (!confirm(`Delete workflow "${label}"? This isn't saved until you click "save changes", but once saved, any tasks referencing it will be orphaned.`)) return;
      const arr = currentDraft.adws;
      const i = arr.indexOf(adw);
      if (i >= 0) arr.splice(i, 1);
      markDirty();
      renderAdwList();
    });
    footer.appendChild(spacer);
    footer.appendChild(delBtn);
    body.appendChild(footer);

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function renderAdwList() {
    const listEl = document.getElementById('pv-adw-list');
    if (!listEl) return;
    pickerCleanups.forEach((fn) => fn());
    pickerCleanups = [];
    listEl.innerHTML = '';

    const adws = currentDraft.adws || (currentDraft.adws = []);
    if (adws.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = 'no workflows registered for this project yet.';
      listEl.appendChild(empty);
      return;
    }
    adws.forEach((adw) => listEl.appendChild(renderAdwCard(adw)));
  }

  // ── project meta ─────────────────────────────────────────────────────

  function renderMeta(proj) {
    const metaEl = document.getElementById('pv-meta');
    if (!metaEl) return;
    metaEl.innerHTML = '';

    const titleRow = document.createElement('div');
    titleRow.className = 'pv-meta-row';
    const title = document.createElement('span');
    title.className = 'pv-title';
    title.textContent = proj.name || proj.id;
    const idTag = document.createElement('span');
    idTag.className = 'pv-adw-id-tag';
    idTag.textContent = `[prefix: ${proj.id}]`;
    titleRow.appendChild(title);
    titleRow.appendChild(idTag);
    metaEl.appendChild(titleRow);

    const pathRow = document.createElement('div');
    pathRow.className = 'pv-path';
    pathRow.textContent = proj.path || '';
    metaEl.appendChild(pathRow);

    if (proj.agent_files && proj.agent_files.length) {
      const filesWrap = document.createElement('div');
      filesWrap.className = 'pv-agent-files';
      proj.agent_files.forEach((f) => {
        const b = document.createElement('span');
        b.className = 'tag-badge tag-agent';
        b.textContent = f;
        filesWrap.appendChild(b);
      });
      metaEl.appendChild(filesWrap);
    }

    const titleEl = document.getElementById('pv-modal-title');
    if (titleEl) titleEl.textContent = `project — ${proj.name || proj.id}`;
  }

  // ── save ─────────────────────────────────────────────────────────────

  function buildParamPayload(p) {
    const out = { name: (p.name || '').trim(), flag: (p.flag || '').trim(), type: p.type || 'string' };
    if (p.label && String(p.label).trim()) out.label = String(p.label).trim();
    if (p.default !== undefined && p.default !== '') {
      if (out.type === 'number') {
        const n = Number(p.default);
        out.default = Number.isNaN(n) ? p.default : n;
      } else if (out.type === 'boolean') {
        out.default = p.default === true || p.default === 'true';
      } else {
        out.default = p.default;
      }
    }
    return out;
  }

  async function handleSave() {
    const banner = document.getElementById('pv-save-banner');
    if (banner) banner.innerHTML = '';

    const adws = currentDraft.adws || [];
    const seenIds = new Set();
    for (let i = 0; i < adws.length; i++) {
      const a = adws[i];
      const id = (a.id || '').trim();
      const path = (a.path || '').trim();
      if (!id || !path) {
        showBanner(`workflow #${i + 1} needs both an id and a path before saving.`, false);
        return;
      }
      if (seenIds.has(id)) {
        showBanner(`duplicate workflow id "${id}" — ids must be unique.`, false);
        return;
      }
      seenIds.add(id);
      for (const p of (a.parameters || [])) {
        if (!p.name || !String(p.name).trim() || !p.flag || !String(p.flag).trim()) {
          showBanner(`workflow "${id}" has a parameter missing a name or flag.`, false);
          return;
        }
      }
    }

    const payloadAdws = adws.map((a) => {
      const out = { id: a.id.trim(), path: a.path.trim() };
      if (a.name && String(a.name).trim()) out.name = String(a.name).trim();
      if (a.model && String(a.model).trim()) out.model = String(a.model).trim();
      const agents = (a.agents || []).map((x) => (x || '').trim()).filter(Boolean);
      if (agents.length) out.agents = agents;
      const params = (a.parameters || []).map(buildParamPayload);
      if (params.length) out.parameters = params;
      return out;
    });

    const saveBtn = document.getElementById('pv-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await apiCallLocal('/api/v1/command', 'POST', {
        type: 'update_project',
        payload: { id: currentProjectId, adws: payloadAdws }
      });
      dirty = false;
      showBanner('saved.', true);
      fetchedProjectsCache = null;
    } catch (err) {
      showBanner(`save failed: ${(err && err.message) || err}`, false);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ── modal shell ──────────────────────────────────────────────────────

  function closeProjectView() {
    if (!modal) return;
    modal.classList.add('hidden');
    pickerCleanups.forEach((fn) => fn());
    pickerCleanups = [];
  }

  function ensureModal() {
    if (modal) return modal;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div id="modal-project-view" class="modal-backdrop hidden">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h3 id="pv-modal-title">project</h3>
            <button type="button" class="modal-close" data-close="modal-project-view">&times;</button>
          </div>
          <div class="modal-body">
            <div class="pv-meta" id="pv-meta"></div>
            <hr class="modal-divider" />
            <div class="pv-section-header">
              <h4>workflows (adws)</h4>
              <button type="button" class="btn btn-secondary pv-small-btn" id="pv-add-adw-btn">+ add workflow</button>
            </div>
            <div class="pv-adw-list" id="pv-adw-list"></div>
            <div id="pv-save-banner"></div>
            <div class="modal-footer">
              <div class="flex-spacer"></div>
              <button type="button" class="btn btn-secondary" data-close="modal-project-view">close</button>
              <button type="button" class="btn btn-primary" id="pv-save-btn">save changes</button>
            </div>
          </div>
        </div>
      </div>
    `;
    modal = wrapper.firstElementChild;
    (document.getElementById('app') || document.body).appendChild(modal);

    modal.querySelectorAll('[data-close="modal-project-view"]').forEach((btn) => {
      btn.addEventListener('click', closeProjectView);
    });

    const addBtn = document.getElementById('pv-add-adw-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (!currentDraft) return;
        if (!currentDraft.adws) currentDraft.adws = [];
        currentDraft.adws.push({ id: '', path: '', name: '', agents: [], parameters: [] });
        markDirty();
        renderAdwList();
        const cards = modal.querySelectorAll('#pv-adw-list .pv-adw-card');
        const last = cards[cards.length - 1];
        if (last) {
          last.classList.add('pv-expanded');
          last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }

    const saveBtn = document.getElementById('pv-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', handleSave);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeProjectView();
      }
    });

    return modal;
  }

  // ── public API ───────────────────────────────────────────────────────

  async function open(projectId) {
    ensureModal();
    const projects = await getProjectsList();
    const proj = projects.find((p) => p.id === projectId);

    currentProjectId = projectId;
    const banner = document.getElementById('pv-save-banner');
    if (banner) banner.innerHTML = '';

    if (!proj) {
      const metaEl = document.getElementById('pv-meta');
      if (metaEl) {
        metaEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'pv-empty';
        err.textContent = `project not found: ${projectId}`;
        metaEl.appendChild(err);
      }
      const listEl = document.getElementById('pv-adw-list');
      if (listEl) listEl.innerHTML = '';
      currentDraft = { id: projectId, adws: [] };
      modal.classList.remove('hidden');
      return;
    }

    currentDraft = JSON.parse(JSON.stringify(proj));
    if (!currentDraft.adws) currentDraft.adws = [];
    dirty = false;

    renderMeta(currentDraft);
    renderAdwList();
    modal.classList.remove('hidden');
  }

  function getRowProjectId(rowEl, index, projects) {
    if (rowEl && rowEl.dataset && rowEl.dataset.projectId) return rowEl.dataset.projectId;
    const p = projects[index];
    return p ? p.id : null;
  }

  function bindProjectRows(containerEl) {
    if (!containerEl || containerEl._pvBound) return;
    containerEl._pvBound = true;
    containerEl.addEventListener('click', async (e) => {
      const row = e.target.closest('.item-card-row');
      if (!row || !containerEl.contains(row)) return;
      const projects = await getProjectsList();
      const rows = Array.from(containerEl.querySelectorAll('.item-card-row'));
      const idx = rows.indexOf(row);
      const pid = getRowProjectId(row, idx, projects);
      if (pid) open(pid);
    });
  }

  function refresh() {
    fetchedProjectsCache = null;
  }

  return { open, bindProjectRows, refresh };
})();

window.ProjectView = ProjectView;

// AgenticBoard — Project View / Workflow (ADW) Editor
//
// Standalone module: builds its own modal (#modal-project-view), injects it
// into the DOM on first use, and edits a project's `adws[]` (id/name/path/
// model/parameters) with a searchable model picker fed by GET /api/v1/models.
// Nothing is persisted until "save changes", which sends the whole adws array
// via the generic /api/v1/command endpoint (update_project).
//
// Agent selection is just another ADW parameter: a parameter with
// `type: 'agent'` means its `default` is an Agent id (this is exactly SSSF's
// own `--agent` CLI-flag convention — e.g. `adw_prompt.py`'s real `agent`
// parameter with `default: 'builder'`). There is deliberately no separate
// ADW-level "agents" field or free-text-to-registry promotion step — the
// parameter *is* the reference, so editing an ADW only ever means editing
// its parameters.
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

  // Agent registry (list_agents) — shared between the "Agent Roles" section
  // and any `type: 'agent'` parameter's default-value picker (see
  // createAgentDefaultPicker below).
  let agentsCache = null;
  let agentsError = null;
  let agentsLoadAttempted = false;
  // Agent ids created via "+ new agent role" this modal session that aren't
  // (yet) referenced by any ADW parameter — kept visible until the modal is
  // reopened, since the registry itself has no per-project concept of them.
  let extraAgentIds = [];
  // In-progress "+ new agent role" cards that haven't been registered yet.
  let pendingAgentDrafts = [];
  // Document-level listener cleanups for pickers inside the Agent Roles
  // section specifically (separate from pickerCleanups, which is scoped to
  // the ADW list and fully rebuilt by renderAdwList()).
  let agentPickerCleanups = [];

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

  // ── agent registry (list_agents) — lazy fetch, cached for page lifetime ─

  async function ensureAgentsLoaded(force) {
    if (agentsLoadAttempted && !force) return;
    agentsLoadAttempted = true;
    try {
      const data = await apiCallLocal('/api/v1/command', 'POST', { type: 'list_agents', payload: {} });
      agentsCache = Array.isArray(data) ? data : [];
      agentsError = null;
    } catch (e) {
      agentsCache = agentsCache || [];
      agentsError = (e && e.message) || 'failed to reach agent registry';
    }
  }

  function findAgentById(id) {
    return (agentsCache || []).find((a) => a.id === id) || null;
  }

  function slugify(str) {
    const s = String(str || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'agent';
  }

  function uniqueAgentId(name) {
    const base = slugify(name);
    const existing = new Set((agentsCache || []).map((a) => a.id));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  const AGENT_RESULT_CAP = 50;

  // The default-value picker for a `type: 'agent'` parameter — sourced from
  // the Agent registry but still free text: a parameter's default may be an
  // agent id that has no registry entry yet (that's exactly the "not yet
  // configured" case the Agent Roles section above handles).
  function createAgentDefaultPicker(param, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-agent-name-picker flex-1';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.placeholder = 'agent id';
    input.autocomplete = 'off';
    input.value = param.default !== undefined ? String(param.default) : '';
    wrap.appendChild(input);

    const dropdown = document.createElement('div');
    dropdown.className = 'pv-agent-dropdown hidden';
    wrap.appendChild(dropdown);

    function filterAgents(query) {
      const q = (query || '').trim().toLowerCase();
      const list = agentsCache || [];
      if (!q) return list;
      return list.filter((a) =>
        (a.name || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q)
      );
    }

    function commit(id) {
      if (id) param.default = id; else delete param.default;
      input.value = id || '';
      onChange();
    }

    function renderDropdown() {
      dropdown.innerHTML = '';
      if (agentsError) {
        const note = document.createElement('div');
        note.className = 'pv-agent-dropdown-note';
        note.textContent = `agent registry unavailable — type an id manually (${agentsError})`;
        dropdown.appendChild(note);
      }
      const matches = filterAgents(input.value);
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pv-agent-dropdown-empty';
        empty.textContent = (agentsCache && agentsCache.length) ? 'no matches' : 'no agents registered yet — type a new id';
        dropdown.appendChild(empty);
        return;
      }
      matches.slice(0, AGENT_RESULT_CAP).forEach((a) => {
        const opt = document.createElement('div');
        opt.className = 'pv-agent-option';
        opt.setAttribute('role', 'option');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'pv-agent-option-name';
        nameSpan.textContent = a.name;
        opt.appendChild(nameSpan);
        if (a.id !== a.name) {
          const idSpan = document.createElement('span');
          idSpan.className = 'pv-agent-option-id';
          idSpan.textContent = a.id;
          opt.appendChild(idSpan);
        }
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(a.id);
          hideDropdown();
        });
        dropdown.appendChild(opt);
      });
    }

    function hideDropdown() {
      dropdown.classList.add('hidden');
    }

    input.addEventListener('focus', async () => {
      dropdown.innerHTML = '<div class="pv-agent-dropdown-hint">loading agents…</div>';
      dropdown.classList.remove('hidden');
      await ensureAgentsLoaded();
      renderDropdown();
    });

    input.addEventListener('input', () => {
      if (input.value) param.default = input.value; else delete param.default;
      onChange();
      if (!dropdown.classList.contains('hidden')) renderDropdown();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideDropdown();
      }
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

  // ── parameters editor (shared by an ADW's own parameters and an Agent's) ─
  //
  // A `type: 'agent'` row swaps its "default" field for createAgentDefaultPicker
  // instead of a plain text input — everything else about a parameter row is
  // identical regardless of who owns the array.

  function renderParamsList(params, container, onChange, cleanupsArr) {
    container.innerHTML = '';
    params.forEach((param, idx) => {
      const row = document.createElement('div');
      row.className = 'pv-param-row';

      const nameInput = mkTextInput(param.name || '', 'name', (v) => { param.name = v; onChange(); }, 'flex-1');
      const flagInput = mkTextInput(param.flag || '', 'flag (--foo)', (v) => { param.flag = v; onChange(); }, 'flex-1');

      const typeSelect = document.createElement('select');
      typeSelect.className = 'form-input pv-param-type-select';
      ['string', 'number', 'boolean', 'agent'].forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        if ((param.type || 'string') === t) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => {
        param.type = typeSelect.value;
        onChange();
        renderParamsList(params, container, onChange, cleanupsArr);
      });

      const labelInput = mkTextInput(param.label || '', 'label (optional)', (v) => {
        if (v) param.label = v; else delete param.label;
        onChange();
      }, 'flex-1');

      let defaultField;
      if ((param.type || 'string') === 'agent') {
        const picker = createAgentDefaultPicker(param, onChange);
        defaultField = picker.el;
        if (cleanupsArr) cleanupsArr.push(picker.cleanup);
      } else {
        defaultField = mkTextInput(param.default !== undefined ? String(param.default) : '', 'default (optional)', (v) => {
          if (v === '') delete param.default; else param.default = v;
          onChange();
        }, 'flex-1');
      }

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'pv-icon-btn';
      rmBtn.title = 'remove parameter';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', () => {
        const i = params.indexOf(param);
        if (i >= 0) params.splice(i, 1);
        renderParamsList(params, container, onChange, cleanupsArr);
        onChange();
      });

      row.appendChild(nameInput);
      row.appendChild(flagInput);
      row.appendChild(typeSelect);
      row.appendChild(labelInput);
      row.appendChild(defaultField);
      row.appendChild(rmBtn);
      container.appendChild(row);
    });
  }

  // ── Agent Roles section (project-level Agent registry) ─────────────────
  //
  // Shows every Agent id referenced by a `type: 'agent'` parameter default
  // anywhere in this project's ADWs, cross-referenced against the real Agent
  // registry (list_agents), and lets you edit/create/delete the underlying
  // Agent record. Agent edits are a different backend resource than the
  // project (update_project only persists `adws`), so they save immediately
  // via update_agent/register_agent/delete_agent rather than through the
  // project's own dirty/save-banner flow.

  // Builds a debounced (~500ms) per-card save function that PATCHes the
  // Agent via update_agent, with a small inline status indicator.
  function makeAgentSaver(agent, statusEl) {
    let timer = null;
    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = 'pv-agent-save-status' + (cls ? ' ' + cls : '');
    }
    function saveNow() {
      timer = null;
      const params = (agent.parameters || [])
        .filter((p) => p.name && String(p.name).trim() && p.flag && String(p.flag).trim())
        .map(buildParamPayload);
      const payload = {
        id: agent.id,
        model: (agent.model || '').trim(),
        system_prompt: agent.system_prompt || '',
        parameters: params
      };
      setStatus('saving…');
      apiCallLocal('/api/v1/command', 'POST', { type: 'update_agent', payload })
        .then(() => setStatus('saved', 'pv-ok'))
        .catch((e) => setStatus(`error: ${(e && e.message) || e}`, 'pv-err'));
    }
    return function scheduleSave() {
      setStatus('editing…');
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveNow, 500);
    };
  }

  function collectReferencedAgentIds() {
    const ids = [];
    const seen = new Set();
    ((currentDraft && currentDraft.adws) || []).forEach((adw) => {
      (adw.parameters || []).forEach((p) => {
        if (!p || p.type !== 'agent') return;
        const id = (p.default != null ? String(p.default) : '').trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      });
    });
    return ids;
  }

  function renderConfiguredAgentCard(agent) {
    const card = document.createElement('div');
    card.className = 'pv-agent-card';
    card.dataset.agentId = agent.id;

    const header = document.createElement('div');
    header.className = 'pv-agent-card-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = agent.name;
    const statusEl = document.createElement('span');
    statusEl.className = 'pv-agent-save-status';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pv-icon-btn';
    delBtn.title = 'delete agent role';
    delBtn.textContent = '✕';
    header.appendChild(nameEl);
    header.appendChild(statusEl);
    header.appendChild(delBtn);
    card.appendChild(header);

    const scheduleSave = makeAgentSaver(agent, statusEl);

    const modelGroup = document.createElement('div');
    modelGroup.className = 'form-group';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'model';
    modelGroup.appendChild(modelLabel);
    const picker = createModelPicker(agent, scheduleSave);
    agentPickerCleanups.push(picker.cleanup);
    modelGroup.appendChild(picker.el);
    card.appendChild(modelGroup);

    const promptGroup = document.createElement('div');
    promptGroup.className = 'form-group';
    const promptLabel = document.createElement('label');
    promptLabel.textContent = 'system prompt';
    const promptTa = document.createElement('textarea');
    promptTa.className = 'form-input textarea';
    promptTa.placeholder = 'system prompt (optional)';
    promptTa.value = agent.system_prompt || '';
    promptTa.addEventListener('input', () => { agent.system_prompt = promptTa.value; scheduleSave(); });
    promptGroup.appendChild(promptLabel);
    promptGroup.appendChild(promptTa);
    card.appendChild(promptGroup);

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
    if (!agent.parameters) agent.parameters = [];
    renderParamsList(agent.parameters, paramsListEl, scheduleSave, agentPickerCleanups);
    addParamBtn.addEventListener('click', () => {
      agent.parameters.push({ name: '', flag: '', type: 'string' });
      renderParamsList(agent.parameters, paramsListEl, scheduleSave, agentPickerCleanups);
      scheduleSave();
    });
    card.appendChild(paramsSection);

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete agent role "${agent.name}"? Parameters referencing this id will show it as "not yet configured" again.`)) return;
      delBtn.disabled = true;
      try {
        await apiCallLocal('/api/v1/command', 'POST', { type: 'delete_agent', payload: { id: agent.id } });
        extraAgentIds = extraAgentIds.filter((id) => id !== agent.id);
        await ensureAgentsLoaded(true);
        await renderAgentsSection();
      } catch (e) {
        statusEl.textContent = `error: ${(e && e.message) || e}`;
        statusEl.className = 'pv-agent-save-status pv-err';
        delBtn.disabled = false;
      }
    });

    return card;
  }

  function renderUnconfiguredAgentCard(id) {
    const card = document.createElement('div');
    card.className = 'pv-agent-card pv-agent-card-unconfigured';
    card.dataset.agentId = id;

    const header = document.createElement('div');
    header.className = 'pv-agent-card-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = id;
    const tag = document.createElement('span');
    tag.className = 'pv-agent-tag';
    tag.textContent = 'not yet configured';
    header.appendChild(nameEl);
    header.appendChild(tag);
    card.appendChild(header);

    const footer = document.createElement('div');
    footer.className = 'pv-agent-card-footer';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn btn-secondary pv-small-btn';
    createBtn.textContent = 'Create Agent Role';
    const statusEl = document.createElement('span');
    statusEl.className = 'pv-agent-save-status';
    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      statusEl.textContent = 'creating…';
      try {
        // The referenced value already IS the id (it's a raw CLI flag
        // value, e.g. `--agent builder`) — no slugify/uniqueness pass
        // needed, unlike the free-text "+ new agent role" flow below.
        await apiCallLocal('/api/v1/command', 'POST', { type: 'register_agent', payload: { id, name: id } });
        await ensureAgentsLoaded(true);
        await renderAgentsSection();
      } catch (e) {
        statusEl.textContent = `error: ${(e && e.message) || e}`;
        statusEl.className = 'pv-agent-save-status pv-err';
        createBtn.disabled = false;
      }
    });
    footer.appendChild(createBtn);
    footer.appendChild(statusEl);
    card.appendChild(footer);

    return card;
  }

  function renderDraftAgentCard(draft) {
    const card = document.createElement('div');
    card.className = 'pv-agent-card pv-agent-card-draft';

    const header = document.createElement('div');
    header.className = 'pv-agent-card-header';
    const nameInput = mkTextInput(draft.name || '', 'agent role name', (v) => { draft.name = v; }, 'flex-1');
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pv-icon-btn';
    discardBtn.title = 'discard';
    discardBtn.textContent = '✕';
    discardBtn.addEventListener('click', () => {
      pendingAgentDrafts = pendingAgentDrafts.filter((d) => d !== draft);
      renderAgentsSection();
    });
    header.appendChild(nameInput);
    header.appendChild(discardBtn);
    card.appendChild(header);

    const footer = document.createElement('div');
    footer.className = 'pv-agent-card-footer';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn btn-secondary pv-small-btn';
    createBtn.textContent = 'Create Agent Role';
    const statusEl = document.createElement('span');
    statusEl.className = 'pv-agent-save-status';
    createBtn.addEventListener('click', async () => {
      const name = (draft.name || '').trim();
      if (!name) {
        statusEl.textContent = 'name required';
        statusEl.className = 'pv-agent-save-status pv-err';
        return;
      }
      createBtn.disabled = true;
      statusEl.textContent = 'creating…';
      statusEl.className = 'pv-agent-save-status';
      try {
        const id = uniqueAgentId(name);
        await apiCallLocal('/api/v1/command', 'POST', { type: 'register_agent', payload: { id, name } });
        pendingAgentDrafts = pendingAgentDrafts.filter((d) => d !== draft);
        extraAgentIds.push(id);
        await ensureAgentsLoaded(true);
        await renderAgentsSection();
      } catch (e) {
        statusEl.textContent = `error: ${(e && e.message) || e}`;
        statusEl.className = 'pv-agent-save-status pv-err';
        createBtn.disabled = false;
      }
    });
    footer.appendChild(createBtn);
    footer.appendChild(statusEl);
    card.appendChild(footer);

    return card;
  }

  // Renders the top "Agent Roles" section. The Agent registry is only
  // fetched when there's actually something to cross-reference (a
  // referenced id, an extra/just-created id, or a draft-in-progress) — a
  // project with no agent-type parameters yet costs nothing extra to open,
  // and "+ new agent role" / picking a parameter's type as "agent" both
  // trigger the fetch on demand from there.
  async function renderAgentsSection() {
    const listEl = document.getElementById('pv-agent-roles-list');
    if (!listEl) return;
    agentPickerCleanups.forEach((fn) => fn());
    agentPickerCleanups = [];

    const referenced = collectReferencedAgentIds();
    const needsRegistry = referenced.length > 0 || extraAgentIds.length > 0 || pendingAgentDrafts.length > 0;
    if (needsRegistry) await ensureAgentsLoaded();

    listEl.innerHTML = '';

    if (agentsError && needsRegistry) {
      const note = document.createElement('div');
      note.className = 'pv-agent-registry-note';
      note.textContent = `agent registry unavailable — showing ids only (${agentsError})`;
      listEl.appendChild(note);
    }

    const allIds = [];
    const seen = new Set();
    referenced.concat(extraAgentIds).forEach((id) => {
      if (!seen.has(id)) {
        seen.add(id);
        allIds.push(id);
      }
    });

    if (allIds.length === 0 && pendingAgentDrafts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = "no agent roles referenced yet — give a workflow parameter type \"agent\", or create one below.";
      listEl.appendChild(empty);
    }

    allIds.forEach((id) => {
      const agent = findAgentById(id);
      listEl.appendChild(agent ? renderConfiguredAgentCard(agent) : renderUnconfiguredAgentCard(id));
    });

    pendingAgentDrafts.forEach((draft) => {
      listEl.appendChild(renderDraftAgentCard(draft));
    });
  }

  // ── Diagram view (workflow-diagram.js) ──────────────────────────────
  //
  // A clickable UML-style box-and-line view of currentDraft.adws, rendered
  // by the standalone WorkflowDiagram module. It's purely a renderer — all
  // it does is call back into this file, which owns navigation (jump to
  // and expand the matching list-view card) and creation (add a workflow /
  // agent draft exactly like the "+" buttons already do).

  let activeAdwView = 'list';

  function switchAdwView(view) {
    activeAdwView = view;
    const listEl = document.getElementById('pv-adw-list');
    const diagEl = document.getElementById('pv-adw-diagram');
    if (listEl) listEl.classList.toggle('hidden', view !== 'list');
    if (diagEl) diagEl.classList.toggle('hidden', view !== 'diagram');
    document.querySelectorAll('#pv-adw-view-toggle .pv-view-toggle-btn').forEach((btn) => {
      btn.classList.toggle('pv-active', btn.dataset.view === view);
    });
    if (view === 'diagram') renderDiagram();
  }

  function renderDiagram() {
    const diagEl = document.getElementById('pv-adw-diagram');
    if (!diagEl) return;
    if (!window.WorkflowDiagram) {
      diagEl.textContent = 'diagram view unavailable (workflow-diagram.js failed to load).';
      return;
    }
    window.WorkflowDiagram.render(diagEl, currentDraft, {
      onSelectAdw: (adwId) => { switchAdwView('list'); focusAdwCardById(adwId); },
      onSelectAgent: (id) => { focusAgentCardById(id); },
      onAddWorkflow: () => addNewWorkflow(),
      onAddAgent: () => addNewAgentDraft()
    });
  }

  function flashCard(card) {
    if (!card) return;
    card.classList.add('pv-flash');
    setTimeout(() => card.classList.remove('pv-flash'), 1200);
  }

  function focusAdwCardById(adwId) {
    const listEl = document.getElementById('pv-adw-list');
    if (!listEl) return;
    const card = Array.from(listEl.querySelectorAll('.pv-adw-card')).find((c) => c.dataset.adwId === adwId);
    if (!card) return;
    card.classList.add('pv-expanded');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    flashCard(card);
  }

  function focusAgentCardById(id) {
    const listEl = document.getElementById('pv-agent-roles-list');
    if (!listEl) return;
    const card = Array.from(listEl.querySelectorAll('.pv-agent-card')).find((c) => c.dataset.agentId === id);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    flashCard(card);
  }

  // Shared by the "+ add workflow" button and the diagram's "+ new workflow"
  // node — always lands the user on the (editable) list view, expanded to
  // the new card, regardless of which view they triggered it from.
  function addNewWorkflow() {
    if (!currentDraft) return;
    if (!currentDraft.adws) currentDraft.adws = [];
    currentDraft.adws.push({ id: '', path: '', name: '', parameters: [] });
    markDirty();
    switchAdwView('list');
    renderAdwList();
    const listEl = document.getElementById('pv-adw-list');
    const cards = listEl ? listEl.querySelectorAll('.pv-adw-card') : [];
    const last = cards[cards.length - 1];
    if (last) {
      last.classList.add('pv-expanded');
      last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Shared by the "+ new agent role" button and the diagram's "+ new agent
  // role" node. The Agent Roles section is always visible (not view-toggled)
  // so this just adds the draft card and scrolls to it.
  function addNewAgentDraft() {
    pendingAgentDrafts.push({ name: '' });
    renderAgentsSection().then(() => {
      const listEl = document.getElementById('pv-agent-roles-list');
      const drafts = listEl ? listEl.querySelectorAll('.pv-agent-card-draft') : [];
      const last = drafts[drafts.length - 1];
      if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // ── ADW card ─────────────────────────────────────────────────────────

  function renderAdwCard(adw) {
    const originalId = adw.id;
    const card = document.createElement('div');
    card.className = 'pv-adw-card';
    card.dataset.adwId = adw.id || '';

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
      card.dataset.adwId = v;
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

    // parameters — agent selection lives here too, as a `type: 'agent'` row
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
    renderParamsList(adw.parameters, paramsListEl, markDirty, pickerCleanups);
    addParamBtn.addEventListener('click', () => {
      adw.parameters.push({ name: '', flag: '', type: 'string' });
      renderParamsList(adw.parameters, paramsListEl, markDirty, pickerCleanups);
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
        // 'string' and 'agent' both carry a plain string default.
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
    agentPickerCleanups.forEach((fn) => fn());
    agentPickerCleanups = [];
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
            <div id="pv-agents-section">
              <div class="pv-section-header">
                <h4>agent roles</h4>
                <button type="button" class="btn btn-secondary pv-small-btn" id="pv-add-agent-btn">+ new agent role</button>
              </div>
              <div class="pv-agent-roles-list" id="pv-agent-roles-list"></div>
            </div>
            <hr class="modal-divider" />
            <div class="pv-section-header">
              <h4>workflows (adws)</h4>
              <div class="pv-view-toggle" id="pv-adw-view-toggle">
                <button type="button" class="pv-view-toggle-btn pv-active" data-view="list">list</button>
                <button type="button" class="pv-view-toggle-btn" data-view="diagram">diagram</button>
              </div>
              <button type="button" class="btn btn-secondary pv-small-btn" id="pv-add-adw-btn">+ add workflow</button>
            </div>
            <div class="pv-adw-list" id="pv-adw-list"></div>
            <div class="pv-adw-diagram hidden" id="pv-adw-diagram"></div>
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
    if (addBtn) addBtn.addEventListener('click', addNewWorkflow);

    const addAgentRoleBtn = document.getElementById('pv-add-agent-btn');
    if (addAgentRoleBtn) addAgentRoleBtn.addEventListener('click', addNewAgentDraft);

    const viewToggle = document.getElementById('pv-adw-view-toggle');
    if (viewToggle) {
      viewToggle.querySelectorAll('.pv-view-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchAdwView(btn.dataset.view));
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
    extraAgentIds = [];
    pendingAgentDrafts = [];
    switchAdwView('list');
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
      const agentsListEl = document.getElementById('pv-agent-roles-list');
      if (agentsListEl) agentsListEl.innerHTML = '';
      currentDraft = { id: projectId, adws: [] };
      modal.classList.remove('hidden');
      return;
    }

    currentDraft = JSON.parse(JSON.stringify(proj));
    if (!currentDraft.adws) currentDraft.adws = [];
    dirty = false;

    renderMeta(currentDraft);
    renderAdwList();
    await renderAgentsSection();
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

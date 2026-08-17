// AgenticBoard — Project View / Workflow (ADW) Editor
//
// Standalone module: builds its own modal (#modal-project-view), injects it
// into the DOM on first use, and edits a project's `adws[]` (id/name/path/
// model/parameters) with a searchable model picker fed by GET /api/v1/models.
// Nothing is persisted until "save changes", which sends the whole adws array
// via the generic /api/v1/command endpoint (update_project).
//
// Agent selection is just another ADW parameter: a parameter with
// `type: 'agent'` means its `default` is an agent name from the project's own
// `adws/adw_sssf_config/sssf.config.yaml` roster (SSSF's own `--agent`
// CLI-flag convention — e.g. a real `adw_prompt.py`'s `agent` parameter).
// There is deliberately no board-owned "Agent" concept here: the "agent
// roles" section reads and writes that real file (GET/PUT
// /api/v1/projects/:id/sssf-config), and each agent's system.md/user.md
// prompt files and each workflow's own script file are edited in place via
// the generic project-file endpoint (GET/PUT /api/v1/projects/:id/file).
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

  // sssf.config.yaml roster for the currently-open project. Unlike models
  // (workspace-wide, heavy, lazily fetched), this is small and scoped to the
  // project already being opened, so it's fetched eagerly alongside the ADW
  // list rather than on first picker focus.
  let sssfDefaults = null;
  let agentsDraft = [];
  let agentsAvailable = false;
  let agentsLoadError = null;
  let agentsDirty = false;
  let newAgentDraft = null; // { name } while the "+ new agent role" inline form is open
  let agentPickerCleanups = [];

  const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

  // ── generic project-file editor (workflow scripts, agent prompt files) ──
  //
  // A collapsible "show <label>" toggle that lazily fetches a text file's
  // content on first expand and lets it be edited/saved independently of
  // everything else on the page — a different backend resource (a real file
  // on disk) than either update_project or the sssf-config roster PUT.
  // `getPath` is a function, not a string, so the file this points at always
  // reflects the owning object's *current* value (e.g. adw.path after the
  // user edits it) rather than whatever it was when the card was built.

  function createFileEditor(getPath, label) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-file-editor';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary pv-small-btn';
    toggleBtn.textContent = `show ${label}`;
    wrap.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.className = 'pv-file-editor-body hidden';
    wrap.appendChild(body);

    const ta = document.createElement('textarea');
    ta.className = 'form-input textarea pv-file-editor-textarea';
    ta.spellcheck = false;
    body.appendChild(ta);

    const footer = document.createElement('div');
    footer.className = 'pv-file-editor-footer';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary pv-small-btn';
    saveBtn.textContent = `save ${label}`;
    const statusEl = document.createElement('span');
    statusEl.className = 'pv-agent-save-status';
    footer.appendChild(saveBtn);
    footer.appendChild(statusEl);
    body.appendChild(footer);

    let loaded = false;
    let original = '';

    async function load() {
      const relPath = getPath();
      if (!relPath) {
        statusEl.textContent = 'no path set yet';
        statusEl.className = 'pv-agent-save-status pv-err';
        return;
      }
      statusEl.textContent = 'loading…';
      statusEl.className = 'pv-agent-save-status';
      ta.disabled = true;
      try {
        const data = await apiCallLocal(`/api/v1/projects/${encodeURIComponent(currentProjectId)}/file?path=${encodeURIComponent(relPath)}`);
        original = data && data.content != null ? data.content : '';
        ta.value = original;
        statusEl.textContent = data && data.exists === false ? 'file does not exist yet — saving will create it' : '';
      } catch (e) {
        statusEl.textContent = `error: ${(e && e.message) || e}`;
        statusEl.className = 'pv-agent-save-status pv-err';
      } finally {
        ta.disabled = false;
      }
    }

    toggleBtn.addEventListener('click', async () => {
      const willShow = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      toggleBtn.textContent = willShow ? `hide ${label}` : `show ${label}`;
      if (willShow && !loaded) {
        loaded = true;
        await load();
      }
    });

    ta.addEventListener('input', () => {
      if (statusEl.className.indexOf('pv-err') === -1) {
        statusEl.textContent = ta.value !== original ? 'unsaved changes' : '';
        statusEl.className = 'pv-agent-save-status';
      }
    });

    saveBtn.addEventListener('click', async () => {
      const relPath = getPath();
      if (!relPath) {
        statusEl.textContent = 'no path set yet';
        statusEl.className = 'pv-agent-save-status pv-err';
        return;
      }
      saveBtn.disabled = true;
      statusEl.textContent = 'saving…';
      statusEl.className = 'pv-agent-save-status';
      try {
        await apiCallLocal(`/api/v1/projects/${encodeURIComponent(currentProjectId)}/file`, 'PUT', { path: relPath, content: ta.value });
        original = ta.value;
        statusEl.textContent = 'saved';
        statusEl.className = 'pv-agent-save-status pv-ok';
      } catch (e) {
        statusEl.textContent = `error: ${(e && e.message) || e}`;
        statusEl.className = 'pv-agent-save-status pv-err';
      } finally {
        saveBtn.disabled = false;
      }
    });

    return wrap;
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

  function createModelPicker(obj, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-model-picker';

    const selectedRow = document.createElement('div');
    selectedRow.className = 'pv-model-picker-selected';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.placeholder = 'search or type a model...';
    input.value = obj.model || '';
    input.autocomplete = 'off';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pv-model-clear-btn';
    clearBtn.title = 'clear model';
    clearBtn.textContent = '✕';
    clearBtn.style.display = obj.model ? '' : 'none';

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
      obj.model = value || undefined;
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
      obj.model = input.value.trim() || undefined;
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

  // ── agent-typed parameter default picker (sourced from agentsDraft) ────
  //
  // agentsDraft is this project's real sssf.config.yaml roster, already
  // loaded eagerly when the modal opened (see loadSssfConfig) — no separate
  // lazy fetch needed here, unlike the model picker.

  function filterAgentsDraft(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return agentsDraft;
    return agentsDraft.filter((a) => (a.name || '').toLowerCase().includes(q));
  }

  const AGENT_RESULT_CAP = 50;

  function createAgentDefaultPicker(param, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-agent-name-picker flex-1';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.placeholder = 'agent name';
    input.autocomplete = 'off';
    input.value = param.default !== undefined ? String(param.default) : '';
    wrap.appendChild(input);

    const dropdown = document.createElement('div');
    dropdown.className = 'pv-agent-dropdown hidden';
    wrap.appendChild(dropdown);

    function commit(name) {
      if (name) param.default = name; else delete param.default;
      input.value = name || '';
      onChange();
    }

    function renderDropdown() {
      dropdown.innerHTML = '';
      if (!agentsAvailable) {
        const note = document.createElement('div');
        note.className = 'pv-agent-dropdown-note';
        note.textContent = agentsLoadError
          ? `agent roster unavailable — type a name manually (${agentsLoadError})`
          : 'no sssf.config.yaml for this project — type a name manually';
        dropdown.appendChild(note);
      }
      const matches = filterAgentsDraft(input.value);
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pv-agent-dropdown-empty';
        empty.textContent = (agentsDraft.length) ? 'no matches' : 'roster is empty — type a new name';
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
        if (a.purpose) {
          const purposeSpan = document.createElement('span');
          purposeSpan.className = 'pv-agent-option-id';
          purposeSpan.textContent = a.purpose;
          opt.appendChild(purposeSpan);
        }
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(a.name);
          hideDropdown();
        });
        dropdown.appendChild(opt);
      });
    }

    function hideDropdown() {
      dropdown.classList.add('hidden');
    }

    input.addEventListener('focus', () => {
      dropdown.classList.remove('hidden');
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

  // ── parameters editor (ADW's own parameters[]) ──────────────────────

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

  // ── Agent Roles section (real sssf.config.yaml roster) ─────────────────

  async function loadSssfConfig() {
    sssfDefaults = null;
    agentsDraft = [];
    agentsAvailable = false;
    agentsLoadError = null;
    try {
      // apiCallLocal()/apiCall() unwrap straight to `.data`, discarding the
      // `.error` string the server attaches alongside `data: null` on the
      // graceful "not stamped with SSSF" path — read the raw envelope here
      // so that message actually reaches the UI instead of being swallowed.
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(currentProjectId)}/sssf-config`);
      const envelope = await res.json().catch(() => null);
      if (!res.ok || !envelope || envelope.success === false) {
        agentsLoadError = (envelope && envelope.error) || `HTTP error ${res.status}`;
        return;
      }
      const data = envelope.data;
      if (!data) {
        agentsAvailable = false;
        agentsLoadError = envelope.error || null;
        return;
      }
      sssfDefaults = data.defaults || {};
      agentsDraft = Array.isArray(data.agents) ? JSON.parse(JSON.stringify(data.agents)) : [];
      agentsAvailable = true;
    } catch (e) {
      agentsLoadError = (e && e.message) || 'failed to reach the project file API';
    }
  }

  function collectReferencedAgentNames() {
    const names = [];
    const seen = new Set();
    ((currentDraft && currentDraft.adws) || []).forEach((adw) => {
      (adw.parameters || []).forEach((p) => {
        if (!p || p.type !== 'agent') return;
        const name = (p.default != null ? String(p.default) : '').trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      });
    });
    return names;
  }

  function markAgentsDirty() {
    agentsDirty = true;
    const banner = document.getElementById('pv-agents-save-banner');
    if (banner) banner.innerHTML = '';
  }

  function showAgentsBanner(msg, ok) {
    const banner = document.getElementById('pv-agents-save-banner');
    if (!banner) return;
    banner.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'pv-save-banner ' + (ok ? 'pv-ok' : 'pv-err');
    el.textContent = msg;
    banner.appendChild(el);
  }

  function renderToolsList(items, cls) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-agent-badge-list';
    (items || []).forEach((t) => {
      const b = document.createElement('span');
      b.className = 'tag-badge ' + (cls || 'tag-agent');
      b.textContent = t;
      wrap.appendChild(b);
    });
    if (!items || items.length === 0) {
      const none = document.createElement('span');
      none.className = 'pv-agent-badge-none';
      none.textContent = '(none)';
      wrap.appendChild(none);
    }
    return wrap;
  }

  function renderAgentCard(agent) {
    const card = document.createElement('div');
    card.className = 'pv-agent-card';
    card.dataset.agentId = agent.name;

    const header = document.createElement('div');
    header.className = 'pv-agent-card-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = agent.name;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'pv-icon-btn';
    delBtn.title = 'remove from roster';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      if (!confirm(`Remove "${agent.name}" from the agent roster? This isn't written to sssf.config.yaml until you click "save agent roster".`)) return;
      const i = agentsDraft.indexOf(agent);
      if (i >= 0) agentsDraft.splice(i, 1);
      markAgentsDirty();
      renderAgentsSection();
    });
    header.appendChild(nameEl);
    header.appendChild(delBtn);
    card.appendChild(header);

    const purposeInput = mkTextInput(agent.purpose || '', 'purpose (one sentence)', (v) => {
      if (v) agent.purpose = v; else delete agent.purpose;
      markAgentsDirty();
    });
    card.appendChild(mkFormGroup('purpose', purposeInput));

    const row = document.createElement('div');
    row.className = 'form-row';

    const modelGroup = document.createElement('div');
    modelGroup.className = 'form-group flex-1';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = sssfDefaults && sssfDefaults.model ? `model (default: ${sssfDefaults.model})` : 'model';
    modelGroup.appendChild(modelLabel);
    const picker = createModelPicker(agent, markAgentsDirty);
    agentPickerCleanups.push(picker.cleanup);
    modelGroup.appendChild(picker.el);
    row.appendChild(modelGroup);

    const thinkingSelect = document.createElement('select');
    thinkingSelect.className = 'form-input';
    THINKING_LEVELS.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t || '(default' + (sssfDefaults && sssfDefaults.thinking ? `: ${sssfDefaults.thinking}` : '') + ')';
      if ((agent.thinking || '') === t) opt.selected = true;
      thinkingSelect.appendChild(opt);
    });
    thinkingSelect.addEventListener('change', () => {
      if (thinkingSelect.value) agent.thinking = thinkingSelect.value; else delete agent.thinking;
      markAgentsDirty();
    });
    row.appendChild(mkFormGroup('thinking', thinkingSelect, 'flex-1'));

    const colorRow = document.createElement('div');
    colorRow.className = 'pv-agent-color-row';
    const colorInput = mkTextInput(agent.color || '', '#hex (optional)', (v) => {
      if (v) agent.color = v; else delete agent.color;
      swatch.style.background = v || 'transparent';
      markAgentsDirty();
    }, 'flex-1');
    const swatch = document.createElement('span');
    swatch.className = 'pv-agent-color-swatch';
    swatch.style.background = agent.color || 'transparent';
    colorRow.appendChild(swatch);
    colorRow.appendChild(colorInput);
    row.appendChild(mkFormGroup('color', colorRow, 'flex-1'));

    card.appendChild(row);

    const toolsRow = document.createElement('div');
    toolsRow.className = 'form-row';
    toolsRow.appendChild(mkFormGroup('tools', renderToolsList(agent.tools), 'flex-1'));
    toolsRow.appendChild(mkFormGroup('writes', renderToolsList(agent.writes, 'tag-badge'), 'flex-1'));
    card.appendChild(toolsRow);
    const toolsNote = document.createElement('div');
    toolsNote.className = 'pv-agent-readonly-note';
    toolsNote.textContent = 'tools / writes / harness_engineering are read-only here — edit sssf.config.yaml directly for those.';
    card.appendChild(toolsNote);

    const promptsRow = document.createElement('div');
    promptsRow.className = 'pv-agent-prompts-row';
    const sysPath = agent.prompt_engineering && agent.prompt_engineering.system;
    const usrPath = agent.prompt_engineering && agent.prompt_engineering.user;
    promptsRow.appendChild(createFileEditor(() => sysPath, 'system prompt'));
    promptsRow.appendChild(createFileEditor(() => usrPath, 'user prompt'));
    card.appendChild(promptsRow);

    return card;
  }

  function renderUnregisteredAgentRow(name) {
    const row = document.createElement('div');
    row.className = 'pv-agent-unregistered-row';
    const label = document.createElement('span');
    label.textContent = name;
    const tag = document.createElement('span');
    tag.className = 'pv-agent-tag';
    tag.textContent = 'referenced, not in roster';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary pv-small-btn';
    addBtn.textContent = '+ add to roster';
    addBtn.addEventListener('click', () => {
      agentsDraft.push({ name, purpose: '' });
      markAgentsDirty();
      renderAgentsSection();
    });
    row.appendChild(label);
    row.appendChild(tag);
    row.appendChild(addBtn);
    return row;
  }

  function renderNewAgentDraftRow() {
    const row = document.createElement('div');
    row.className = 'pv-agent-card pv-agent-card-draft';
    const header = document.createElement('div');
    header.className = 'pv-agent-card-header';
    const nameInput = mkTextInput(newAgentDraft.name || '', 'agent name', (v) => { newAgentDraft.name = v; });
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pv-icon-btn';
    discardBtn.title = 'discard';
    discardBtn.textContent = '✕';
    discardBtn.addEventListener('click', () => {
      newAgentDraft = null;
      renderAgentsSection();
    });
    header.appendChild(nameInput);
    header.appendChild(discardBtn);
    row.appendChild(header);

    const footer = document.createElement('div');
    footer.className = 'pv-agent-card-footer';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary pv-small-btn';
    addBtn.textContent = 'Add to Roster';
    const statusEl = document.createElement('span');
    statusEl.className = 'pv-agent-save-status';
    addBtn.addEventListener('click', () => {
      const name = (newAgentDraft.name || '').trim();
      if (!name) {
        statusEl.textContent = 'name required';
        statusEl.className = 'pv-agent-save-status pv-err';
        return;
      }
      if (agentsDraft.some((a) => a.name === name)) {
        statusEl.textContent = 'an agent with this name already exists';
        statusEl.className = 'pv-agent-save-status pv-err';
        return;
      }
      agentsDraft.push({ name, purpose: '' });
      newAgentDraft = null;
      markAgentsDirty();
      renderAgentsSection();
    });
    footer.appendChild(addBtn);
    footer.appendChild(statusEl);
    row.appendChild(footer);
    return row;
  }

  async function handleSaveAgentsRoster() {
    const banner = document.getElementById('pv-agents-save-banner');
    if (banner) banner.innerHTML = '';

    const seen = new Set();
    for (const a of agentsDraft) {
      const name = (a.name || '').trim();
      if (!name) {
        showAgentsBanner('every agent needs a non-empty name.', false);
        return;
      }
      if (seen.has(name)) {
        showAgentsBanner(`duplicate agent name "${name}" — names must be unique.`, false);
        return;
      }
      seen.add(name);
    }

    const saveBtn = document.getElementById('pv-agents-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await apiCallLocal(`/api/v1/projects/${encodeURIComponent(currentProjectId)}/sssf-config`, 'PUT', { agents: agentsDraft });
      agentsDirty = false;
      showAgentsBanner('saved.', true);
      await loadSssfConfig();
      renderAgentsSection();
    } catch (err) {
      showAgentsBanner(`save failed: ${(err && err.message) || err}`, false);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function renderAgentsSection() {
    const listEl = document.getElementById('pv-agent-roles-list');
    if (!listEl) return;
    agentPickerCleanups.forEach((fn) => fn());
    agentPickerCleanups = [];
    listEl.innerHTML = '';

    const saveRow = document.getElementById('pv-agents-save-row');
    const addBtn = document.getElementById('pv-add-agent-btn');

    if (!agentsAvailable) {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = agentsLoadError
        ? `agent roster unavailable — ${agentsLoadError}`
        : "no adws/adw_sssf_config/sssf.config.yaml found for this project — agent roles can't be edited until SSSF is set up.";
      listEl.appendChild(empty);
      if (saveRow) saveRow.classList.add('hidden');
      if (addBtn) addBtn.classList.add('hidden');
      return;
    }
    if (saveRow) saveRow.classList.remove('hidden');
    if (addBtn) addBtn.classList.remove('hidden');

    const referenced = collectReferencedAgentNames();
    const rosterNames = new Set(agentsDraft.map((a) => a.name));
    const unregistered = referenced.filter((n) => !rosterNames.has(n));
    unregistered.forEach((name) => listEl.appendChild(renderUnregisteredAgentRow(name)));

    if (agentsDraft.length === 0 && !newAgentDraft && unregistered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = 'no agents in the roster yet.';
      listEl.appendChild(empty);
    }

    agentsDraft.forEach((agent) => listEl.appendChild(renderAgentCard(agent)));
    if (newAgentDraft) listEl.appendChild(renderNewAgentDraftRow());
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
      onSelectAgent: (name) => { focusAgentCardById(name); },
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

  function focusAgentCardById(name) {
    const listEl = document.getElementById('pv-agent-roles-list');
    if (!listEl) return;
    const card = Array.from(listEl.querySelectorAll('.pv-agent-card')).find((c) => c.dataset.agentId === name);
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
  // role" node.
  function addNewAgentDraft() {
    if (!agentsAvailable) return;
    newAgentDraft = { name: '' };
    renderAgentsSection();
    const listEl = document.getElementById('pv-agent-roles-list');
    const draft = listEl ? listEl.querySelector('.pv-agent-card-draft') : null;
    if (draft) draft.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    body.appendChild(createFileEditor(() => adw.path, 'script'));

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
                <h4>agent roles (sssf.config.yaml)</h4>
                <button type="button" class="btn btn-secondary pv-small-btn hidden" id="pv-add-agent-btn">+ new agent role</button>
              </div>
              <div class="pv-agent-roles-list" id="pv-agent-roles-list"></div>
              <div id="pv-agents-save-banner"></div>
              <div class="pv-agents-save-row hidden" id="pv-agents-save-row">
                <div class="flex-spacer"></div>
                <button type="button" class="btn btn-primary pv-small-btn" id="pv-agents-save-btn">save agent roster</button>
              </div>
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

    const agentsSaveBtn = document.getElementById('pv-agents-save-btn');
    if (agentsSaveBtn) agentsSaveBtn.addEventListener('click', handleSaveAgentsRoster);

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
    newAgentDraft = null;
    agentsDirty = false;
    switchAdwView('list');
    const banner = document.getElementById('pv-save-banner');
    if (banner) banner.innerHTML = '';
    const agentsBanner = document.getElementById('pv-agents-save-banner');
    if (agentsBanner) agentsBanner.innerHTML = '';

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
    await loadSssfConfig();
    renderAgentsSection();
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

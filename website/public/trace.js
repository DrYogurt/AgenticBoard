// AgenticBoard — Full ADW Trace View (gantt waterfall + phase detail)
//
// Ported from super-simple-software-factory's visualizer
// (super-simple-software-factory/.claude/skills/sssf/apps/visualizer/src/),
// re-themed to Catppuccin Mocha and rewritten as vanilla JS/DOM against
// AgenticBoard's own /api/v1/tasks/:id/trace* endpoints. A task's adw_id is
// its own task id, so every fetch here is scoped by taskId directly.
//
// Public API: AgenticTrace.open(taskId, title), AgenticTrace.close()

const AgenticTrace = (() => {
  // ── time / number formatting ────────────────────────────────────────────
  function ts(iso) {
    if (!iso) return NaN;
    return new Date(iso).getTime();
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function fmtClock(iso) {
    const t = ts(iso);
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleTimeString([], { hour12: false });
  }

  function fmtDate(iso) {
    const t = ts(iso);
    if (!Number.isFinite(t)) return '—';
    const d = new Date(t);
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(iso)}`;
  }

  function fmtTokens(n) {
    if (n == null) return '—';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  function fmtCost(n) {
    if (n == null) return '—';
    return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
  }

  function money(n) {
    if (!n) return '$0';
    return n < 0.0001 ? '<$0.0001' : `$${n.toFixed(4)}`;
  }

  function fmtOffset(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) {
      const rem = s % 60;
      return rem ? `${m}m${String(rem).padStart(2, '0')}s` : `${m}m`;
    }
    const h = Math.floor(m / 60);
    const mrem = m % 60;
    return mrem ? `${h}h${String(mrem).padStart(2, '0')}m` : `${h}h`;
  }

  const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map((s) => s * 1000);

  function axisTicks(spanMs, maxTicks) {
    const span = Math.max(spanMs, 1);
    const step = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? 3_600_000;
    const out = [];
    for (let t = 0; t <= span; t += step) {
      out.push({ pct: (t / span) * 100, label: fmtOffset(t) });
    }
    return out;
  }

  function payloadOk(raw) {
    if (!raw) return true;
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && 'ok' in p) return p.ok !== false;
    } catch {
      /* not JSON — treat as ok */
    }
    return true;
  }

  const NUM = new Intl.NumberFormat('en-US');

  // ── event / agent color helpers ─────────────────────────────────────────
  const EVENT_DOT_COLORS = {
    agent_start: '#c89bff',
    tool_call: '#5ad2dd',
    handoff: '#94a3ff',
    agent_end: '#4ade80',
    error: '#ff6f67',
    gate_fail: '#ff6f67'
  };

  const AGENT_FALLBACK_COLORS = ['#c89bff', '#5ad2dd', '#94a3ff', '#e8b64a', '#f2a2c4'];

  function agentColor(configColor, payloadColor, index) {
    return configColor || payloadColor || AGENT_FALLBACK_COLORS[index % AGENT_FALLBACK_COLORS.length] || '#c89bff';
  }

  function hexAlpha(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return 'transparent';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
  }

  function parsePayload(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* legacy or truncated payloads render raw */
    }
    return null;
  }

  function parseToolCall(e) {
    const payload = parsePayload(e.payload_json);
    if (!payload || typeof payload.tool !== 'string') return null;
    return payload;
  }

  function parseAgentStart(e) {
    return parsePayload(e.payload_json);
  }

  const ARG_LABEL_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description'];
  const LABEL_MAX = 160;

  function oneLine(value) {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX)}…` : flat;
  }

  function argsSummary(args) {
    if (!args) return '';
    for (const key of ARG_LABEL_KEYS) {
      const v = args[key];
      if (typeof v === 'string' && v.trim() !== '') return oneLine(v);
    }
    const parts = [];
    for (const [key, v] of Object.entries(args)) {
      if (v == null) continue;
      parts.push(`${key}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    return oneLine(parts.join(' '));
  }

  function eventLabel(e) {
    if (e.type === 'tool_call') {
      const call = parseToolCall(e);
      if (call && call.tool) {
        if (e.name && e.name.startsWith(call.tool)) return oneLine(e.name);
        const summary = argsSummary(call.args);
        return summary ? `${call.tool}: ${summary}` : call.tool;
      }
      const legacy = parsePayload(e.payload_json);
      if (legacy && typeof legacy.pi_event === 'string') return `${e.name ?? 'tool'} ${legacy.pi_event}`;
    }
    return e.name ?? e.type ?? '';
  }

  // ── model icon helpers ───────────────────────────────────────────────────
  const MODEL_ICONS = [
    [['claude', 'opus', 'sonnet', 'haiku'], 'models/claude.png'],
    [['gemini'], 'models/gemini.png'],
    [['kimi', 'moonshot'], 'models/kimi.png'],
    [['gpt', 'openai', 'codex', 'o3', 'o4'], 'models/openai.png'],
    [['glm', 'zai', 'z.ai'], 'models/zai.png']
  ];

  function modelIcon(model) {
    if (!model) return null;
    const m = model.toLowerCase();
    for (const [needles, icon] of MODEL_ICONS) {
      if (needles.some((n) => m.includes(n))) return icon;
    }
    return null;
  }

  function modelName(model) {
    if (!model) return '';
    const parts = model.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : model;
  }

  // ── JSON syntax highlighting (dependency-free; escapes everything) ───────
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

  function highlightJsonText(text) {
    let out = '';
    let last = 0;
    let m;
    JSON_TOKEN.lastIndex = 0;
    while ((m = JSON_TOKEN.exec(text))) {
      out += escHtml(text.slice(last, m.index));
      const full = m[0];
      const [, str, colon, bool, nil, num] = m;
      if (str !== undefined) {
        const cls = colon !== undefined ? 'j-key' : 'j-str';
        out += `<span class="${cls}">${escHtml(str)}</span>${escHtml(colon ?? '')}`;
      } else if (bool !== undefined) {
        out += `<span class="j-bool">${bool}</span>`;
      } else if (nil !== undefined) {
        out += `<span class="j-null">null</span>`;
      } else {
        out += `<span class="j-num">${escHtml(num ?? full)}</span>`;
      }
      last = m.index + full.length;
    }
    out += escHtml(text.slice(last));
    return out;
  }

  function highlightJson(raw) {
    if (!raw) return '';
    try {
      return highlightJsonText(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      return escHtml(raw);
    }
  }

  // ── status / stat chips ───────────────────────────────────────────────────
  const STATUS_ICON = { success: '✓', fail: '✕', running: '↻', queued: '○' };

  function statusChipHtml(status) {
    const s = status || 'queued';
    return `<span class="tr-chip tr-status-${escHtml(s)}"><span class="tr-chip-icon">${STATUS_ICON[s] ?? '○'}</span>${escHtml(s)}</span>`;
  }

  const STAT_TITLES = {
    cost: 'Cost — dollars billed for this run, all agents combined.',
    tokens: 'Tokens exchanged (billed) — everything sent or generated, counted once per turn.',
    runtime: 'Duration — wall-clock from the first phase starting to the last one ending.',
    read: 'Read — raw tokens the models took in, counted the first time they enter the context.',
    written: 'Written — tokens the models actually generated.'
  };

  function statChipHtml(kind, value, compact) {
    let text;
    if (kind === 'cost') text = fmtCost(value);
    else if (kind === 'runtime') text = fmtDuration(value);
    else text = fmtTokens(value);
    return `<span class="tr-stat${compact ? ' tr-stat-compact' : ''}" title="${escHtml(STAT_TITLES[kind] || '')}">${escHtml(text)}</span>`;
  }

  // ── state ──────────────────────────────────────────────────────────────────
  let state = null;
  let dom = null;

  function resetState(taskId) {
    state = {
      taskId,
      session: null,
      phases: [],
      agents: [],
      usage: { read: 0, written: 0 },
      events: [],
      envelopes: [],
      gates: [],
      cursor: 0,
      loaded: false,
      error: null,
      selectedPhaseId: null,
      openSections: new Set(),
      openGates: new Set(),
      expandedEvents: new Set(),
      promptCache: new Map(),
      promptsState: 'idle',
      prompts: null,
      timer: null,
      inflight: false
    };
  }

  const SIDE_TABLE_TYPES = new Set(['gate_pass', 'gate_fail', 'handoff', 'agent_end', 'phase_end', 'error']);

  async function tick() {
    if (!state || state.inflight) return;
    state.inflight = true;
    try {
      const detail = await apiCall(`/api/v1/tasks/${state.taskId}/trace`);
      state.session = detail.session;
      state.phases = (detail.phases || []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      state.agents = detail.agents || [];
      state.usage = detail.usage || { read: 0, written: 0 };

      let page;
      const fresh = [];
      do {
        page = await apiCall(`/api/v1/tasks/${state.taskId}/trace/events?after=${state.cursor}&limit=1000`);
        state.cursor = Math.max(state.cursor, page.cursor);
        fresh.push(...page.events);
      } while (page.has_more);
      if (fresh.length) state.events = state.events.concat(fresh);

      if (!state.loaded || fresh.some((e) => e.type && SIDE_TABLE_TYPES.has(e.type))) {
        const [env, g] = await Promise.all([
          apiCall(`/api/v1/tasks/${state.taskId}/trace/envelopes`),
          apiCall(`/api/v1/tasks/${state.taskId}/trace/gates`)
        ]);
        state.envelopes = env;
        state.gates = g;
      }
      state.loaded = true;
      state.error = null;
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
    } finally {
      state.inflight = false;
      if (state.selectedPhaseId) void loadPromptsIfNeeded();
      render();
    }
  }

  // ── lanes ──────────────────────────────────────────────────────────────
  function computeOwnerStart() {
    const ownerByPhase = new Map(state.phases.map((p) => [p.phase_id, p.owner]));
    const meta = {};
    for (const e of state.events) {
      if (e.type !== 'agent_start') continue;
      const owner = (e.phase_id ? ownerByPhase.get(e.phase_id) : null) || e.name;
      if (!owner || meta[owner]) continue;
      const payload = parseAgentStart(e);
      if (payload) meta[owner] = payload;
    }
    return meta;
  }

  function laneContext(info) {
    const used = (info && info.context_tokens) || 0;
    const win = (info && info.context_window) || 0;
    if (!used || !win) return null;
    return { used, window: win, pct: Math.min(100, (used / win) * 100) };
  }

  function computeLanes() {
    const ph = state.phases;
    const agentOwners = [];
    for (const p of ph) {
      if (p.kind === 'agent' && p.owner && !agentOwners.includes(p.owner)) agentOwners.push(p.owner);
    }
    const codePhases = ph.filter((p) => p.kind === 'code');
    const out = [
      {
        id: 'engineer',
        label: (state.session && state.session.engineer) || 'engineer',
        model: null,
        context: null,
        color: '#e8b64a',
        kind: 'engineer',
        phases: ph.filter((p) => p.kind === 'engineer')
      }
    ];
    if (codePhases.length) {
      out.push({ id: 'code', label: 'code', model: null, context: null, color: '#5ad2dd', kind: 'code', phases: codePhases });
    }
    const ownerStart = computeOwnerStart();
    agentOwners.forEach((owner, i) => {
      const info = state.agents.find((a) => a.agent === owner);
      const start = ownerStart[owner];
      out.push({
        id: `agent:${owner}`,
        label: owner,
        model: (info && info.model) || (start && start.model) || null,
        context: laneContext(info),
        color: agentColor(info && info.color, start && start.color, i),
        kind: 'agent',
        phases: ph.filter((p) => p.kind === 'agent' && p.owner === owner)
      });
    });
    return out;
  }

  // ── timeline geometry ─────────────────────────────────────────────────────
  const REQ_ZONE_PCT = 16;
  const MIN_BLOCK_PCT = 3.5;

  function requestPhase() {
    return state.phases.find((p) => p.kind === 'engineer' && p.started_at) || null;
  }

  function computeRange(nowMs) {
    let t0 = Infinity;
    let t1 = -Infinity;
    const s = state.session;
    const sStart = ts(s && s.started_at);
    const sEnd = ts(s && s.ended_at);
    if (Number.isFinite(sStart)) t0 = Math.min(t0, sStart);
    if (Number.isFinite(sEnd)) t1 = Math.max(t1, sEnd);
    for (const p of state.phases) {
      const a = ts(p.started_at);
      const b = ts(p.ended_at);
      if (Number.isFinite(a)) {
        t0 = Math.min(t0, a);
        t1 = Math.max(t1, a);
      }
      if (Number.isFinite(b)) t1 = Math.max(t1, b);
    }
    if (s && s.status === 'running') t1 = Math.max(t1, nowMs);
    if (!Number.isFinite(t0)) {
      t0 = nowMs;
      t1 = t0 + 1000;
    }
    if (t1 - t0 < 1000) t1 = t0 + 1000;
    return { t0, t1, span: t1 - t0 };
  }

  function computeOriginMs(range, req) {
    if (!req) return range.t0;
    let earliest = Infinity;
    for (const p of state.phases) {
      if (p.kind === 'engineer') continue;
      const s = ts(p.started_at);
      if (Number.isFinite(s)) earliest = Math.min(earliest, s);
    }
    if (Number.isFinite(earliest)) return Math.max(earliest, range.t0);
    const end = ts(req.ended_at ?? req.started_at);
    return Number.isFinite(end) ? Math.max(end, range.t0) : range.t0;
  }

  function computeBlockLayout(zone, t0, span, reqId, nowMs) {
    const avail = 100 - zone - 0.4;
    const timed = state.phases
      .filter((p) => p.phase_id !== reqId && Number.isFinite(ts(p.started_at)))
      .map((p) => {
        const start = ts(p.started_at);
        let end = ts(p.ended_at);
        if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs : start;
        return {
          id: p.phase_id,
          start,
          left: ((start - t0) / span) * avail,
          width: ((Math.max(end, start) - start) / span) * avail
        };
      })
      .sort((a, b) => a.start - b.start);

    let shift = 0;
    let prevEdge = 0;
    const rows = [];
    for (const b of timed) {
      let left = b.left + shift;
      if (left < prevEdge) {
        shift += prevEdge - left;
        left = prevEdge;
      }
      const width = Math.max(b.width, MIN_BLOCK_PCT);
      shift += width - b.width;
      prevEdge = left + width;
      rows.push({ id: b.id, left, width });
    }
    const scale = avail / Math.max(prevEdge, avail);
    const out = {};
    for (const r of rows) out[r.id] = { left: zone + r.left * scale, width: r.width * scale };
    return out;
  }

  function computeToolTicks() {
    const map = {};
    for (const e of state.events) {
      if (e.type !== 'tool_call' || !e.phase_id) continue;
      (map[e.phase_id] || (map[e.phase_id] = [])).push({ t: ts(e.started_at), ok: payloadOk(e.payload_json) });
    }
    return map;
  }

  function ticksFor(p, toolTicksMap, nowMs) {
    const start = ts(p.started_at);
    if (!Number.isFinite(start)) return [];
    let end = ts(p.ended_at);
    if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs : start;
    const width = Math.max(end - start, 1);
    return (toolTicksMap[p.phase_id] || [])
      .filter((mark) => Number.isFinite(mark.t))
      .map((mark) => ({ x: Math.min(Math.max(((mark.t - start) / width) * 100, 1), 99), ok: mark.ok }));
  }

  function blockDurationMs(p, nowMs) {
    const start = ts(p.started_at);
    if (!Number.isFinite(start)) return NaN;
    const end = p.status === 'running' ? nowMs : ts(p.ended_at);
    return Number.isFinite(end) ? end - start : NaN;
  }

  const STATUS_GLYPH = { success: '✓', fail: '✗', running: '●', queued: '○' };

  // ── waterfall render ───────────────────────────────────────────────────
  function renderWaterfall() {
    if (!state.phases.length) {
      return state.loaded ? '<div class="trace-empty">no phases recorded for this session</div>' : '';
    }
    const nowMs = Date.now();
    const lanes = computeLanes();
    const range = computeRange(nowMs);
    const req = requestPhase();
    const zone = req ? REQ_ZONE_PCT : 0;
    const originMs = computeOriginMs(range, req);
    const postSpan = Math.max(range.t1 - originMs, 1000);
    const ticks = axisTicks(postSpan, 7).map((t) => ({ pct: zone + (t.pct * (100 - zone)) / 100, label: t.label }));
    const layout = computeBlockLayout(zone, originMs, postSpan, req ? req.phase_id : null, nowMs);
    const toolTicksMap = computeToolTicks();

    function blockGeom(p) {
      if (req && p.phase_id === req.phase_id && zone > 0) {
        return { left: '0.4%', width: `${zone - 0.8}%` };
      }
      const geom = layout[p.phase_id];
      if (!geom) return null;
      return { left: `${geom.left}%`, width: `${geom.width}%` };
    }

    const axisRow = `
      <div class="tr-row tr-axis-row">
        <div class="tr-label"></div>
        <div class="tr-track">
          ${zone ? `<span class="tr-zone-head" style="width:${zone}%">request</span>` : ''}
          ${ticks.map((t) => `<span class="tr-axis-label" style="left:${t.pct}%">${escHtml(t.label)}</span>`).join('')}
        </div>
      </div>`;

    const laneRows = lanes
      .map((lane) => {
        const ctx = lane.context;
        const ctxHtml = ctx
          ? `<span class="tr-lane-ctx" title="${NUM.format(ctx.used)} / ${NUM.format(ctx.window)} tokens used">
              <span class="tr-ctx-head"><span class="tr-ctx-label">context</span><span class="tr-ctx-pct">${escHtml(contextLabel(ctx))}</span></span>
              <span class="tr-ctx-bar"><span class="tr-ctx-fill" style="width:${contextFill(ctx)};background:linear-gradient(90deg, ${hexAlpha(lane.color, 0.55)}, ${lane.color})"></span></span>
            </span>`
          : '';
        const modelHtml = lane.model
          ? `<span class="tr-lane-meta tr-lane-model" title="${escHtml(lane.model)}">${modelIcon(lane.model) ? `<img class="tr-model-icon" src="${modelIcon(lane.model)}" alt="" />` : ''}${escHtml(modelName(lane.model))}</span>`
          : '';

        const blocks = lane.phases
          .filter((p) => blockGeom(p))
          .map((p) => {
            const geom = blockGeom(p);
            const dur = blockDurationMs(p, nowMs);
            const marks = ticksFor(p, toolTicksMap, nowMs)
              .map((tk) => `<span class="tr-tool-tick${tk.ok ? '' : ' tr-err'}" style="left:${tk.x}%"></span>`)
              .join('');
            const selected = p.phase_id === state.selectedPhaseId ? ' tr-selected' : '';
            return `
              <button type="button" class="tr-block tr-${escHtml(p.status || 'queued')}${selected}"
                data-action="select-phase" data-phase-id="${escHtml(p.phase_id)}"
                style="left:${geom.left};width:${geom.width};background:linear-gradient(180deg, ${hexAlpha(lane.color, 0.2)}, ${hexAlpha(lane.color, 0.05)});border-color:${p.status === 'fail' ? 'rgba(243,139,168,0.8)' : hexAlpha(lane.color, 0.55)}"
                title="${escHtml(p.name || '')} — ${escHtml(p.status || '')}">
                <span class="tr-b-top">
                  <span class="tr-b-status tr-${escHtml(p.status || 'queued')}">${STATUS_GLYPH[p.status] || '○'}</span>
                  <span class="tr-b-name">${escHtml(p.name || '')}</span>
                  ${Number.isFinite(dur) ? `<span class="tr-b-dur">${statChipHtml('runtime', dur, true)}</span>` : ''}
                </span>
                <span class="tr-b-desc">${escHtml(p.description || '')}</span>
                ${marks}
              </button>`;
          })
          .join('');

        return `
          <div class="tr-row tr-lane tr-kind-${escHtml(lane.kind)}">
            <div class="tr-label">
              <span class="tr-lane-name" style="color:${lane.color}">${escHtml(lane.label)}</span>
              ${modelHtml}
              ${ctxHtml}
            </div>
            <div class="tr-track">
              ${zone ? `<span class="tr-zone-divider" style="left:${zone}%"></span>` : ''}
              ${ticks.map((t) => `<span class="tr-gridline" style="left:${t.pct}%"></span>`).join('')}
              ${blocks}
            </div>
          </div>`;
      })
      .join('');

    return `<div class="tr-waterfall">${axisRow}${laneRows}</div>`;
  }

  function contextLabel(ctx) {
    return ctx.pct < 1 ? `${ctx.pct.toFixed(1)}%` : `${Math.round(ctx.pct)}%`;
  }

  function contextFill(ctx) {
    return `${Math.max(ctx.pct, 2)}%`;
  }

  // ── run strip ──────────────────────────────────────────────────────────
  function renderRunStrip() {
    const s = state.session;
    if (!s) return '';
    const nowMs = Date.now();
    const start = ts(s.started_at);
    const end = s.status === 'running' ? nowMs : ts(s.ended_at);
    const durationMs = Number.isFinite(start) ? (Number.isFinite(end) ? end : nowMs) - start : NaN;
    return `
      <div class="tr-run-strip">
        <span class="tr-request" title="${escHtml(s.request || '')}">${escHtml(s.request || '')}</span>
        ${statusChipHtml(s.status)}
        <span class="tr-dim">started ${escHtml(fmtDate(s.started_at))}</span>
        <span class="tr-run-stats">
          ${statChipHtml('cost', s.total_cost)}
          ${statChipHtml('runtime', durationMs)}
          ${statChipHtml('tokens', s.total_tokens)}
          ${statChipHtml('read', state.usage.read)}
          ${statChipHtml('written', state.usage.written)}
        </span>
      </div>`;
  }

  // ── phase detail ───────────────────────────────────────────────────────
  function phaseEventsFor(phase) {
    return state.events.filter((e) => e.phase_id === phase.phase_id).sort((a, b) => a.rowid - b.rowid);
  }

  function agentConfigFor(phase) {
    if (phase.kind !== 'agent') return null;
    const start = phaseEventsFor(phase).find((e) => e.type === 'agent_start');
    if (!start) return null;
    const config = parseAgentStart(start);
    // session_dir isn't part of the agent_start event payload (SSSF logs
    // only session_id there) — it's a deterministic path the backend
    // computes from adw_id/agent name, delivered via the agents[] list.
    const info = state.agents.find((a) => a.agent === phase.owner);
    if (info && info.session_dir) config.session_dir = info.session_dir;
    return config;
  }

  function requestTextFor(phase) {
    if (phase.kind !== 'engineer') return null;
    for (const e of phaseEventsFor(phase)) {
      if (e.type !== 'log' || !e.payload_json) continue;
      try {
        const p = JSON.parse(e.payload_json);
        if (p && typeof p === 'object' && typeof p.input === 'string' && p.input.trim()) return p.input;
      } catch {
        /* not JSON */
      }
    }
    return null;
  }

  function phaseUsageFor(phase) {
    if (phase.kind !== 'agent') return null;
    const end = phaseEventsFor(phase).find((e) => e.type === 'agent_end');
    if (!end) return null;
    let payload = {};
    try {
      payload = JSON.parse(end.payload_json || '{}');
    } catch {
      /* keep empty */
    }
    const u = payload.usage;
    if (!u) {
      return { partial: true, rows: [{ label: 'total', tokens: end.tokens || 0, cost: payload.cost || 0, kind: 'total' }] };
    }
    const rows = [
      { label: 'input', tokens: u.input_tokens, cost: u.input_cost },
      { label: 'output', tokens: u.output_tokens, cost: u.output_cost }
    ];
    if (u.reasoning_tokens) {
      const share = u.output_tokens ? (u.output_cost * u.reasoning_tokens) / u.output_tokens : 0;
      rows.push({ label: 'thinking', tokens: u.reasoning_tokens, cost: share, kind: 'nested' });
    }
    rows.push(
      { label: 'cache read', tokens: u.cache_read_tokens, cost: u.cache_read_cost },
      { label: 'cache write', tokens: u.cache_write_tokens, cost: u.cache_write_cost },
      { label: 'total', tokens: u.total_tokens, cost: u.total_cost, kind: 'total' }
    );
    return { rows, partial: false };
  }

  function gatesFor(phase) {
    return state.gates
      .filter((g) => g.phase_id === phase.phase_id)
      .sort((a, b) => (a.attempt || 0) - (b.attempt || 0) || a.id - b.id);
  }

  function gateChecks(g) {
    if (g.checks_json == null) return null;
    try {
      const parsed = JSON.parse(g.checks_json);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({ item: typeof c.item === 'string' ? c.item : '', ok: c.ok === true, note: typeof c.note === 'string' ? c.note : '' }));
    } catch {
      return null;
    }
  }

  function gateViolations(g) {
    try {
      const v = JSON.parse(g.violations_json || '[]');
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    } catch {
      /* keep raw below */
    }
    return g.violations_json ? [g.violations_json] : [];
  }

  function outputsFor(phase) {
    return state.envelopes.filter((e) => e.phase_id === phase.phase_id).sort((a, b) => (a.attempt || 0) - (b.attempt || 0));
  }

  function eventDurationMs(e) {
    const a = ts(e.started_at);
    const b = ts(e.ended_at);
    if (Number.isFinite(a) && Number.isFinite(b)) return b - a;
    if (e.type === 'tool_call') {
      const call = parseToolCall(e);
      if (call && call.duration_ms != null) return call.duration_ms;
    }
    return NaN;
  }

  const EVENT_TYPE_CLASS = {
    gate_fail: 'tr-t-red',
    error: 'tr-t-red',
    gate_pass: 'tr-t-green',
    tool_call: 'tr-t-cyan',
    handoff: 'tr-t-violet',
    agent_start: 'tr-t-purple',
    agent_end: 'tr-t-green'
  };

  function section(id, icon, title, count, bodyHtml) {
    if (bodyHtml == null) return '';
    const open = state.openSections.has(id);
    const countHtml = count != null ? `<span class="tr-sec-count">${count}</span>` : '';
    return `
      <div class="tr-section">
        <button type="button" class="tr-sec-head" data-action="toggle-section" data-section="${id}">
          <span class="tr-chev">${open ? '▾' : '▸'}</span>
          <span class="tr-sec-icon">${icon}</span>
          <span class="tr-sec-title">${escHtml(title)}</span>
          ${countHtml}
        </button>
        ${open ? `<div class="tr-sec-body">${bodyHtml}</div>` : ''}
      </div>`;
  }

  async function loadPromptsIfNeeded() {
    const phase = state.phases.find((p) => p.phase_id === state.selectedPhaseId);
    if (!phase || phase.kind !== 'agent' || !phase.owner) {
      state.prompts = null;
      state.promptsState = 'idle';
      return;
    }
    const key = phase.owner;
    if (state.promptCache.has(key)) {
      state.prompts = state.promptCache.get(key);
      state.promptsState = 'ready';
      return;
    }
    state.promptsState = 'loading';
    try {
      const result = await apiCall(`/api/v1/tasks/${state.taskId}/trace/agents/${encodeURIComponent(key)}/prompts`);
      state.promptCache.set(key, result);
      state.prompts = result;
      state.promptsState = 'ready';
      render();
    } catch {
      state.promptsState = 'error';
      render();
    }
  }

  function renderPhaseDetail() {
    const phase = state.phases.find((p) => p.phase_id === state.selectedPhaseId);
    if (!phase) return '';

    const nowMs = Date.now();
    const start = ts(phase.started_at);
    const end = phase.status === 'running' ? nowMs : ts(phase.ended_at);
    const durationMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;

    const requestText = requestTextFor(phase);
    const agentConfig = agentConfigFor(phase);
    const gates = gatesFor(phase);
    const usage = phaseUsageFor(phase);
    const outputs = outputsFor(phase);
    const events = phaseEventsFor(phase);

    // ── request ──
    const requestBody = requestText ? `<p class="tr-request-text">${escHtml(requestText)}</p>` : null;

    // ── agent config (includes the copyable `pi --session` command) ──
    let configBody = null;
    if (agentConfig) {
      const rows = [];
      if (agentConfig.coding_agent) rows.push(row('coding agent', escHtml(agentConfig.coding_agent)));
      if (agentConfig.model) {
        const icon = modelIcon(agentConfig.model);
        rows.push(row('model', `${icon ? `<img class="tr-cfg-model-icon" src="${icon}" alt="" />` : ''}${escHtml(modelName(agentConfig.model))}`));
      }
      if (agentConfig.thinking) rows.push(row('thinking', escHtml(agentConfig.thinking)));
      if (agentConfig.tools !== undefined) {
        rows.push(
          row(
            'tools',
            agentConfig.tools === null
              ? 'all tools'
              : `<span class="tr-cfg-chips">${(agentConfig.tools || []).map((t) => `<span class="tr-cfg-chip">${escHtml(t)}</span>`).join('')}</span>`
          )
        );
      }
      if (agentConfig.purpose) rows.push(row('purpose', escHtml(agentConfig.purpose)));
      if (agentConfig.session_id && agentConfig.session_dir) {
        const cmd = `pi --session-id ${agentConfig.session_id} --session-dir "${agentConfig.session_dir}"`;
        rows.push(
          row(
            'pi session',
            `<span class="tr-pi-cmd">
              <code>${escHtml(cmd)}</code>
              <button type="button" class="tr-copy-btn" data-action="copy-pi-command" data-session-id="${escHtml(agentConfig.session_id)}" data-session-dir="${escHtml(agentConfig.session_dir)}" title="Copy command to resume this exact conversation in pi">copy</button>
            </span>`
          )
        );
      }
      configBody = `<div class="tr-cfg">${rows.join('')}</div>`;
    }
    function row(k, v) {
      return `<div class="tr-cfg-row"><span class="tr-cfg-k">${escHtml(k)}</span><span class="tr-cfg-v">${v}</span></div>`;
    }

    // ── description ──
    const descBody = phase.description ? `<p class="tr-desc">${escHtml(phase.description)}</p>` : null;

    // ── compiled prompts ──
    let promptsBody = null;
    if (phase.kind === 'agent') {
      if (state.promptsState === 'loading') promptsBody = '<div class="tr-faint">loading prompts…</div>';
      else if (state.promptsState === 'error') promptsBody = '<div class="tr-faint">prompts unavailable</div>';
      else if (state.promptsState === 'ready') {
        const p = state.prompts;
        const panels = [];
        if (p && p.system != null) panels.push(['system prompt', p.system]);
        if (p && p.user != null) panels.push(['user prompt', p.user]);
        promptsBody = panels.length
          ? panels
              .map(([title, text]) => `<div class="tr-prompt"><div class="tr-prompt-title">${escHtml(title)}</div><pre class="tr-prompt-pre">${escHtml(text)}</pre></div>`)
              .join('')
          : '<div class="tr-faint">no compiled prompts recorded</div>';
      }
    }

    // ── gates ──
    let gatesBody = '<div class="tr-faint">no gate results</div>';
    if (gates.length) {
      gatesBody = gates
        .map((g) => {
          const checks = gateChecks(g);
          const violations = gateViolations(g);
          if (checks) {
            const open = state.openGates.has(g.id);
            const failed = checks.filter((c) => !c.ok).length;
            const checksLabel = failed > 0 ? `${failed} of ${checks.length} failed` : String(checks.length);
            return `
              <div class="tr-gate ${g.passed ? 'tr-pass' : 'tr-fail'}">
                <button type="button" class="tr-gate-toggle" data-action="toggle-gate" data-gate-id="${g.id}">
                  <span class="tr-chev">${open ? '▾' : '▸'}</span>
                  <span class="tr-gate-mark">${g.passed ? '✓' : '✗'}</span>
                  <span class="tr-gate-name">${escHtml(g.gate || '')}</span>
                  <span class="tr-tag${failed ? ' tr-tag-fail' : ''}">checks: ${escHtml(checksLabel)}</span>
                  <span class="tr-tag">attempt: ${g.attempt ?? 0}</span>
                  <span class="tr-dim">${escHtml(fmtClock(g.created_at))}</span>
                </button>
                ${
                  open
                    ? `<div class="tr-gate-checks">
                        ${checks
                          .map(
                            (c) => `<div class="tr-gate-check ${c.ok ? 'tr-pass' : 'tr-fail'}">
                              <span class="tr-check-mark">${c.ok ? '✓' : '✗'}</span>
                              <span class="tr-check-item">${escHtml(c.item)}</span>
                              ${c.note ? (c.note.includes('\n') ? `<pre class="tr-check-note-block">${escHtml(c.note)}</pre>` : `<span class="tr-check-note">${escHtml(c.note)}</span>`) : ''}
                            </div>`
                          )
                          .join('')}
                        ${!g.passed && violations.length ? `<ul class="tr-violations">${violations.map((v) => `<li>${escHtml(v)}</li>`).join('')}</ul>` : ''}
                      </div>`
                    : ''
                }
              </div>`;
          }
          return `
            <div class="tr-gate ${g.passed ? 'tr-pass' : 'tr-fail'}">
              <div class="tr-gate-line">
                <span class="tr-gate-mark">${g.passed ? '✓' : '✗'}</span>
                <span class="tr-gate-name">${escHtml(g.gate || '')}</span>
                <span class="tr-tag">attempt: ${g.attempt ?? 0}</span>
                <span class="tr-dim">${escHtml(fmtClock(g.created_at))}</span>
              </div>
              ${violations.length ? `<ul class="tr-violations">${violations.map((v) => `<li>${escHtml(v)}</li>`).join('')}</ul>` : ''}
            </div>`;
        })
        .join('');
    }

    // ── cost ──
    let costBody = null;
    if (usage) {
      costBody = `
        <table class="tr-usage">
          <thead><tr><th></th><th class="tr-u-n">tokens</th><th class="tr-u-c">cost</th></tr></thead>
          <tbody>
            ${usage.rows
              .map(
                (r) => `<tr class="${r.kind ? `tr-u-${r.kind}` : ''}"><td class="tr-u-k">${escHtml(r.label)}</td><td class="tr-u-n">${NUM.format(r.tokens || 0)}</td><td class="tr-u-c">${escHtml(money(r.cost || 0))}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${usage.partial ? '<p class="tr-faint tr-u-note">this run predates the per-component breakdown — only the total was recorded</p>' : ''}`;
    }

    // ── outputs ──
    let outputsBody = '<div class="tr-faint">no outputs</div>';
    if (outputs.length) {
      outputsBody = outputs
        .map(
          (env) => `
          <div class="tr-output">
            <div class="tr-output-line">
              <span class="tr-output-type">${escHtml(env.output_type || '')}</span>
              <span class="tr-tag">agent: ${escHtml(env.agent || '—')}</span>
              <span class="tr-tag">attempt: ${env.attempt ?? 0}</span>
              <span class="${env.valid ? 'tr-t-green' : 'tr-t-red'}">${env.valid ? 'valid' : 'invalid'}</span>
            </div>
            <pre class="tr-pre">${highlightJson(env.payload_json)}</pre>
          </div>`
        )
        .join('');
    }

    // ── events (right column) ──
    let eventsBody = '<div class="tr-faint">no events</div>';
    if (events.length) {
      eventsBody = events
        .map((e) => {
          const open = state.expandedEvents.has(e.event_id);
          const dur = eventDurationMs(e);
          const call = e.type === 'tool_call' ? parseToolCall(e) : null;
          let payloadHtml;
          if (call) {
            payloadHtml = `
              <div class="tr-p-meta"><span class="tr-p-tool">${escHtml(call.tool || '')}</span>${call.ok === false ? '<span class="tr-t-red">failed</span>' : ''}${call.duration_ms != null ? statChipHtml('runtime', call.duration_ms, true) : ''}</div>
              <div class="tr-p-h4">args</div>
              <pre class="tr-pre">${highlightJsonText(JSON.stringify(call.args || {}, null, 2))}</pre>
              ${call.result_snippet ? `<div class="tr-p-h4">result</div><pre class="tr-pre">${escHtml(call.result_snippet)}</pre>` : ''}`;
          } else if (e.payload_json) {
            payloadHtml = `<pre class="tr-pre">${highlightJson(e.payload_json)}</pre>`;
          } else {
            payloadHtml = '<div class="tr-faint">no payload</div>';
          }
          return `
            <div class="tr-event">
              <button type="button" class="tr-event-row${open ? ' tr-open' : ''}" data-action="toggle-event" data-event-id="${escHtml(e.event_id)}">
                <span class="tr-e-time tr-dim">${escHtml(fmtClock(e.started_at))}</span>
                <span class="tr-e-type ${EVENT_TYPE_CLASS[e.type] || ''}">${escHtml(e.type || '')}</span>
                <span class="tr-e-name${e.type === 'tool_call' && !payloadOk(e.payload_json) ? ' tr-t-red' : ''}" title="${escHtml(eventLabel(e))}">${escHtml(eventLabel(e))}</span>
                <span class="tr-e-extra">${Number.isFinite(dur) ? statChipHtml('runtime', dur, true) : ''}${e.tokens ? statChipHtml('tokens', e.tokens, true) : ''}</span>
              </button>
              ${open ? `<div class="tr-payload-panel">${payloadHtml}</div>` : ''}
            </div>`;
        })
        .join('');
    }

    return `
      <section class="tr-detail">
        <header class="tr-d-head">
          <div class="tr-d-main">
            <span class="tr-d-name">${escHtml(phase.name || '')}</span>
            ${statusChipHtml(phase.status)}
            ${Number.isFinite(durationMs) ? statChipHtml('runtime', durationMs) : ''}
          </div>
          <div class="tr-d-tags">
            <span class="tr-tag">owner: ${escHtml(phase.owner || '—')}</span>
            <span class="tr-tag">kind: ${escHtml(phase.kind || '—')}</span>
            <span class="tr-tag">attempt: ${phase.attempt ?? 0}/${phase.retries ?? 0}</span>
          </div>
          <button type="button" class="tr-close-detail" data-action="select-phase" data-phase-id="${escHtml(phase.phase_id)}" title="close">✕</button>
        </header>
        ${phase.error ? `<div class="error-bar tr-d-error">${escHtml(phase.error)}</div>` : ''}
        <div class="tr-d-grid">
          <div class="tr-d-col">
            ${section('request', '📥', 'request', null, requestBody)}
            ${section('config', '⚙', 'agent config', null, configBody)}
            ${section('description', '≡', 'description', null, descBody)}
            ${phase.kind === 'agent' ? section('prompts', '💬', 'compiled prompts', null, promptsBody) : ''}
            ${section('gates', '🛡', 'gates', gates.length, gatesBody)}
            ${usage ? section('cost', '💰', 'cost', null, costBody) : ''}
            ${section('outputs', '📦', 'outputs', outputs.length, outputsBody)}
          </div>
          <div class="tr-d-col">
            <h4 class="tr-events-h">events (${events.length})</h4>
            ${eventsBody}
          </div>
        </div>
      </section>`;
  }

  // ── top-level render ───────────────────────────────────────────────────
  function render() {
    if (!dom) return;
    if (state.error && !state.loaded) {
      dom.body.innerHTML = `<div class="error-bar">${escHtml(state.error)}</div>`;
      return;
    }
    if (!state.loaded) {
      dom.body.innerHTML = '<div class="trace-empty">loading trace…</div>';
      return;
    }
    if (!state.session) {
      dom.body.innerHTML = '<div class="trace-empty">no ADW run yet for this task</div>';
      return;
    }
    const errorBar = state.error ? `<div class="error-bar">${escHtml(state.error)}</div>` : '';
    // The live poll (every 1.5s) rebuilds this innerHTML wholesale, which
    // would otherwise reset the waterfall's own scroll position on every
    // tick — save/restore it across the rebuild so scrolling actually holds.
    const prevWaterfallScroll = dom.body.querySelector('.tr-waterfall');
    const waterfallScrollTop = prevWaterfallScroll ? prevWaterfallScroll.scrollTop : 0;
    dom.body.innerHTML = `${errorBar}${renderRunStrip()}${renderWaterfall()}${renderPhaseDetail()}`;
    const nextWaterfall = dom.body.querySelector('.tr-waterfall');
    if (nextWaterfall) nextWaterfall.scrollTop = waterfallScrollTop;
  }

  // ── interaction ────────────────────────────────────────────────────────
  function selectPhase(phaseId) {
    if (state.selectedPhaseId === phaseId) {
      state.selectedPhaseId = null;
    } else {
      state.selectedPhaseId = phaseId;
      state.openSections = new Set();
      state.openGates = new Set();
      state.prompts = null;
      state.promptsState = 'idle';
      void loadPromptsIfNeeded();
    }
    render();
  }

  function handleClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'select-phase') {
      selectPhase(el.dataset.phaseId);
    } else if (action === 'toggle-section') {
      const id = el.dataset.section;
      if (state.openSections.has(id)) state.openSections.delete(id);
      else state.openSections.add(id);
      render();
    } else if (action === 'toggle-gate') {
      const id = Number(el.dataset.gateId);
      if (state.openGates.has(id)) state.openGates.delete(id);
      else state.openGates.add(id);
      render();
    } else if (action === 'toggle-event') {
      const id = el.dataset.eventId;
      if (state.expandedEvents.has(id)) state.expandedEvents.delete(id);
      else state.expandedEvents.add(id);
      render();
    } else if (action === 'copy-pi-command') {
      const cmd = `pi --session-id ${el.dataset.sessionId} --session-dir "${el.dataset.sessionDir}"`;
      const done = () => {
        const prev = el.textContent;
        el.textContent = 'copied!';
        setTimeout(() => {
          el.textContent = prev;
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done).catch(done);
      } else {
        done();
      }
    }
  }

  // ── public API ─────────────────────────────────────────────────────────
  function open(taskId, title) {
    const backdrop = document.getElementById('modal-trace');
    const body = document.getElementById('trace-modal-body');
    const titleEl = document.getElementById('trace-modal-title');
    if (!backdrop || !body) return;
    dom = { backdrop, body };
    if (titleEl) titleEl.textContent = title ? `adw trace — ${title}` : 'adw trace';
    resetState(taskId);
    backdrop.classList.remove('hidden');
    body.removeEventListener('click', handleClick);
    body.addEventListener('click', handleClick);
    render();
    void tick();
    state.timer = setInterval(() => void tick(), 1500);
  }

  function close() {
    const backdrop = document.getElementById('modal-trace');
    if (backdrop) backdrop.classList.add('hidden');
    if (state && state.timer) clearInterval(state.timer);
    state = null;
    dom = null;
  }

  return { open, close };
})();

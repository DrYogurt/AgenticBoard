// AgenticBoard — Workflow (ADW) Diagram View
//
// Standalone, self-contained module: renders a clickable UML-style
// box-and-line diagram of a project's `adws[]` — one node per workflow
// (left column), one node per unique agent-role name referenced across
// those workflows (right column, deduplicated), with lines connecting each
// workflow to the agent roles it uses. Purely a rendering/click-dispatch
// layer: it never opens modals or mutates project data itself, it only
// calls the callbacks the caller supplies.
//
// This module does not fetch anything and holds no cross-render state of
// its own beyond what's stashed on the container element it was given, so
// multiple containers can be rendered independently.
//
// Public API: window.WorkflowDiagram = { render(containerEl, project, opts), destroy(containerEl) }

const WorkflowDiagram = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Layout constants (px). Positions are computed arithmetically from these
  // rather than measured via getBoundingClientRect, so the diagram lays out
  // identically whether or not a real layout engine is available.
  const NODE_WIDTH = 200;
  const NODE_HEIGHT = 54;
  const ROW_GAP = 16;
  const COLUMN_GAP = 170;
  const CANVAS_PADDING = 20;
  const HEADER_HEIGHT = 30;

  // ── helpers ──────────────────────────────────────────────────────────

  function clearEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function normalizeAgentId(id) {
    return (id == null ? '' : String(id)).trim();
  }

  // An ADW references an agent role via a `type: 'agent'` parameter whose
  // `default` holds the Agent's id — this is exactly SSSF's own `--agent`
  // CLI-flag convention, not a separate board-only field. Dedupe those ids
  // across all adws, preserving first-appearance order, and count how many
  // workflows reference each one.
  function collectAgents(adws) {
    const order = [];
    const seen = new Set();
    const usage = new Map();
    adws.forEach((adw) => {
      const params = Array.isArray(adw && adw.parameters) ? adw.parameters : [];
      params.forEach((p) => {
        if (!p || p.type !== 'agent') return;
        const id = normalizeAgentId(p.default);
        if (!id) return;
        if (!seen.has(id)) {
          seen.add(id);
          order.push(id);
        }
        usage.set(id, (usage.get(id) || 0) + 1);
      });
    });
    return { names: order, usage };
  }

  function rowY(index) {
    return CANVAS_PADDING + index * (NODE_HEIGHT + ROW_GAP);
  }

  function makeClickable(el, onClick) {
    if (typeof onClick !== 'function') return;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(e);
      }
    });
  }

  function positionBox(el, x, y, w, h) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  // primaryText/secondaryText are always set via textContent — never
  // interpolated into innerHTML — since workflow ids/names and agent-role
  // names are user-controlled strings.
  function makeNode({ x, y, w, h, className, primaryText, secondaryText, titleAttr, onClick }) {
    const node = document.createElement('div');
    node.className = 'wd-node ' + className;
    positionBox(node, x, y, w, h);
    if (titleAttr) node.title = titleAttr;

    const label = document.createElement('div');
    label.className = 'wd-node-label';
    label.textContent = primaryText;
    node.appendChild(label);

    if (secondaryText) {
      const sub = document.createElement('div');
      sub.className = 'wd-node-sub';
      sub.textContent = secondaryText;
      node.appendChild(sub);
    }

    makeClickable(node, onClick);
    return node;
  }

  function makeAddNode({ x, y, w, h, label, className, onClick }) {
    const node = document.createElement('div');
    node.className = 'wd-node wd-node-add ' + (className || '');
    positionBox(node, x, y, w, h);

    const labelEl = document.createElement('div');
    labelEl.className = 'wd-node-label';
    labelEl.textContent = '+ ' + label;
    node.appendChild(labelEl);

    makeClickable(node, onClick);
    return node;
  }

  function makeEdge(x1, y1, x2, y2) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('class', 'wd-edge');
    return line;
  }

  function renderEmptyState(root, opts) {
    const empty = document.createElement('div');
    empty.className = 'wd-empty';

    const msg = document.createElement('p');
    msg.className = 'wd-empty-message';
    msg.textContent = 'no workflows registered for this project yet.';
    empty.appendChild(msg);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary wd-empty-add-btn';
    btn.textContent = '+ new workflow';
    btn.addEventListener('click', () => {
      if (typeof opts.onAddWorkflow === 'function') opts.onAddWorkflow();
    });
    empty.appendChild(btn);

    root.appendChild(empty);
  }

  // ── main render ──────────────────────────────────────────────────────

  function render(containerEl, project, opts) {
    if (!containerEl) return;
    opts = opts || {};

    destroy(containerEl);

    const root = document.createElement('div');
    root.className = 'wd-root';
    containerEl.appendChild(root);
    containerEl._workflowDiagram = { root };

    const adws = (project && Array.isArray(project.adws)) ? project.adws : [];

    if (adws.length === 0) {
      renderEmptyState(root, opts);
      return;
    }

    const { names: agentNames, usage } = collectAgents(adws);

    const workflowColX = CANVAS_PADDING;
    const agentColX = CANVAS_PADDING + NODE_WIDTH + COLUMN_GAP;
    const canvasWidth = agentColX + NODE_WIDTH + CANVAS_PADDING;

    const workflowRowCount = adws.length + 1; // +1: "add workflow" affordance
    const agentRowCount = agentNames.length + 1; // +1: "add agent role" affordance
    const totalRows = Math.max(workflowRowCount, agentRowCount, 1);
    const canvasHeight = CANVAS_PADDING * 2 + totalRows * NODE_HEIGHT + (totalRows - 1) * ROW_GAP;

    // Scroll container: header + canvas live inside it together so they
    // always scroll (both axes) in lockstep; the header row is sticky so it
    // stays visible while scrolling through a tall list of nodes.
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'wd-scroll';
    root.appendChild(scrollWrap);

    const inner = document.createElement('div');
    inner.className = 'wd-canvas-inner';
    inner.style.width = canvasWidth + 'px';
    scrollWrap.appendChild(inner);

    const headerRow = document.createElement('div');
    headerRow.className = 'wd-header-row';
    headerRow.style.width = canvasWidth + 'px';
    headerRow.style.height = HEADER_HEIGHT + 'px';
    inner.appendChild(headerRow);

    const wfTitle = document.createElement('div');
    wfTitle.className = 'wd-column-title';
    wfTitle.style.left = workflowColX + 'px';
    wfTitle.style.width = NODE_WIDTH + 'px';
    wfTitle.textContent = 'workflows';
    headerRow.appendChild(wfTitle);

    const agTitle = document.createElement('div');
    agTitle.className = 'wd-column-title';
    agTitle.style.left = agentColX + 'px';
    agTitle.style.width = NODE_WIDTH + 'px';
    agTitle.textContent = 'agent roles';
    headerRow.appendChild(agTitle);

    const canvas = document.createElement('div');
    canvas.className = 'wd-canvas';
    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = canvasHeight + 'px';
    inner.appendChild(canvas);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'wd-svg');
    svg.setAttribute('width', String(canvasWidth));
    svg.setAttribute('height', String(canvasHeight));
    canvas.appendChild(svg);

    // Positions keyed per-render only (workflow key falls back to an index
    // when id is blank/duplicate, e.g. an unsaved new workflow card).
    const workflowPositions = new Map();
    adws.forEach((adw, i) => {
      const key = (adw && adw.id) ? adw.id : '__idx' + i;
      workflowPositions.set(key, { x: workflowColX, y: rowY(i), w: NODE_WIDTH, h: NODE_HEIGHT });
    });

    const agentPositions = new Map();
    agentNames.forEach((name, i) => {
      agentPositions.set(name, { x: agentColX, y: rowY(i), w: NODE_WIDTH, h: NODE_HEIGHT });
    });

    // Edges first, so node boxes render on top of the lines feeding them.
    adws.forEach((adw, i) => {
      const key = (adw && adw.id) ? adw.id : '__idx' + i;
      const from = workflowPositions.get(key);
      const params = Array.isArray(adw && adw.parameters) ? adw.parameters : [];
      params.forEach((p) => {
        if (!p || p.type !== 'agent') return;
        const id = normalizeAgentId(p.default);
        if (!id) return;
        const to = agentPositions.get(id);
        if (!to) return;
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        svg.appendChild(makeEdge(x1, y1, x2, y2));
      });
    });

    // Workflow nodes.
    adws.forEach((adw, i) => {
      const key = (adw && adw.id) ? adw.id : '__idx' + i;
      const pos = workflowPositions.get(key);
      const id = adw && adw.id;
      const primary = (adw && (adw.name || adw.id)) || '(unnamed workflow)';
      const secondary = id ? ('[' + id + ']') : '[unsaved]';
      const node = makeNode({
        x: pos.x, y: pos.y, w: pos.w, h: pos.h,
        className: 'wd-node-workflow',
        primaryText: primary,
        secondaryText: secondary,
        titleAttr: (adw && adw.path) || '',
        onClick: () => {
          if (typeof opts.onSelectAdw === 'function') opts.onSelectAdw(id);
        }
      });
      if (id) node.dataset.adwId = id;
      canvas.appendChild(node);
    });

    // "+ new workflow" affordance, one row below the last workflow node.
    canvas.appendChild(makeAddNode({
      x: workflowColX, y: rowY(adws.length), w: NODE_WIDTH, h: NODE_HEIGHT,
      label: 'new workflow',
      className: 'wd-node-add-workflow',
      onClick: () => {
        if (typeof opts.onAddWorkflow === 'function') opts.onAddWorkflow();
      }
    }));

    // Agent-role nodes (or an explanatory note if none are referenced yet).
    if (agentNames.length === 0) {
      const note = document.createElement('div');
      note.className = 'wd-node-empty-note';
      note.style.left = agentColX + 'px';
      note.style.top = rowY(0) + 'px';
      note.style.width = NODE_WIDTH + 'px';
      note.textContent = 'no agent roles referenced yet';
      canvas.appendChild(note);
    } else {
      agentNames.forEach((name, i) => {
        const pos = agentPositions.get(name);
        const count = usage.get(name) || 0;
        const secondary = count === 1 ? 'used by 1 workflow' : ('used by ' + count + ' workflows');
        const node = makeNode({
          x: pos.x, y: pos.y, w: pos.w, h: pos.h,
          className: 'wd-node-agent',
          primaryText: name,
          secondaryText: secondary,
          onClick: () => {
            if (typeof opts.onSelectAgent === 'function') opts.onSelectAgent(name);
          }
        });
        node.dataset.agentId = name;
        canvas.appendChild(node);
      });
    }

    // "+ new agent role" affordance, one row below the last agent node.
    canvas.appendChild(makeAddNode({
      x: agentColX, y: rowY(agentNames.length), w: NODE_WIDTH, h: NODE_HEIGHT,
      label: 'new agent role',
      className: 'wd-node-add-agent',
      onClick: () => {
        if (typeof opts.onAddAgent === 'function') opts.onAddAgent();
      }
    }));
  }

  // ── public API ───────────────────────────────────────────────────────

  // No document-level listeners are attached by this module (unlike
  // ProjectView's click-outside-to-close model picker), so destroy only
  // needs to clear the container's DOM. It's still exposed/called (render
  // calls it internally too) so a future addition of such a listener has
  // a single place to add matching cleanup.
  function destroy(containerEl) {
    if (!containerEl) return;
    clearEl(containerEl);
    delete containerEl._workflowDiagram;
  }

  return { render, destroy };
})();

window.WorkflowDiagram = WorkflowDiagram;

// AgenticBoard Web UI Client Script — Dr. Yogurt Zen Terminal

// A real board column (see engine.ts's own ARCHIVED_COLUMN_ID) that a
// column's own trash-can button archives into instead of deleting the
// column. Deliberately hidden from the main kanban grid, the task-status
// dropdown, and the manage-columns list — its only UI surface is the
// "Archived Tasks" drawer (see openArchiveModal).
const ARCHIVED_COLUMN_ID = 'archived';

const state = {
  board: null,
  tasks: [],
  projects: [],
  extensions: [],
  agents: [],
  filterProject: '',
  searchQuery: '',
  isExpanded: false,
  isDraggingCard: false,
  cachedGreeting: '',
  cachedGreetingPeriod: '',
  lastKnownRevision: 0
};

// DOM Cache
const dom = {
  app: document.getElementById('app'),
  boardTitle: document.getElementById('board-title-text'),
  kanbanCanvas: document.getElementById('kanban-canvas'),
  searchInput: document.getElementById('search-input'),
  searchOverlay: document.getElementById('search-overlay'),
  projectFilterSelect: document.getElementById('project-filter-select'),
  taskCounter: document.getElementById('task-counter'),
  projectCounter: document.getElementById('project-counter'),
  extensionCounter: document.getElementById('extension-counter'),
  liveStatus: document.getElementById('live-status'),

  // Hero & Greeting Elements
  heroGreeting: document.getElementById('hero-greeting'),
  heroClock: document.getElementById('hero-clock'),
  clockHourHand: document.getElementById('clock-hour-hand'),
  clockMinuteHand: document.getElementById('clock-minute-hand'),
  heroWorkloadBadge: document.getElementById('hero-workload-badge'),
  headerGreetingText: document.getElementById('header-greeting-text'),
  btnCollapseBoard: document.getElementById('btn-collapse-board'),

  // Zen Header Nav
  currentProjectTitle: document.getElementById('current-project-title'),
  btnProjectReset: document.getElementById('btn-project-reset'),
  btnProjectNext: document.getElementById('btn-project-next'),
  btnHamburger: document.getElementById('btn-hamburger'),
  hamburgerDropdown: document.getElementById('hamburger-dropdown'),
  fabAddTask: document.getElementById('fab-add-task'),
  menuSearch: document.getElementById('menu-search'),
  menuHero: document.getElementById('menu-hero'),

  // Modals
  modalTask: document.getElementById('modal-task'),
  modalColumn: document.getElementById('modal-column'),
  modalProjects: document.getElementById('modal-projects'),
  modalExtensions: document.getElementById('modal-extensions'),
  modalArchived: document.getElementById('modal-archived'),

  // Forms
  formTask: document.getElementById('form-task'),
  formColumn: document.getElementById('form-column'),
  formProject: document.getElementById('form-project'),
  formExtension: document.getElementById('form-extension'),

  // Task Form Fields
  taskIdInput: document.getElementById('task-id-input'),
  taskTitleInput: document.getElementById('task-title-input'),
  taskStatusInput: document.getElementById('task-status-input'),
  taskProjectInput: document.getElementById('task-project-input'),
  taskAdwInput: document.getElementById('task-adw-input'),
  taskAdwParamsContainer: document.getElementById('task-adw-params-container'),
  taskDescInput: document.getElementById('task-desc-input'),
  btnDeleteTask: document.getElementById('btn-delete-task'),

  // Containers inside modals
  projectsContainer: document.getElementById('projects-container'),
  projectSearchInput: document.getElementById('project-search-input'),
  extensionsContainer: document.getElementById('extensions-container'),
  archivedContainer: document.getElementById('archived-container'),

  // Document upload (task modal)
  docUploadBox: document.getElementById('doc-upload-box'),
  docUploadInput: document.getElementById('doc-upload-input'),
  docUploadTarget: document.getElementById('doc-upload-target'),
  docUploadStatus: document.getElementById('doc-upload-status'),
  docList: document.getElementById('doc-list'),

  // Workflow trace (task modal + preview drawer)
  taskWorkflowSection: document.getElementById('task-workflow-section'),
  taskTracePanel: document.getElementById('task-trace-panel'),
  btnStartTask: document.getElementById('btn-start-task'),
  btnStopTask: document.getElementById('btn-stop-task'),
  btnTogglePreview: document.getElementById('btn-toggle-preview'),
  workflowPreviewPanel: document.getElementById('workflow-preview-panel'),
  previewDrawerBody: document.getElementById('preview-drawer-body'),
  btnClosePreview: document.getElementById('btn-close-preview')
};

// --- Modular Cheeky Greetings Generator (Mix and Match 3-Line Blocks) ---
function getCheekyGreeting(todoCount, inProgressCount) {
  const now = new Date();
  const hour = now.getHours();

  let period = 'morning';
  if (hour >= 12 && hour < 18) period = 'afternoon';
  else if (hour >= 18 && hour < 23) period = 'evening';
  else if (hour >= 23 || hour < 5) period = 'night';

  const periodKey = `${period}_${todoCount}_${inProgressCount}`;
  if (state.cachedGreeting && state.cachedGreetingPeriod === periodKey) {
    return state.cachedGreeting;
  }

  const doctorTag = `<span class="highlight-blue">Dr. Yogurt</span>`;

  // 1. Modular Openers (Line 1)
  const openers = {
    morning: [
      `Good morning, ${doctorTag}!`,
      `Rise & grind, ${doctorTag}!`,
      `Salutations, ${doctorTag}!`,
      `Top of the morning, ${doctorTag}!`,
      `Welcome back, ${doctorTag}!`
    ],
    afternoon: [
      `Good afternoon, ${doctorTag}!`,
      `Salutations, ${doctorTag}!`,
      `Welcome back, ${doctorTag}!`,
      `Greetings, ${doctorTag}!`,
      `System operational, ${doctorTag}!`
    ],
    evening: [
      `Good evening, ${doctorTag}!`,
      `Evening session, ${doctorTag}!`,
      `Salutations, ${doctorTag}!`,
      `Welcome back, ${doctorTag}!`,
      `Greetings, ${doctorTag}!`
    ],
    night: [
      `Late night session, ${doctorTag}!`,
      `Blinking in the dark, ${doctorTag}?`,
      `Midnight terminal, ${doctorTag}!`,
      `Night owl mode, ${doctorTag}!`,
      `Greetings nocturnal legend, ${doctorTag}!`
    ]
  };

  // 2. Modular Workload Observers (Line 2)
  let workloadMsg = [];
  if (todoCount === 0 && inProgressCount === 0) {
    workloadMsg = [
      "Zero tasks in sight.",
      `<span class="highlight-blue">0</span> tasks remaining.`,
      "Empty board detected.",
      "No pending work in queue.",
      "All columns clean and clear."
    ];
  } else if (inProgressCount > 0) {
    workloadMsg = [
      `Juggling <span class="highlight-blue">${inProgressCount}</span> active tasks right now.`,
      `<span class="highlight-blue">${inProgressCount}</span> tasks currently cooking in progress.`,
      `<span class="highlight-blue">${inProgressCount}</span> active tasks on the hot seat.`,
      `Burning the midnight oil with <span class="highlight-blue">${inProgressCount}</span> tasks.`
    ];
  } else {
    workloadMsg = [
      `You've got <span class="highlight-blue">${todoCount}</span> pending tasks waiting.`,
      `A mountain of <span class="highlight-blue">${todoCount}</span> tasks awaits your command.`,
      `<span class="highlight-blue">${todoCount}</span> tasks sitting ready in To Do.`,
      `Attention: <span class="highlight-blue">${todoCount}</span> tasks pending in queue.`
    ];
  }

  // 3. Modular Punchlines / Closers (Line 3)
  let punchlines = [];
  if (todoCount === 0 && inProgressCount === 0) {
    punchlines = [
      "Is this peace, or the calm before the storm?",
      "Time for coffee and deep philosophical thoughts?",
      "Did you finish everything or just hide them?",
      "Enjoy the serene silence while it lasts."
    ];
  } else {
    punchlines = [
      "Caffeine level: critical.",
      "Defeat procrastination today!",
      "Ready to achieve greatness?",
      "Keep the momentum going!",
      "Legendary productivity unlocked.",
      "Your terminal is ready for action.",
      "The dark theme is strong with you.",
      "Stay locked in the zen zone!"
    ];
  }

  const openerPool = openers[period] || openers.morning;
  const line1 = openerPool[Math.floor(Math.random() * openerPool.length)];
  const line2 = workloadMsg[Math.floor(Math.random() * workloadMsg.length)];
  const line3 = punchlines[Math.floor(Math.random() * punchlines.length)];

  const result = `${line1}<br>${line2}<br>${line3}`;

  state.cachedGreeting = result;
  state.cachedGreetingPeriod = periodKey;

  return result;
}

// --- Format Header Greeting (Displays lines 2 & 3 joined by space, omitting line 1 & em-dashes) ---
function formatHeaderGreeting(greetingHTML) {
  const parts = greetingHTML.split(/<br\s*\/?>/gi).map((p) => p.trim());
  if (parts.length >= 3) {
    return `${parts[1]} ${parts[2]}`;
  } else if (parts.length === 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return greetingHTML;
}

// --- Wrap Individual Words in Spans for Dynamic Hover Growth ---
function wrapWordsInSpans(html) {
  return html.replace(/(<[^>]+>)|([^\s<]+)/g, (match, tag, word) => {
    if (tag) return tag;
    return `<span class="hover-word">${word}</span>`;
  });
}

// --- Continuous Proximity-Based Distance Gradient Hover Effect ---
function setupProximityTextEffect() {
  document.addEventListener('mousemove', (e) => {
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const radius = 120; // Influence radius in pixels

    // Target the greeting container currently visible on screen
    const activeContainer = state.isExpanded ? dom.headerGreetingText : dom.heroGreeting;
    if (!activeContainer) return;

    const words = activeContainer.querySelectorAll('.hover-word');
    if (!words.length) return;

    const containerRect = activeContainer.getBoundingClientRect();
    const isNearContainer =
      mouseX >= containerRect.left - radius &&
      mouseX <= containerRect.right + radius &&
      mouseY >= containerRect.top - radius &&
      mouseY <= containerRect.bottom + radius;

    words.forEach((word) => {
      if (!isNearContainer) {
        word.style.transform = 'scale(1) translateY(0px)';
        word.style.textShadow = 'none';
        word.style.color = '';
        word._ty = 0;
        return;
      }

      const rect = word.getBoundingClientRect();
      const currentTy = word._ty || 0;
      const wordX = rect.left + rect.width / 2;
      const wordY = (rect.top - currentTy) + rect.height / 2;

      const dist = Math.hypot(mouseX - wordX, mouseY - wordY);

      if (dist < radius) {
        const proximity = 1 - dist / radius;
        const smoothP = Math.pow(proximity, 1.4);

        const scale = (1 + 0.18 * smoothP).toFixed(3);
        const translateY = -4 * smoothP;
        word._ty = translateY;

        const glowAlpha = (0.2 * smoothP).toFixed(2);
        const glowBlur = (8 * smoothP).toFixed(1);

        word.style.transform = `scale(${scale}) translateY(${translateY.toFixed(2)}px)`;
        word.style.textShadow = `0 0 ${glowBlur}px rgba(203, 166, 247, ${glowAlpha})`;

        if (word.classList.contains('highlight-blue')) {
          const r = Math.round(137 + 100 * smoothP);
          const g = Math.round(180 + 40 * smoothP);
          const b = Math.round(250 + 5 * smoothP);
          word.style.color = `rgb(${r}, ${g}, ${b})`;
        } else {
          const r = Math.round(205 + 50 * smoothP);
          const g = Math.round(214 - 30 * smoothP);
          const b = Math.round(244 + 11 * smoothP);
          word.style.color = `rgb(${r}, ${g}, ${b})`;
        }
      } else {
        word.style.transform = 'scale(1) translateY(0px)';
        word.style.textShadow = 'none';
        word.style.color = '';
        word._ty = 0;
      }
    });
  });
}

// --- Minimalist Analogue Clock (SVG Ticking) ---
function initLiveClock() {
  function updateAnalogueClock() {
    if (!dom.clockHourHand || !dom.clockMinuteHand) return;
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    const hourAngle = ((hours % 12) + minutes / 60 + seconds / 3600) * 30;
    const minuteAngle = (minutes + seconds / 60) * 6;

    // Convert angles to SVG coordinates (center at 50, 50)
    // Hour hand length = 24px
    const hourRad = hourAngle * (Math.PI / 180);
    const hx2 = 50 + 24 * Math.sin(hourRad);
    const hy2 = 50 - 24 * Math.cos(hourRad);

    // Minute hand length = 35px
    const minRad = minuteAngle * (Math.PI / 180);
    const mx2 = 50 + 35 * Math.sin(minRad);
    const my2 = 50 - 35 * Math.cos(minRad);

    dom.clockHourHand.setAttribute('x2', hx2.toFixed(2));
    dom.clockHourHand.setAttribute('y2', hy2.toFixed(2));

    dom.clockMinuteHand.setAttribute('x2', mx2.toFixed(2));
    dom.clockMinuteHand.setAttribute('y2', my2.toFixed(2));
  }

  updateAnalogueClock();
  setInterval(updateAnalogueClock, 1000);
}

// --- API Methods ---
async function apiCall(endpoint, method = 'GET', body = null) {
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (method !== 'GET' && typeof state.lastKnownRevision === 'number') {
      opts.headers['x-expected-revision'] = String(state.lastKnownRevision);
    }
    if (body) {
      if (method !== 'GET' && typeof state.lastKnownRevision === 'number' && typeof body === 'object' && body !== null) {
        if (body.expected_revision === undefined) {
          body.expected_revision = state.lastKnownRevision;
        }
      }
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(endpoint, opts);
    const data = await res.json();
    if (!res.ok || (data && data.success === false)) {
      throw new Error(data.error || `HTTP error ${res.status}`);
    }
    return data.data !== undefined ? data.data : data;
  } catch (err) {
    console.error(`API Call failed [${method} ${endpoint}]:`, err);
    throw err;
  }
}

let lastRenderedStateHash = '';
let lastActivityFetchTime = 0;

function isAnyModalOpen() {
  const modalIds = ['modal-task', 'modal-column', 'modal-projects', 'modal-extensions', 'modal-archived', 'modal-project-view'];
  return modalIds.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

function requestActivityUpdate() {
  const now = Date.now();
  if (now - lastActivityFetchTime > 2500) {
    lastActivityFetchTime = now;
    fetchBoardState();
  }
}

async function fetchBoardState() {
  if (state.isDraggingCard) return;
  try {
    const res = await apiCall('/api/v1/board');
    if (state.isDraggingCard) return;

    if (isAnyModalOpen()) {
      return;
    }

    state.board = res.board;
    state.tasks = res.tasks;
    state.projects = res.projects;
    state.extensions = res.extensions;
    state.agents = res.agents;
    state.lastKnownRevision = typeof res.board?.revision === 'number' ? res.board.revision : 0;

    const newHash = JSON.stringify({
      board: res.board,
      tasks: res.tasks,
      projects: res.projects,
      extensions: res.extensions,
      agents: res.agents
    });

    if (newHash === lastRenderedStateHash) {
      return;
    }

    lastRenderedStateHash = newHash;
    renderApp();
  } catch (err) {
    console.error('Error fetching board state:', err);
  }
}

// --- Workflow Trace (SSSF ADW runs) ---
let taskTracePollTimer = null;
let previewPollTimer = null;

// Compact, equal-width gantt-style strip — a preview, not the real timeline
// (that's the full trace modal in trace.js). Doubles as the running indicator:
// the active phase's bar pulses, so this alone is enough to see "it's working".
function renderMiniGantt(session, phases) {
  const status = (session && session.status) || 'running';
  const tokens = session && typeof session.total_tokens === 'number' ? session.total_tokens.toLocaleString() : '0';
  const cost = session && typeof session.total_cost === 'number' ? `$${session.total_cost.toFixed(4)}` : '$0.0000';
  const bars = (phases || [])
    .map((p) => {
      const s = p.status || 'queued';
      return `<span class="mini-bar mini-${escapeHTML(s)}" title="${escapeHTML(p.name || '')} — ${escapeHTML(s)}"></span>`;
    })
    .join('');
  return `
    <div class="mini-gantt" data-open-trace="1" title="click to open the full trace">
      <div class="mini-gantt-header">
        <span class="run-status-badge run-status-${escapeHTML(status)}">${escapeHTML(status)}</span>
        <span class="session-meta">${tokens} tok · ${cost}</span>
      </div>
      <div class="mini-gantt-bars">${bars || '<span class="trace-empty">no phases yet</span>'}</div>
    </div>`;
}

function taskDisplayName(task) {
  return task ? task.name || task.title || task.id : '';
}

async function pollTaskTrace(taskId) {
  if (!dom.taskTracePanel) return;
  try {
    const detail = await apiCall(`/api/v1/tasks/${taskId}/trace`);
    dom.taskTracePanel.innerHTML = renderMiniGantt(detail.session, detail.phases);
    const running = detail.session && detail.session.status === 'running';
    const failed = detail.session && detail.session.status === 'fail';
    if (dom.btnStartTask) {
      dom.btnStartTask.classList.toggle('hidden', !!running);
      dom.btnStartTask.textContent = failed ? '↻ re-run' : '▶ start';
    }
    if (dom.btnStopTask) dom.btnStopTask.classList.toggle('hidden', !running);
  } catch (err) {
    dom.taskTracePanel.innerHTML = '<div class="trace-empty">not started yet — click start to launch this task\'s ADW</div>';
    if (dom.btnStartTask) {
      dom.btnStartTask.classList.remove('hidden');
      dom.btnStartTask.textContent = '▶ start';
    }
    if (dom.btnStopTask) dom.btnStopTask.classList.add('hidden');
  }
}

function startTaskTracePolling(taskId) {
  stopTaskTracePolling();
  pollTaskTrace(taskId);
  taskTracePollTimer = setInterval(() => pollTaskTrace(taskId), 2000);
}

function stopTaskTracePolling() {
  if (taskTracePollTimer) clearInterval(taskTracePollTimer);
  taskTracePollTimer = null;
}

async function pollWorkflowPreview() {
  if (!dom.previewDrawerBody) return;
  try {
    const [runs, liveAgents] = await Promise.all([
      apiCall('/api/v1/runs/active').catch(() => []),
      apiCall('/api/v1/live-agents').catch(() => [])
    ]);

    const runCards = await Promise.all(
      (runs || []).map(async (run) => {
        const task = state.tasks.find((t) => t.id === run.task_id);
        const taskName = taskDisplayName(task) || run.task_id;
        let body = '<div class="trace-empty">loading…</div>';
        try {
          const detail = await apiCall(`/api/v1/tasks/${run.task_id}/trace`);
          body = renderMiniGantt(detail.session, detail.phases);
        } catch {
          body = '<div class="trace-empty">waiting for trace…</div>';
        }
        return `
          <div class="preview-run-card" data-open-trace-task="${escapeHTML(run.task_id)}" data-open-trace-name="${escapeHTML(taskName)}">
            <div class="preview-run-header">
              <strong>${escapeHTML(taskName)}</strong>
              <span class="task-id-tag">${escapeHTML(run.task_id)}</span>
            </div>
            ${body}
          </div>`;
      })
    );

    // Live agents already shown above as a board-tracked run don't need a second card —
    // this section is specifically for agents /api/v1/runs/active can't see (started
    // directly via SSSF, or a run that outlived a server restart).
    const shownTaskIds = new Set((runs || []).map((r) => r.task_id));
    const agentCards = (liveAgents || [])
      .filter((a) => !a.task_id || !shownTaskIds.has(a.task_id))
      .map((a) => {
        const task = a.task_id ? state.tasks.find((t) => t.id === a.task_id) : null;
        const label = (task && taskDisplayName(task)) || a.session_request || a.agent_name || a.adw_id;
        const openAttrs = a.task_id
          ? `data-open-trace-task="${escapeHTML(a.task_id)}" data-open-trace-name="${escapeHTML(label)}"`
          : '';
        return `
          <div class="preview-run-card" ${openAttrs}>
            <div class="preview-run-header">
              <strong>${escapeHTML(label)}</strong>
              <span class="task-id-tag">${escapeHTML(a.project_id)}</span>
            </div>
            <div class="preview-agent-meta">
              agent: ${escapeHTML(a.agent_name || '—')} · pid ${escapeHTML(String(a.pid))}${a.task_id ? '' : ' · not yet a board task'}
            </div>
          </div>`;
      });

    if (runCards.length === 0 && agentCards.length === 0) {
      dom.previewDrawerBody.innerHTML = '<div class="trace-empty">no active workflows</div>';
      return;
    }

    const sections = [];
    if (runCards.length > 0) sections.push(runCards.join(''));
    if (agentCards.length > 0) {
      sections.push(`<div class="preview-section-label">live agents</div>${agentCards.join('')}`);
    }
    dom.previewDrawerBody.innerHTML = sections.join('');
  } catch (err) {
    dom.previewDrawerBody.innerHTML = '<div class="trace-empty">failed to load active workflows</div>';
  }
}

function toggleWorkflowPreview() {
  if (!dom.workflowPreviewPanel) return;
  const isHidden = dom.workflowPreviewPanel.classList.contains('hidden');
  if (isHidden) {
    dom.workflowPreviewPanel.classList.remove('hidden');
    pollWorkflowPreview();
    previewPollTimer = setInterval(pollWorkflowPreview, 3000);
  } else {
    closeWorkflowPreview();
  }
}

function closeWorkflowPreview() {
  if (dom.workflowPreviewPanel) dom.workflowPreviewPanel.classList.add('hidden');
  if (previewPollTimer) clearInterval(previewPollTimer);
  previewPollTimer = null;
}

// --- SSE Real-time Synchronization ---
function initSSE() {
  try {
    const evtSource = new EventSource('/api/v1/events');

    evtSource.onopen = () => {
      if (dom.liveStatus) {
        dom.liveStatus.querySelector('.status-dot').style.backgroundColor = 'var(--accent-green)';
      }
      // Re-fetch full state on reconnect
      fetchBoardState();
    };

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== 'connected') {
          if (isAnyModalOpen()) {
            if (typeof data.revision === 'number' && data.revision > state.lastKnownRevision) {
              const currentTaskId = dom.taskIdInput ? dom.taskIdInput.value : (document.getElementById('task-id-input')?.value || document.getElementById('task-id')?.value);
              if (currentTaskId && data.affected_ids && data.affected_ids.includes(currentTaskId)) {
                let warningBanner = document.getElementById('conflict-warning-banner');
                if (!warningBanner) {
                  warningBanner = document.createElement('div');
                  warningBanner.id = 'conflict-warning-banner';
                  warningBanner.style.backgroundColor = 'var(--accent-yellow)';
                  warningBanner.style.color = 'black';
                  warningBanner.style.padding = '10px';
                  warningBanner.style.marginBottom = '15px';
                  warningBanner.style.borderRadius = '5px';
                  warningBanner.style.fontWeight = 'bold';
                  warningBanner.textContent = 'Conflict: This task was modified by another user. Close and re-open to see changes.';
                  const modalContent = dom.modalTask ? dom.modalTask.querySelector('.modal-content') : document.querySelector('#modal-task .modal-content');
                  if (modalContent) {
                    modalContent.insertBefore(warningBanner, modalContent.firstChild);
                  }
                }
              }
            }
          } else {
            fetchBoardState();
          }
        }
      } catch (err) { }
    };

    evtSource.onerror = () => {
      if (dom.liveStatus) {
        dom.liveStatus.querySelector('.status-dot').style.backgroundColor = 'var(--accent-yellow)';
      }
    };
  } catch (err) {
    console.warn('SSE not supported:', err);
  }
}

// --- Rendering Logic ---
function renderApp() {
  if (!state.board) return;

  const todoTasks = state.tasks.filter((t) => t.status === 'todo');
  const inProgressTasks = state.tasks.filter((t) => t.status === 'in-progress');

  // Multi-line Cheeky Greeting with Word-by-Word Hover Effects
  const greetingHTML = getCheekyGreeting(todoTasks.length, inProgressTasks.length);
  if (dom.heroGreeting) dom.heroGreeting.innerHTML = wrapWordsInSpans(greetingHTML);
  if (dom.headerGreetingText) dom.headerGreetingText.innerHTML = wrapWordsInSpans(formatHeaderGreeting(greetingHTML));

  // Workload Badge Text
  if (dom.heroWorkloadBadge) {
    dom.heroWorkloadBadge.innerHTML = `<span class="highlight-blue">${todoTasks.length}</span> in todo • <span class="highlight-blue">${inProgressTasks.length}</span> in progress`;
  }

  // Counters
  dom.taskCounter.innerHTML = `<span class="highlight-blue">${state.tasks.length}</span> tasks`;
  dom.projectCounter.innerHTML = `<span class="highlight-blue">${state.projects.length}</span> projects`;
  dom.extensionCounter.innerHTML = `<span class="highlight-blue">${state.extensions.length}</span> extensions`;

  // Update Selects & Navigation
  updateProjectSelects();
  updateHeaderProjectDisplay();

  // Kanban Columns
  renderKanbanColumns();
}

function updateHeaderProjectDisplay() {
  if (!dom.currentProjectTitle) return;
  if (!state.filterProject) {
    dom.currentProjectTitle.textContent = 'all projects';
  } else {
    const proj = state.projects.find((p) => p.id === state.filterProject);
    const title = proj ? (proj.name || proj.id) : state.filterProject;
    dom.currentProjectTitle.textContent = title.toLowerCase();
  }
}

function renderAdwParamInputs(project, adwId, existingValues = null) {
  if (!dom.taskAdwParamsContainer) return;
  dom.taskAdwParamsContainer.innerHTML = '';

  const adw = project && (project.adws || []).find((a) => a.id === adwId);
  const params = (adw && adw.parameters) || [];

  params.forEach((p) => {
    const existing = existingValues && existingValues[p.name] !== undefined ? existingValues[p.name] : p.default;

    const wrapper = document.createElement('div');
    wrapper.className = 'form-group';

    const label = document.createElement('label');
    label.textContent = p.label || p.name;
    wrapper.appendChild(label);

    const input = document.createElement('input');
    input.className = 'form-input';
    input.dataset.paramName = p.name;

    if (p.type === 'boolean') {
      input.type = 'checkbox';
      input.checked = !!existing;
    } else {
      input.type = p.type === 'number' ? 'number' : 'text';
      if (existing !== undefined && existing !== null) input.value = existing;
    }

    wrapper.appendChild(input);
    dom.taskAdwParamsContainer.appendChild(wrapper);
  });
}

function updateAdwSelectForProject(projectId, selectedAdw = null, existingValues = null) {
  if (!dom.taskAdwInput) return;
  dom.taskAdwInput.innerHTML = '';

  const proj = state.projects.find((p) => p.id === projectId) || state.projects[0];
  const adws = (proj && proj.adws) || [];

  // A task's ADW is optional — a project with none (or a task that opts out)
  // is a plain, non-agentic checklist item, not an error state. Always offer
  // that choice explicitly rather than fabricating fake workflow options.
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = adws.length === 0 ? 'no workflow (this project has none registered)' : 'no workflow (manual task)';
  dom.taskAdwInput.appendChild(noneOpt);

  adws.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.id;
    dom.taskAdwInput.appendChild(opt);
  });

  if (selectedAdw && adws.some((a) => a.id === selectedAdw)) {
    dom.taskAdwInput.value = selectedAdw;
  } else if (adws[0]) {
    dom.taskAdwInput.value = adws[0].id;
  } else {
    dom.taskAdwInput.value = '';
  }

  renderAdwParamInputs(proj, dom.taskAdwInput.value, existingValues);
}

function updateProjectSelects() {
  const currentFilterVal = dom.projectFilterSelect.value;
  dom.projectFilterSelect.innerHTML = '<option value="">All Projects</option>';
  dom.taskProjectInput.innerHTML = '';

  state.projects.forEach((p) => {
    const label = p.name && p.name !== p.id ? `${p.name} [${p.id}]` : p.id;

    const optFilter = document.createElement('option');
    optFilter.value = p.id;
    optFilter.textContent = label;
    dom.projectFilterSelect.appendChild(optFilter);

    const optTask = document.createElement('option');
    optTask.value = p.id;
    optTask.textContent = label;
    dom.taskProjectInput.appendChild(optTask);
  });

  dom.projectFilterSelect.value = currentFilterVal;

  if (state.projects.length > 0 && !dom.taskProjectInput.value) {
    dom.taskProjectInput.value = state.projects[0].id;
  }
  updateAdwSelectForProject(dom.taskProjectInput.value);
}

function renderProjectsList() {
  dom.projectsContainer.innerHTML = '';
  if (state.projects.length === 0) {
    dom.projectsContainer.innerHTML = '<p style="color: var(--text-dim);">No projects registered yet.</p>';
    return;
  }

  const query = (dom.projectSearchInput ? dom.projectSearchInput.value : '').trim().toLowerCase();
  const visible = query
    ? state.projects.filter((p) =>
        [p.name || '', p.id || '', p.path || ''].some((field) => field.toLowerCase().includes(query))
      )
    : state.projects;

  if (visible.length === 0) {
    dom.projectsContainer.innerHTML = `<p style="color: var(--text-dim);">No projects match "${escapeHTML(query)}".</p>`;
    return;
  }

  visible.forEach((p) => {
    const adwSummary = (p.adws || []).map((a) => a.id).join(', ');
    const div = document.createElement('div');
    div.className = 'item-card-row project-row';
    div.dataset.projectId = p.id;
    div.innerHTML = `
      <div>
        <strong>${escapeHTML(p.name || p.id)}</strong> <span style="font-size: 0.75rem; color: var(--accent-cyan); font-family: var(--font-mono);">[prefix: ${escapeHTML(p.id)}]</span>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(p.path)}</div>
      </div>
      <span class="tag-badge tag-project">ADWs: ${escapeHTML(adwSummary || 'none')}</span>
    `;
    dom.projectsContainer.appendChild(div);
  });

  if (window.ProjectView) window.ProjectView.bindProjectRows(dom.projectsContainer);
}

// --- Document Upload (task modal) ---
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setDocUploadStatus(message, kind = '') {
  if (!dom.docUploadStatus) return;
  dom.docUploadStatus.textContent = message;
  dom.docUploadStatus.className = `doc-upload-status ${kind}`.trim();
}

function currentDocProjectId() {
  return dom.taskProjectInput ? dom.taskProjectInput.value : '';
}

function renderDocList(docs) {
  if (!dom.docList) return;
  dom.docList.innerHTML = '';
  docs.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'doc-list-item';
    const name = document.createElement('span');
    name.textContent = d.filename;
    const size = document.createElement('span');
    size.className = 'doc-size';
    size.textContent = formatFileSize(d.size || 0);
    row.appendChild(name);
    row.appendChild(size);
    dom.docList.appendChild(row);
  });
}

async function refreshDocList() {
  if (!dom.docList) return;
  const projectId = currentDocProjectId();
  if (dom.docUploadTarget) {
    dom.docUploadTarget.textContent = projectId ? `→ ${projectId}/documents` : '';
  }
  if (!projectId) {
    renderDocList([]);
    return;
  }
  try {
    const docs = await apiCall(`/api/v1/projects/${encodeURIComponent(projectId)}/documents`);
    renderDocList(Array.isArray(docs) ? docs : []);
  } catch (err) {
    renderDocList([]);
  }
}

async function uploadDocuments(files) {
  if (!files || files.length === 0) return;
  const projectId = currentDocProjectId();
  if (!projectId) {
    setDocUploadStatus('select a project first', 'error');
    return;
  }

  const form = new FormData();
  Array.from(files).forEach((f) => form.append('files', f));

  setDocUploadStatus(`uploading ${files.length} file(s)…`);
  try {
    // Raw fetch, not apiCall — FormData must keep its multipart boundary.
    const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/documents`, {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    const stored = data.data || [];
    setDocUploadStatus(`uploaded ${stored.length} file(s)`, 'success');
    await refreshDocList();
  } catch (err) {
    setDocUploadStatus(err.message || 'upload failed', 'error');
  }
  if (dom.docUploadInput) dom.docUploadInput.value = '';
}

function renderKanbanColumns() {
  dom.kanbanCanvas.innerHTML = '';
  const taskMap = new Map(state.tasks.map((t) => [t.id, t]));

  dom.taskStatusInput.innerHTML = '';
  state.board.columns.filter((c) => c.id !== ARCHIVED_COLUMN_ID).forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    dom.taskStatusInput.appendChild(opt);
  });

  state.board.columns.filter((column) => column.id !== ARCHIVED_COLUMN_ID).forEach((column) => {
    const colEl = document.createElement('div');
    colEl.className = 'kanban-column';
    colEl.dataset.columnId = column.id;

    const orderedIds = state.board.task_order[column.id] || [];
    let columnTasks = orderedIds
      .map((id) => taskMap.get(id))
      .filter((t) => t !== undefined);

    state.tasks.forEach((t) => {
      if (t.status === column.id && !orderedIds.includes(t.id)) {
        columnTasks.push(t);
      }
    });

    if (state.filterProject) {
      columnTasks = columnTasks.filter((t) => t.project === state.filterProject);
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      columnTasks = columnTasks.filter(
        (t) =>
          (t.name && t.name.toLowerCase().includes(q)) ||
          (t.title && t.title.toLowerCase().includes(q)) ||
          (t.description && t.description.toLowerCase().includes(q)) ||
          t.id.toLowerCase().includes(q)
      );
    }

    colEl.innerHTML = `
      <div class="column-header">
        <div class="column-title-group">
          <h2 class="column-title">${escapeHTML(column.name)}</h2>
          <span class="column-badge">${columnTasks.length}</span>
        </div>
        <div class="column-actions">
          <button class="icon-btn btn-delete-col" title="Archive all tasks in this column" data-col-id="${column.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="column-cards-container" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.column-cards-container');

    columnTasks.forEach((task) => {
      const cardEl = createCardElement(task);
      cardsContainer.appendChild(cardEl);
    });

    colEl.addEventListener('dragover', handleDragOver);
    colEl.addEventListener('dragleave', handleDragLeave);
    colEl.addEventListener('drop', handleDrop);

    const btnDel = colEl.querySelector('.btn-delete-col');
    btnDel.addEventListener('click', async (e) => {
      e.stopPropagation();
      const count = columnTasks.length;
      const what = count === 1 ? '1 task' : `${count} tasks`;
      if (confirm(`Archive ${what} in "${column.name}"? The column stays — its tasks move to Archived Tasks and can be restored from there.`)) {
        await apiCall(`/api/v1/columns/${column.id}/archive`, 'POST');
        fetchBoardState();
      }
    });

    dom.kanbanCanvas.appendChild(colEl);
  });
}

function createCardElement(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.draggable = true;
  card.dataset.taskId = task.id;

  const projectBadge = task.project
    ? `<span class="tag-badge tag-project">${escapeHTML(task.project)}</span>`
    : '';

  const adwBadge = task.adw
    ? `<span class="tag-badge tag-agent">workflow: ${escapeHTML(task.adw)}</span>`
    : '';

  const displayName = task.name || task.title;

  card.innerHTML = `
    <div class="card-header">
      <span class="task-id-tag">${escapeHTML(task.id)}</span>
    </div>
    <div class="card-title">${escapeHTML(displayName)}</div>
    ${task.description ? `<div class="card-desc">${escapeHTML(task.description)}</div>` : ''}
    <div class="card-footer">
      ${projectBadge}
      ${adwBadge}
    </div>
  `;

  let dragStartX = 0;
  let dragStartY = 0;
  let hasDraggedDistance = false;

  card.addEventListener('dragstart', (e) => {
    state.isDraggingCard = true;
    hasDraggedDistance = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';

    if (dragPlaceholder && dragPlaceholder.parentNode) {
      dragPlaceholder.parentNode.removeChild(dragPlaceholder);
    }
    dragPlaceholder = null;

    setTimeout(() => {
      card.classList.add('dragging');
      dragPlaceholder = document.createElement('div');
      dragPlaceholder.className = 'drop-placeholder';
      dragPlaceholder.style.height = `${card.offsetHeight}px`;
    }, 0);
  });

  card.addEventListener('drag', (e) => {
    if (e.clientX !== 0 || e.clientY !== 0) {
      const dist = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
      if (dist > 5) {
        hasDraggedDistance = true;
      }
    }
  });

  card.addEventListener('dragend', () => {
    state.isDraggingCard = false;
    card.classList.remove('dragging');
    if (dragPlaceholder && dragPlaceholder.parentNode) {
      dragPlaceholder.parentNode.removeChild(dragPlaceholder);
    }
    dragPlaceholder = null;
    document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('drag-over'));
    if (hasDraggedDistance) {
      ignoreCardClick = true;
      setTimeout(() => {
        ignoreCardClick = false;
      }, 100);
    }
  });

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ignoreCardClick) {
      ignoreCardClick = false;
      return;
    }
    openTaskModal(task);
  });

  return card;
}

// --- Board Expansion & Collapse Controller ---
function expandBoard() {
  state.isExpanded = true;
  dom.app.classList.add('board-expanded');
  if (dom.headerGreetingText) dom.headerGreetingText.classList.remove('hidden');
  if (dom.btnCollapseBoard) dom.btnCollapseBoard.classList.remove('hidden');
  if (dom.fabAddTask) dom.fabAddTask.classList.remove('hidden');
}

function collapseBoard() {
  state.isExpanded = false;
  dom.app.classList.remove('board-expanded');
  if (dom.headerGreetingText) dom.headerGreetingText.classList.add('hidden');
  if (dom.btnCollapseBoard) dom.btnCollapseBoard.classList.add('hidden');
  if (dom.fabAddTask) dom.fabAddTask.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Drag and Drop Handlers ---
let dragPlaceholder = null;
let ignoreCardClick = false;

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const column = e.currentTarget;
  column.classList.add('drag-over');

  if (!dragPlaceholder) return;

  const cardsContainer = column.querySelector('.column-cards-container');
  const cards = Array.from(cardsContainer.querySelectorAll('.task-card:not(.dragging)'));

  let targetCard = null;
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    const midY = box.top + box.height / 2;
    if (e.clientY < midY) {
      targetCard = cards[i];
      break;
    }
  }

  if (targetCard) {
    cardsContainer.insertBefore(dragPlaceholder, targetCard);
  } else {
    cardsContainer.appendChild(dragPlaceholder);
  }
}

function handleDragLeave(e) {
  const column = e.currentTarget;
  if (column.contains(e.relatedTarget)) {
    return;
  }
  column.classList.remove('drag-over');
}

async function handleDrop(e) {
  e.preventDefault();
  const column = e.currentTarget;
  column.classList.remove('drag-over');

  const taskId = e.dataTransfer.getData('text/plain');
  const targetColId = column.dataset.columnId || column.querySelector('[data-column-id]')?.dataset.columnId;

  if (!taskId || !targetColId) {
    state.isDraggingCard = false;
    ignoreCardClick = false;
    return;
  }

  const cardsContainer = column.querySelector('.column-cards-container');

  let targetIndex = 0;
  if (dragPlaceholder && dragPlaceholder.parentNode === cardsContainer) {
    const children = Array.from(cardsContainer.children);
    const validChildren = children.filter(c => c !== document.querySelector('.task-card.dragging'));
    targetIndex = validChildren.indexOf(dragPlaceholder);
  } else {
    targetIndex = cardsContainer.querySelectorAll('.task-card').length;
  }

  if (dragPlaceholder && dragPlaceholder.parentNode) {
    dragPlaceholder.parentNode.removeChild(dragPlaceholder);
  }
  dragPlaceholder = null;

  const task = state.tasks.find((t) => t.id === taskId);
  if (task) {
    const oldStatus = task.status;
    task.status = targetColId;

    if (state.board && state.board.task_order) {
      if (state.board.task_order[oldStatus]) {
        state.board.task_order[oldStatus] = state.board.task_order[oldStatus].filter((id) => id !== taskId);
      }
      if (!state.board.task_order[targetColId]) {
        state.board.task_order[targetColId] = [];
      }
      state.board.task_order[targetColId] = state.board.task_order[targetColId].filter((id) => id !== taskId);
      state.board.task_order[targetColId].splice(targetIndex, 0, taskId);
    }

    renderKanbanColumns();
  }

  state.isDraggingCard = false;
  ignoreCardClick = true;
  setTimeout(() => {
    ignoreCardClick = false;
  }, 100);

  try {
    await apiCall(`/api/v1/tasks/${taskId}/move`, 'POST', {
      target_status: targetColId,
      target_index: targetIndex
    });
  } catch (err) {
    console.error('Error moving task:', err);
    fetchBoardState();
  }
}

// 'todo' is the conventional landing column for new tasks regardless of
// display order — e.g. 'failed' is pinned leftmost for triage visibility,
// but that's not where a brand-new task should default to.
function defaultTaskStatusId() {
  const cols = (state.board && state.board.columns) || [];
  const todo = cols.find((c) => c.id === 'todo');
  return (todo || cols[0] || {}).id || 'todo';
}

function showTaskFormError(message) {
  clearTaskFormError();
  const banner = document.createElement('div');
  banner.id = 'task-form-error';
  banner.className = 'error-bar';
  banner.textContent = message;
  dom.formTask.insertBefore(banner, dom.formTask.firstChild);
}

function clearTaskFormError() {
  const existing = document.getElementById('task-form-error');
  if (existing) existing.remove();
}

// --- Modals Controller ---
// A resizable box (textarea, .mde-wrap) only ever resizes itself — CSS
// `resize` has no way to make an ancestor follow along. Without this, widening
// one past its modal's current width just makes .modal-body scroll
// horizontally, leaving the box detached from the rest of the form. Grows the
// modal-card (never shrinks it back — the user resized on purpose) whenever
// the box's right edge would otherwise spill past the card's own edge.
// ResizeObserver doesn't exist in jsdom, so this silently no-ops in tests —
// consistent with how the resize:both behavior itself isn't unit-testable
// (see BROWSER_TESTS.md's RZ-* notes).
function bindResizeGrowsModal(resizableEl, modalCardEl) {
  if (typeof ResizeObserver === 'undefined' || !resizableEl || !modalCardEl) return () => {};
  const EDGE_MARGIN = 24;
  const ro = new ResizeObserver(() => {
    const boxRect = resizableEl.getBoundingClientRect();
    const cardRect = modalCardEl.getBoundingClientRect();
    const overflow = boxRect.right - (cardRect.right - EDGE_MARGIN);
    if (overflow > 1) {
      modalCardEl.style.maxWidth = 'none';
      modalCardEl.style.width = Math.ceil(cardRect.width + overflow) + 'px';
    }
  });
  ro.observe(resizableEl);
  return () => ro.disconnect();
}

function openTaskModal(task = null) {
  clearTaskFormError();
  updateProjectSelects();

  if (task) {
    document.getElementById('task-modal-title').textContent = `edit task — ${task.id}`;
    dom.taskIdInput.value = task.id;
    dom.taskTitleInput.value = task.name || task.title || '';
    dom.taskProjectInput.value = task.project || (state.projects[0]?.id || 'tasks');
    updateAdwSelectForProject(dom.taskProjectInput.value, task.adw, task.parameter_values || null);
    dom.taskStatusInput.value = task.status || defaultTaskStatusId();
    dom.taskDescInput.value = task.description || '';
    dom.btnDeleteTask.classList.remove('hidden');

    if (dom.taskWorkflowSection) {
      if (task.adw) {
        dom.taskWorkflowSection.classList.remove('hidden');
        startTaskTracePolling(task.id);
      } else {
        dom.taskWorkflowSection.classList.add('hidden');
        stopTaskTracePolling();
      }
    }
  } else {
    document.getElementById('task-modal-title').textContent = 'new task';
    dom.formTask.reset();
    dom.taskIdInput.value = '';
    if (state.projects.length > 0) {
      dom.taskProjectInput.value = state.projects[0].id;
    }
    updateAdwSelectForProject(dom.taskProjectInput.value);
    dom.taskStatusInput.value = defaultTaskStatusId();
    dom.btnDeleteTask.classList.add('hidden');

    if (dom.taskWorkflowSection) dom.taskWorkflowSection.classList.add('hidden');
    stopTaskTracePolling();
  }

  setDocUploadStatus('');
  refreshDocList();
  if (window.MarkdownEditor) {
    const mdHandle = window.MarkdownEditor.attach(dom.taskDescInput);
    // .value was assigned programmatically above, which fires no input event.
    window.MarkdownEditor.refresh(dom.taskDescInput);
    if (mdHandle && mdHandle.wrapper && !mdHandle.wrapper.__growBound) {
      mdHandle.wrapper.__growBound = true;
      bindResizeGrowsModal(mdHandle.wrapper, dom.modalTask.querySelector('.modal-card'));
    }
  }

  dom.modalTask.classList.remove('hidden');
  dom.taskTitleInput.focus();
}

function openColumnModal() {
  dom.formColumn.reset();
  dom.modalColumn.classList.remove('hidden');
}

function openProjectsModal() {
  renderProjectsList();
  dom.modalProjects.classList.remove('hidden');
}

function openExtensionsModal() {
  renderExtensionsList();
  dom.modalExtensions.classList.remove('hidden');
}

function openArchiveModal() {
  renderArchivedList();
  dom.modalArchived.classList.remove('hidden');
}

function renderArchivedList() {
  dom.archivedContainer.innerHTML = '';
  const archived = state.tasks.filter((t) => t.status === ARCHIVED_COLUMN_ID);
  if (archived.length === 0) {
    dom.archivedContainer.innerHTML = '<p style="color: var(--text-dim);">No archived tasks.</p>';
    return;
  }
  const restoreTargets = (state.board.columns || []).filter((c) => c.id !== ARCHIVED_COLUMN_ID);
  archived
    .slice()
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .forEach((task) => {
      const div = document.createElement('div');
      div.className = 'item-card-row';
      const projectLabel = task.project ? `[${escapeHTML(task.project)}] ` : '';
      const archivedAt = task.updated_at ? new Date(task.updated_at).toLocaleString() : '';
      div.innerHTML = `
        <div>
          <strong>${escapeHTML(task.name || task.title || task.id)}</strong>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${projectLabel}archived ${escapeHTML(archivedAt)}</div>
        </div>
        <div class="archived-restore-group">
          <select class="form-input archived-restore-select"></select>
          <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;">restore</button>
        </div>
      `;
      const select = div.querySelector('.archived-restore-select');
      restoreTargets.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      const restoreBtn = div.querySelector('button');
      restoreBtn.addEventListener('click', async () => {
        restoreBtn.disabled = true;
        try {
          await apiCall('/api/v1/command', 'POST', { type: 'move_task', payload: { id: task.id, target_status: select.value } });
          await fetchBoardState();
          renderArchivedList();
        } catch (e) {
          restoreBtn.disabled = false;
          alert(`Failed to restore: ${(e && e.message) || e}`);
        }
      });
      dom.archivedContainer.appendChild(div);
    });
}

function renderExtensionsList() {
  dom.extensionsContainer.innerHTML = '';
  if (state.extensions.length === 0) {
    dom.extensionsContainer.innerHTML = '<p style="color: var(--text-dim);">No extensions registered yet.</p>';
    return;
  }
  state.extensions.forEach((e) => {
    const div = document.createElement('div');
    div.className = 'item-card-row';
    div.innerHTML = `
      <div>
        <strong>${escapeHTML(e.id)}</strong> [${escapeHTML(e.type)}]
        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(e.url)}</div>
      </div>
      <a href="${escapeHTML(e.url)}" target="_blank" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;">open ↗</a>
    `;
    dom.extensionsContainer.appendChild(div);
  });
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
  if (modalId === 'modal-task') stopTaskTracePolling();
  fetchBoardState();
}

// --- Event Listeners ---
function setupEventListeners() {
  setupProximityTextEffect();

  if (dom.taskProjectInput) {
    dom.taskProjectInput.addEventListener('change', () => {
      updateAdwSelectForProject(dom.taskProjectInput.value);
      setDocUploadStatus('');
      refreshDocList();
    });
  }

  if (dom.docUploadInput) {
    dom.docUploadInput.addEventListener('change', () => {
      uploadDocuments(dom.docUploadInput.files);
    });
  }

  if (dom.docUploadBox) {
    ['dragenter', 'dragover'].forEach((evt) => {
      dom.docUploadBox.addEventListener(evt, (e) => {
        e.preventDefault();
        dom.docUploadBox.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dom.docUploadBox.addEventListener(evt, (e) => {
        e.preventDefault();
        dom.docUploadBox.classList.remove('dragover');
      });
    });
    dom.docUploadBox.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) uploadDocuments(e.dataTransfer.files);
    });
  }

  if (dom.projectSearchInput) {
    dom.projectSearchInput.addEventListener('input', () => {
      renderProjectsList();
    });
  }

  if (dom.taskAdwInput) {
    dom.taskAdwInput.addEventListener('change', () => {
      const proj = state.projects.find((p) => p.id === dom.taskProjectInput.value);
      renderAdwParamInputs(proj, dom.taskAdwInput.value);
    });
  }

  window.addEventListener('mouseup', () => {
    if (state.isDraggingCard) {
      state.isDraggingCard = false;
    }
  });

  document.addEventListener('mousemove', requestActivityUpdate);
  document.addEventListener('pointerdown', requestActivityUpdate);
  window.addEventListener('focus', () => fetchBoardState());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchBoardState();
  });

  if (dom.btnCollapseBoard) {
    dom.btnCollapseBoard.addEventListener('click', collapseBoard);
  }

  // Scroll / Wheel trigger for one-way transition to expanded board
  window.addEventListener('scroll', () => {
    if (window.scrollY > 30 && !state.isExpanded) {
      expandBoard();
    }
  });

  window.addEventListener('wheel', (e) => {
    if (e.deltaY > 20 && !state.isExpanded) {
      expandBoard();
    }
  });

  if (dom.fabAddTask) {
    dom.fabAddTask.addEventListener('click', () => openTaskModal());
  }

  // Project Selector
  if (dom.btnProjectReset) {
    dom.btnProjectReset.addEventListener('click', () => {
      state.filterProject = '';
      dom.projectFilterSelect.value = '';
      updateHeaderProjectDisplay();
      renderKanbanColumns();
    });
  }

  if (dom.btnProjectNext) {
    dom.btnProjectNext.addEventListener('click', () => {
      if (state.projects.length === 0) return;

      const projectIds = ['', ...state.projects.map((p) => p.id)];
      const currentIdx = projectIds.indexOf(state.filterProject);
      const nextIdx = (currentIdx + 1) % projectIds.length;

      state.filterProject = projectIds[nextIdx];
      dom.projectFilterSelect.value = state.filterProject;
      updateHeaderProjectDisplay();
      renderKanbanColumns();
    });
  }

  // Hamburger Menu
  if (dom.btnHamburger) {
    dom.btnHamburger.addEventListener('click', (e) => {
      e.stopPropagation();
      dom.hamburgerDropdown.classList.toggle('hidden');
    });
  }

  document.addEventListener('click', (e) => {
    if (dom.hamburgerDropdown && !dom.hamburgerDropdown.contains(e.target) && e.target !== dom.btnHamburger) {
      dom.hamburgerDropdown.classList.add('hidden');
    }
  });

  if (dom.menuHero) {
    dom.menuHero.addEventListener('click', () => {
      dom.hamburgerDropdown.classList.add('hidden');
      collapseBoard();
    });
  }

  if (dom.menuSearch) {
    dom.menuSearch.addEventListener('click', () => {
      dom.hamburgerDropdown.classList.add('hidden');
      dom.searchOverlay.classList.remove('hidden');
      dom.searchInput.focus();
    });
  }

  document.getElementById('btn-projects').addEventListener('click', () => {
    dom.hamburgerDropdown.classList.add('hidden');
    openProjectsModal();
  });
  document.getElementById('btn-extensions').addEventListener('click', () => {
    dom.hamburgerDropdown.classList.add('hidden');
    openExtensionsModal();
  });
  document.getElementById('btn-archived-tasks').addEventListener('click', () => {
    dom.hamburgerDropdown.classList.add('hidden');
    openArchiveModal();
  });
  document.getElementById('btn-add-column').addEventListener('click', () => {
    dom.hamburgerDropdown.classList.add('hidden');
    openColumnModal();
  });
  if (dom.btnTogglePreview) {
    dom.btnTogglePreview.addEventListener('click', () => {
      dom.hamburgerDropdown.classList.add('hidden');
      toggleWorkflowPreview();
    });
  }
  if (dom.btnClosePreview) {
    dom.btnClosePreview.addEventListener('click', closeWorkflowPreview);
  }

  // Task Workflow Start/Stop
  if (dom.btnStartTask) {
    dom.btnStartTask.addEventListener('click', async () => {
      const id = dom.taskIdInput.value;
      if (!id) return;
      dom.btnStartTask.disabled = true;
      try {
        await apiCall(`/api/v1/tasks/${id}/start`, 'POST');
        await pollTaskTrace(id);
      } catch (err) {
        alert(`Failed to start workflow: ${err.message}`);
      } finally {
        dom.btnStartTask.disabled = false;
      }
    });
  }
  if (dom.btnStopTask) {
    dom.btnStopTask.addEventListener('click', async () => {
      const id = dom.taskIdInput.value;
      if (!id) return;
      dom.btnStopTask.disabled = true;
      try {
        await apiCall(`/api/v1/tasks/${id}/stop`, 'POST');
        await pollTaskTrace(id);
      } catch (err) {
        alert(`Failed to stop workflow: ${err.message}`);
      } finally {
        dom.btnStopTask.disabled = false;
      }
    });
  }

  // Mini-gantt preview (task modal) opens the full trace for the open task.
  if (dom.taskTracePanel) {
    dom.taskTracePanel.addEventListener('click', () => {
      const id = dom.taskIdInput.value;
      if (!id || !dom.taskTracePanel.querySelector('[data-open-trace]')) return;
      const task = state.tasks.find((t) => t.id === id);
      AgenticTrace.open(id, taskDisplayName(task));
    });
  }

  // Workflow Preview drawer cards each open the full trace for their run.
  if (dom.previewDrawerBody) {
    dom.previewDrawerBody.addEventListener('click', (e) => {
      const card = e.target.closest('[data-open-trace-task]');
      if (!card) return;
      AgenticTrace.open(card.dataset.openTraceTask, card.dataset.openTraceName);
    });
  }

  // Close modals
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Task Form Submit
  dom.formTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTaskFormError();
    const id = dom.taskIdInput.value;
    const taskName = dom.taskTitleInput.value.trim();

    const parameterValues = {};
    if (dom.taskAdwParamsContainer) {
      dom.taskAdwParamsContainer.querySelectorAll('[data-param-name]').forEach((input) => {
        const name = input.dataset.paramName;
        if (input.type === 'checkbox') {
          parameterValues[name] = input.checked;
        } else if (input.type === 'number') {
          if (input.value !== '') parameterValues[name] = Number(input.value);
        } else if (input.value !== '') {
          parameterValues[name] = input.value;
        }
      });
    }

    const payload = {
      name: taskName,
      title: taskName,
      status: dom.taskStatusInput.value,
      project: dom.taskProjectInput.value,
      adw: dom.taskAdwInput.value,
      description: dom.taskDescInput.value.trim(),
      parameter_values: parameterValues
    };

    try {
      if (id) {
        await apiCall(`/api/v1/tasks/${id}`, 'PUT', payload);
      } else {
        await apiCall('/api/v1/tasks', 'POST', payload);
      }
      closeModal('modal-task');
      fetchBoardState();
    } catch (err) {
      showTaskFormError(err.message || 'Failed to save task');
    }
  });

  // Task Delete Button
  dom.btnDeleteTask.addEventListener('click', async () => {
    const id = dom.taskIdInput.value;
    if (id && confirm(`Delete task ${id}?`)) {
      await apiCall(`/api/v1/tasks/${id}`, 'DELETE');
      closeModal('modal-task');
      fetchBoardState();
    }
  });

  // Column Form Submit
  dom.formColumn.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('column-id-input').value.trim();
    const name = document.getElementById('column-name-input').value.trim();
    if (id && name) {
      await apiCall('/api/v1/columns', 'POST', { id, name });
      closeModal('modal-column');
      fetchBoardState();
    }
  });

  // Project Form Submit
  dom.formProject.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('project-name-field').value.trim();
    const id = document.getElementById('project-id-field').value.trim() || name;
    const path = document.getElementById('project-path-field').value.trim();
    if (id && path) {
      await apiCall('/api/v1/projects', 'POST', { id, name, path });
      document.getElementById('project-name-field').value = '';
      document.getElementById('project-id-field').value = '';
      document.getElementById('project-path-field').value = '';
      await fetchBoardState();
      renderProjectsList();
    }
  });

  // Extension Form Submit
  dom.formExtension.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('ext-id-field').value.trim();
    const type = document.getElementById('ext-type-field').value.trim();
    const url = document.getElementById('ext-url-field').value.trim();
    if (id && type && url) {
      await apiCall('/api/v1/extensions', 'POST', { id, type, url });
      document.getElementById('ext-id-field').value = '';
      document.getElementById('ext-type-field').value = '';
      document.getElementById('ext-url-field').value = '';
      await fetchBoardState();
      renderExtensionsList();
    }
  });

  // Search Input
  dom.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderKanbanColumns();
  });

  // Project Filter Select
  dom.projectFilterSelect.addEventListener('change', (e) => {
    state.filterProject = e.target.value;
    updateHeaderProjectDisplay();
    renderKanbanColumns();
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if (e.key === 'Escape') {
      closeModal('modal-task');
      closeModal('modal-column');
      closeModal('modal-projects');
      closeModal('modal-extensions');
      closeWorkflowPreview();
      dom.searchOverlay.classList.add('hidden');
    } else if (!isInput && e.key === '/') {
      e.preventDefault();
      dom.searchOverlay.classList.remove('hidden');
      dom.searchInput.focus();
    } else if (!isInput && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      openTaskModal();
    }
  });
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Initial Boot
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initLiveClock();
  fetchBoardState();
  initSSE();
});

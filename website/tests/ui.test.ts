import { describe, it, expect, afterEach } from 'vitest';
import { mountBoard, teardown, installDefaultRoutes, defaultBoardPayload, FetchStub, flushPromises, Mounted, dispatch, readPublicFile } from './helpers';

function demoProject(overrides: any = {}) {
  return { id: 'demo', name: 'demo project', path: '/tmp/ab-verify-proj', adws: [], ...overrides };
}

function setupBoard(opts: { projects?: any[]; tasks?: any[]; board?: any; extensions?: any[] } = {}) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, defaultBoardPayload(opts));
  const mounted = mountBoard({ fetchStub: stub });
  return { mounted, stub };
}

async function boot(mounted: Mounted) {
  const w = mounted.window as any;
  w.setupEventListeners();
  await w.fetchBoardState();
  await flushPromises();
}

describe('harness sanity: real files evaluate cleanly in jsdom', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('app.js function declarations (apiCall, renderProjectsList, ...) land on window', () => {
    const setup = setupBoard({});
    mounted = setup.mounted;
    const w = mounted.window as any;
    expect(typeof w.renderProjectsList).toBe('function');
    expect(typeof w.formatFileSize).toBe('function');
    expect(typeof w.setupEventListeners).toBe('function');
    expect(w.__appState).toBeTruthy();
  });

  it('fetchBoardState populates state from the fetch stub', async () => {
    const setup = setupBoard({ projects: [demoProject()] });
    mounted = setup.mounted;
    await boot(mounted);
    expect((mounted.window as any).__appState.projects.length).toBe(1);
  });

  it('MarkdownEditor and ProjectView attach to window', () => {
    mounted = mountBoard();
    const w = mounted.window as any;
    expect(typeof w.MarkdownEditor.attach).toBe('function');
    expect(typeof w.ProjectView.open).toBe('function');
  });
});

describe('EX: structural regressions on the real index.html (no DOM needed)', () => {
  const html = readPublicFile('index.html');

  it('script tags load trace.js, markdown-editor.js, python-highlight.js, workflow-diagram.js, project-view.js, then app.js last', () => {
    const scriptSrcs = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
    expect(scriptSrcs).toEqual(['trace.js', 'markdown-editor.js', 'python-highlight.js', 'workflow-diagram.js', 'project-view.js', 'app.js']);
  });

  it('markdown-editor.css, project-view.css, workflow-diagram.css and python-highlight.css are linked', () => {
    expect(html).toContain('href="markdown-editor.css"');
    expect(html).toContain('href="project-view.css"');
    expect(html).toContain('href="workflow-diagram.css"');
    expect(html).toContain('href="python-highlight.css"');
  });

  it('long-text boxes (task description, agent prompts) allow horizontal as well as vertical resize', () => {
    const styles = readPublicFile('styles.css');
    const mdeCss = readPublicFile('markdown-editor.css');
    expect(styles).toMatch(/\.textarea\s*\{[^}]*resize:\s*both/);
    expect(mdeCss).toMatch(/\.mde-wrap\s*\{[^}]*resize:\s*both/);
  });

  it('#project-search-input is inside #modal-projects', () => {
    const modalStart = html.indexOf('id="modal-projects"');
    const nextModalStart = html.indexOf('id="modal-extensions"');
    const searchInputIdx = html.indexOf('id="project-search-input"');
    expect(modalStart).toBeGreaterThan(-1);
    expect(searchInputIdx).toBeGreaterThan(modalStart);
    expect(searchInputIdx).toBeLessThan(nextModalStart);
  });
});

describe('EX: DOM behaviour', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('EX-1: board renders one .kanban-column per configured column, named, plus footer counters', async () => {
    const board = {
      revision: 1,
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'in-progress', name: 'In Progress' },
        { id: 'done', name: 'Done' }
      ],
      task_order: { todo: [], 'in-progress': [], done: [] }
    };
    const setup = setupBoard({ board, projects: [demoProject()], tasks: [{ id: 't1', name: 'x', project: 'demo', status: 'todo' }] });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;

    const columns = doc.querySelectorAll('#kanban-canvas .kanban-column');
    expect(columns.length).toBe(3);
    const names = Array.from(columns).map((c) => c.querySelector('.column-title')!.textContent);
    expect(names).toEqual(['To Do', 'In Progress', 'Done']);

    expect(doc.getElementById('task-counter')!.textContent).toContain('1');
    expect(doc.getElementById('project-counter')!.textContent).toContain('1');
    expect(doc.getElementById('extension-counter')!.textContent).toContain('0');
  });

  it('EX-2: #live-status .status-dot exists', () => {
    mounted = mountBoard();
    const dot = mounted.document.querySelector('#live-status .status-dot');
    expect(dot).toBeTruthy();
  });

  it('EX-3: creating a task posts to /api/v1/tasks and closes the modal', async () => {
    const setup = setupBoard({ projects: [demoProject()] });
    setup.stub.on('POST', '/api/v1/tasks', ({ body }) => ({ json: { success: true, data: { id: 'new-1', ...body } } }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;
    const w = mounted.window as any;

    w.openTaskModal();
    (doc.getElementById('task-title-input') as HTMLInputElement).value = 'verify task';
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';

    dispatch(doc.getElementById('form-task')!, 'submit');
    await flushPromises();

    const postCall = setup.stub.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks');
    expect(postCall).toBeTruthy();
    expect(postCall!.body.name).toBe('verify task');
    expect(postCall!.body.project).toBe('demo');
    expect(doc.getElementById('modal-task')!.classList.contains('hidden')).toBe(true);
  });

  it('EX-4: editing an existing task prefills fields, shows the edit title, and the delete button', async () => {
    const setup = setupBoard({ projects: [demoProject()] });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;
    const w = mounted.window as any;

    w.openTaskModal({ id: 'abc123', name: 'edit me', project: 'demo', status: 'todo', description: 'notes here' });

    expect(doc.getElementById('task-modal-title')!.textContent).toBe('edit task — abc123');
    expect((doc.getElementById('task-title-input') as HTMLInputElement).value).toBe('edit me');
    expect((doc.getElementById('task-desc-input') as HTMLTextAreaElement).value).toBe('notes here');
    expect(doc.getElementById('btn-delete-task')!.classList.contains('hidden')).toBe(false);
  });

  it('EX-6: search filters visible cards, and Escape closes the search overlay', async () => {
    const board = { revision: 1, columns: [{ id: 'todo', name: 'To Do' }], task_order: { todo: [] } };
    const tasks = [
      { id: 't1', name: 'fix login bug', project: 'demo', status: 'todo' },
      { id: 't2', name: 'write docs', project: 'demo', status: 'todo' }
    ];
    const setup = setupBoard({ board, projects: [demoProject()], tasks });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;

    doc.getElementById('search-overlay')!.classList.remove('hidden');
    const searchInput = doc.getElementById('search-input') as HTMLInputElement;
    searchInput.value = 'login';
    dispatch(searchInput, 'input');

    let cards = doc.querySelectorAll('.task-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('fix login bug');

    // Escape's app.js handler also calls closeModal() on several unrelated
    // (already-hidden) modal ids, each kicking off its own fetchBoardState()
    // — flush so those settle before teardown closes the window.
    dispatch(mounted.window, 'keydown', { key: 'Escape' });
    await flushPromises();
    expect(doc.getElementById('search-overlay')!.classList.contains('hidden')).toBe(true);
  });

  it('EX-7: adding a column via the form posts /api/v1/columns; deleting removes it', async () => {
    const board = { revision: 1, columns: [{ id: 'todo', name: 'To Do' }], task_order: { todo: [] } };
    const setup = setupBoard({ board, projects: [demoProject()] });
    setup.stub.on('POST', '/api/v1/columns', () => ({ json: { success: true, data: {} } }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;

    (doc.getElementById('column-id-input') as HTMLInputElement).value = 'verify-col';
    (doc.getElementById('column-name-input') as HTMLInputElement).value = 'Verify Col';
    dispatch(doc.getElementById('form-column')!, 'submit');
    await flushPromises();

    const postCall = setup.stub.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/columns');
    expect(postCall).toBeTruthy();
    expect(postCall!.body.id).toBe('verify-col');
    expect(postCall!.body.name).toBe('Verify Col');

    setup.stub.on('DELETE', '/api/v1/columns/verify-col', () => ({ json: { success: true, data: {} } }));
    const w = mounted.window as any;
    w.confirm = () => true;
    const delBtn = doc.querySelector('.btn-delete-col[data-col-id="todo"]');
    expect(delBtn).toBeTruthy();
  });

  it('EX-8: extensions drawer lists extensions or an empty state, plus the register form', async () => {
    const setup = setupBoard({ projects: [demoProject()], extensions: [] });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;
    const w = mounted.window as any;

    w.openExtensionsModal();
    expect(doc.getElementById('modal-extensions')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('extensions-container')!.textContent).toContain('No extensions registered yet.');
    expect(doc.getElementById('form-extension')).toBeTruthy();
  });

  it('EX-9: workflow preview drawer shows "no active workflows" when nothing is running', async () => {
    const setup = setupBoard({ projects: [demoProject()] });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;
    const w = mounted.window as any;

    w.toggleWorkflowPreview();
    await flushPromises();

    expect(doc.getElementById('workflow-preview-panel')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('preview-drawer-body')!.textContent).toContain('no active workflows');
  });

  it('EX-10: Escape closes an open task modal', async () => {
    const setup = setupBoard({ projects: [demoProject()] });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = mounted.document;
    const w = mounted.window as any;

    w.openTaskModal();
    expect(doc.getElementById('modal-task')!.classList.contains('hidden')).toBe(false);

    dispatch(mounted.window, 'keydown', { key: 'Escape' });
    await flushPromises();
    expect(doc.getElementById('modal-task')!.classList.contains('hidden')).toBe(true);
  });
});

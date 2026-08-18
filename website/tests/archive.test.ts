import { describe, it, expect, afterEach } from 'vitest';
import { mountBoard, teardown, installDefaultRoutes, defaultBoardPayload, FetchStub, flushPromises, Mounted, dispatch } from './helpers';

function boardWithTasks() {
  return defaultBoardPayload({
    board: {
      revision: 1,
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'in-progress', name: 'In Progress' },
        { id: 'done', name: 'Done' }
      ],
      task_order: { todo: ['t1', 't2'], 'in-progress': [], done: [] }
    },
    tasks: [
      { id: 't1', name: 'First', status: 'todo', project: 'demo' },
      { id: 't2', name: 'Second', status: 'todo', project: 'demo' }
    ]
  });
}

function setupBoard(payload: any) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, payload);
  const mounted = mountBoard({ fetchStub: stub });
  return { mounted, stub };
}

async function boot(mounted: Mounted) {
  const w = mounted.window as any;
  w.setupEventListeners();
  await w.fetchBoardState();
  await flushPromises();
}

describe('Archive: column trash can archives tasks instead of deleting the column', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('ARC-1: the trash-can button POSTs .../archive (not DELETE) after a confirm dialog', async () => {
    const setup = setupBoard(boardWithTasks());
    setup.stub.on('POST', '/api/v1/columns/todo/archive', () => ({ json: { success: true, data: { archived: ['t1', 't2'] } } }));
    mounted = setup.mounted;
    const w = mounted.window as any;
    let confirmMessage = '';
    w.confirm = (msg: string) => { confirmMessage = msg; return true; };
    await boot(mounted);

    const todoColumn = mounted.document.querySelector('.kanban-column[data-column-id="todo"]') as HTMLElement;
    const trashBtn = todoColumn.querySelector('.btn-delete-col') as HTMLButtonElement;
    dispatch(trashBtn, 'click');
    await flushPromises();

    expect(confirmMessage).toContain('Archive');
    expect(confirmMessage).toContain('2 tasks');
    const archiveCall = setup.stub.calls.find((c) => c.path === '/api/v1/columns/todo/archive');
    expect(archiveCall).toBeTruthy();
    expect(archiveCall!.method).toBe('POST');
    expect(setup.stub.calls.some((c) => c.method === 'DELETE' && c.path.includes('/columns/'))).toBe(false);
  });

  it('ARC-2: declining the confirm dialog sends nothing', async () => {
    const setup = setupBoard(boardWithTasks());
    mounted = setup.mounted;
    const w = mounted.window as any;
    w.confirm = () => false;
    await boot(mounted);

    const todoColumn = mounted.document.querySelector('.kanban-column[data-column-id="todo"]') as HTMLElement;
    const trashBtn = todoColumn.querySelector('.btn-delete-col') as HTMLButtonElement;
    dispatch(trashBtn, 'click');
    await flushPromises();

    expect(setup.stub.calls.some((c) => c.path.includes('/archive'))).toBe(false);
  });

  it('ARC-3: an "archived" column is hidden from the kanban grid and the task-status dropdown', async () => {
    const payload = boardWithTasks();
    payload.board.columns.push({ id: 'archived', name: 'Archived' });
    payload.board.task_order.archived = ['t3'];
    payload.tasks.push({ id: 't3', name: 'Gone', status: 'archived', project: 'demo' } as any);
    const setup = setupBoard(payload);
    mounted = setup.mounted;
    await boot(mounted);

    expect(mounted.document.querySelector('.kanban-column[data-column-id="archived"]')).toBeFalsy();
    const statusOptions = Array.from((mounted.document.getElementById('task-status-input') as HTMLSelectElement).options).map((o) => o.value);
    expect(statusOptions).not.toContain('archived');
    expect(statusOptions).toEqual(['todo', 'in-progress', 'done']);
  });

  it('ARC-4: the Archived Tasks drawer lists archived tasks and restoring one calls move_task', async () => {
    const payload = boardWithTasks();
    payload.board.columns.push({ id: 'archived', name: 'Archived' });
    payload.board.task_order.archived = ['t3'];
    payload.tasks.push({ id: 't3', name: 'Bring me back', status: 'archived', project: 'demo', updated_at: '2026-01-01T00:00:00Z' } as any);
    const setup = setupBoard(payload);
    let moveBody: any = null;
    setup.stub.on('POST', '/api/v1/command', ({ body }) => {
      if (body.type === 'move_task') moveBody = body;
      return { json: { success: true, data: { id: body.payload.id, status: body.payload.target_status } } };
    });
    mounted = setup.mounted;
    await boot(mounted);

    const w = mounted.window as any;
    w.openArchiveModal();
    const doc = mounted.document;
    expect(doc.getElementById('modal-archived')!.classList.contains('hidden')).toBe(false);

    const row = doc.getElementById('archived-container')!.querySelector('.item-card-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('Bring me back');

    const select = row.querySelector('.archived-restore-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(['todo', 'in-progress', 'done']);
    select.value = 'in-progress';

    const restoreBtn = row.querySelector('button') as HTMLButtonElement;
    dispatch(restoreBtn, 'click');
    await flushPromises();

    expect(moveBody).toBeTruthy();
    expect(moveBody.payload).toEqual({ id: 't3', target_status: 'in-progress' });
  });

  it('ARC-5: the Archived Tasks drawer shows an empty state with no archived tasks', async () => {
    const setup = setupBoard(boardWithTasks());
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    w.openArchiveModal();
    expect(mounted.document.getElementById('archived-container')!.textContent).toContain('No archived tasks');
  });
});

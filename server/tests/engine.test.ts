import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DeterministicEngine } from '../core/engine';
import { WorkspaceStorage } from '../core/storage';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

function seedSssfDb(
  projectPath: string,
  sessions: Array<{ adw_id: string; adw_name?: string; request?: string; status: string; started_at?: string }>
): string {
  const dbDir = path.join(projectPath, 'adws', 'adw_data');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'sssf.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
    engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL
  )`);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of sessions) {
    insert.run(s.adw_id, s.adw_name ?? null, s.request ?? null, s.status, null, s.started_at ?? new Date().toISOString(), null, 0, 0);
  }
  db.close();
  return dbPath;
}

function updateSessionStatus(dbPath: string, adwId: string, status: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`UPDATE sessions SET status = ? WHERE adw_id = ?`).run(status, adwId);
  db.close();
}

describe('DeterministicEngine Integration', () => {
  let tmpDir: string;
  let engine: DeterministicEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-test-'));
    WorkspaceStorage.initWorkspace(tmpDir);
    engine = new DeterministicEngine(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('initializes workspace and reads empty board state without emitting events', async () => {
    let eventEmitted = false;
    engine.on('event', () => { eventEmitted = true; });

    const res = await engine.executeCommand({ type: 'get_board', payload: {} });
    expect(res.success).toBe(true);
    expect(res.data.board.title).toBe('Software Factory Board');
    expect(res.data.board.columns.length).toBe(5);
    expect(res.data.board.columns.map((c: any) => c.id)).toEqual([
      'failed', 'todo', 'in-progress', 'ready-for-review', 'done'
    ]);
    expect(eventEmitted).toBe(false);
  });

  it('creates, moves, updates, and deletes tasks deterministically with ADW abstraction', async () => {
    // 1. Create task
    const createRes = await engine.executeCommand({
      type: 'create_task',
      payload: {
        name: 'Implement Auth',
        description: 'Add OAuth2 login',
        project: 'tasks',
        adw: 'implement-feature',
        status: 'todo'
      }
    });
    expect(createRes.success).toBe(true);
    expect(createRes.data.id).toBe('tasks-001');
    expect(createRes.data.name).toBe('Implement Auth');
    expect(createRes.data.adw).toBe('implement-feature');
    expect(createRes.data.agent).toBeUndefined();

    // 2. Verify task file written to disk
    const taskPath = path.join(tmpDir, 'tasks', 'tasks-001.json');
    expect(fs.existsSync(taskPath)).toBe(true);

    // 3. Move task
    const moveRes = await engine.executeCommand({
      type: 'move_task',
      payload: { id: 'tasks-001', target_status: 'in-progress' }
    });
    expect(moveRes.success).toBe(true);
    expect(moveRes.data.status).toBe('in-progress');

    // 4. Check board state task_order
    const boardRes = await engine.executeCommand({ type: 'get_board', payload: {} });
    expect(boardRes.data.board.task_order['in-progress']).toContain('tasks-001');
    expect(boardRes.data.board.task_order['todo']).not.toContain('tasks-001');

    // 5. Update task
    const updateRes = await engine.executeCommand({
      type: 'update_task',
      payload: { id: 'tasks-001', name: 'Implement OAuth2 Auth' }
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.data.name).toBe('Implement OAuth2 Auth');

    // 6. Delete task
    const deleteRes = await engine.executeCommand({
      type: 'delete_task',
      payload: { id: 'tasks-001' }
    });
    expect(deleteRes.success).toBe(true);
    expect(fs.existsSync(taskPath)).toBe(false);
  });

  it('rejects task creation when selecting invalid project or undeclared ADW', async () => {
    // Nonexistent project
    const invalidProjRes = await engine.executeCommand({
      type: 'create_task',
      payload: { name: 'Invalid Task', project: 'nonexistent', adw: 'implement-feature' }
    });
    expect(invalidProjRes.success).toBe(false);
    expect(invalidProjRes.error).toContain("Project 'nonexistent' not found");

    // Undeclared ADW for valid project
    const invalidAdwRes = await engine.executeCommand({
      type: 'create_task',
      payload: { name: 'Invalid ADW Task', project: 'tasks', adw: 'unsupported-adw' }
    });
    expect(invalidAdwRes.success).toBe(false);
    expect(invalidAdwRes.error).toContain("ADW 'unsupported-adw' is not declared");
  });

  it('handles concurrent task creations without duplicate IDs', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      engine.executeCommand({
        type: 'create_task',
        payload: { name: `Concurrent Task ${i}`, project: 'tasks', adw: 'implement-feature' }
      })
    );

    const results = await Promise.all(promises);
    results.forEach((res) => expect(res.success).toBe(true));

    const ids = results.map((res) => res.data.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);
  });

  it('prevents column deletion when tasks belong to that column', async () => {
    await engine.executeCommand({
      type: 'create_task',
      payload: { name: 'Active Task', status: 'todo', project: 'tasks', adw: 'implement-feature' }
    });

    const delColRes = await engine.executeCommand({
      type: 'delete_column',
      payload: { id: 'todo' }
    });
    expect(delColRes.success).toBe(false);
    expect(delColRes.error).toContain("Cannot delete column 'todo'");
  });

  it('manages projects and lists project ADWs', async () => {
    const projRes = await engine.executeCommand({
      type: 'create_project',
      payload: {
        id: 'web-app',
        name: 'Web Application',
        path: '/home/user/web-app',
        adws: [{ id: 'custom-flow', path: './workflows/custom-flow' }]
      }
    });
    expect(projRes.success).toBe(true);

    const adwsRes = await engine.executeCommand({
      type: 'list_project_adws',
      payload: { id: 'web-app' }
    });
    expect(adwsRes.success).toBe(true);
    expect(adwsRes.data.length).toBe(1);
    expect(adwsRes.data[0].id).toBe('custom-flow');
  });
  it('fails safely when workspace lock cannot be acquired', async () => {
    // Mock proper-lockfile to always throw
    const lockfile = require('proper-lockfile');
    const originalLock = lockfile.lock;
    lockfile.lock = () => Promise.reject(new Error('Lock acquisition failed'));

    try {
      const res = await engine.executeCommand({
        type: 'create_task',
        payload: { name: 'Locked Task', project: 'tasks', adw: 'implement-feature' }
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Lock acquisition failed');
    } finally {
      lockfile.lock = originalLock;
    }
  });

  it('preserves task edits when moving simultaneously', async () => {
    const taskRes = await engine.executeCommand({
      type: 'create_task',
      payload: { name: 'Old Name', project: 'tasks', adw: 'implement-feature', status: 'todo' }
    });
    const taskId = taskRes.data.id;

    const updateRes = await engine.executeCommand({
      type: 'update_task',
      payload: { id: taskId, name: 'New Name', status: 'in-progress' }
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.data.name).toBe('New Name');
    expect(updateRes.data.status).toBe('in-progress');

    // Verify it stuck to disk
    const diskTask = await engine.executeCommand({ type: 'get_task', payload: { id: taskId } });
    expect(diskTask.data.name).toBe('New Name');
  });

  it('rejects project updates that remove an in-use ADW', async () => {
    // 1. Create a project with two ADWs
    await engine.executeCommand({
      type: 'create_project',
      payload: { id: 'multi-adw-proj', path: '.', adws: [{ id: 'adw-1', path: '.' }, { id: 'adw-2', path: '.' }] }
    });

    // 2. Create task using adw-2
    await engine.executeCommand({
      type: 'create_task',
      payload: { name: 'Test Task', project: 'multi-adw-proj', adw: 'adw-2' }
    });

    // 3. Try to update project to remove adw-2
    const res = await engine.executeCommand({
      type: 'update_project',
      payload: { id: 'multi-adw-proj', adws: [{ id: 'adw-1', path: '.' }] }
    });
    
    expect(res.success).toBe(false);
    expect(res.error).toContain('selects ADW \'adw-2\' which is not declared');

    // 4. Verify disk restoration: projects.json should still declare adw-2 on disk
    const proj = (await engine.executeCommand({ type: 'get_project', payload: { id: 'multi-adw-proj' } })).data;
    expect(proj.adws.some((a: any) => a.id === 'adw-2')).toBe(true);
  });

  it('consolidates legacy data directories and stranded tasks into active workspace', async () => {
    const legacyDir = path.join(tmpDir, 'core', 'data');
    const legacyTasksDir = path.join(legacyDir, 'tasks');
    fs.mkdirSync(legacyTasksDir, { recursive: true });

    const strandedTask = {
      id: 'tasks-002',
      title: 'Stranded Legacy Task',
      status: 'todo',
      project: 'tasks',
      adw: 'implement-feature'
    };
    fs.writeFileSync(path.join(legacyTasksDir, 'tasks-002.json'), JSON.stringify(strandedTask, null, 2), 'utf8');

    // Re-instantiate storage to trigger migration
    const storage = new WorkspaceStorage(tmpDir);
    expect(storage.needsMigration()).toBe(false);

    const migratedTaskPath = path.join(tmpDir, 'tasks', 'tasks-002.json');
    expect(fs.existsSync(migratedTaskPath)).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);

    const taskObj = await storage.readTask('tasks-002');
    expect(taskObj?.name).toBe('Stranded Legacy Task');
  });

  it('does not create backups when no migration is necessary', async () => {
    const backupsDir = path.join(tmpDir, '.backups');
    const initialBackups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];

    // Re-instantiate WorkspaceStorage on clean workspace
    new WorkspaceStorage(tmpDir);

    const finalBackups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
    expect(finalBackups.length).toBe(initialBackups.length);
  });

  it('rolls back disk changes if validation fails mid-mutation', async () => {
    const initialBoard = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;

    // We'll intentionally pass a status that is not a column, but we will bypass 
    // the early check to force a failure during validation.
    // Wait, the early check handles this. Let's force an error by mocking `validateStateInvariants`.
    const originalValidate = engine['validateStateInvariants'];
    engine['validateStateInvariants'] = () => Promise.reject(new Error('Simulated validation failure'));

    try {
      const res = await engine.executeCommand({
        type: 'create_task',
        payload: { name: 'Rollback Task', project: 'tasks', adw: 'implement-feature' }
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Simulated validation failure');

      // The task file should not exist, and the board should not have been updated
      const finalBoard = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;
      expect(finalBoard.revision).toBe(initialBoard.revision);
      
      const tasks = fs.readdirSync(path.join(tmpDir, 'tasks'));
      expect(tasks.length).toBe(0);
    } finally {
      engine['validateStateInvariants'] = originalValidate;
    }
  });

  describe('sync_sssf', () => {
    it('is a no-op when no registered project has a trace db', async () => {
      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ ids: [], created: [], moved: [] });
    });

    it('a no-op tick does not bump board.revision or emit an event — regression for the stale-expected_revision bug', async () => {
      const boardBefore = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;

      let eventEmitted = false;
      engine.on('event', () => { eventEmitted = true; });

      // Several ticks in a row, as the unattended poll loop would fire.
      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      await engine.executeCommand({ type: 'sync_sssf', payload: {} });

      const boardAfter = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;
      expect(boardAfter.revision).toBe(boardBefore.revision);
      expect(eventEmitted).toBe(false);

      // A client that captured expected_revision before those ticks (e.g. a
      // "new task" form left open across a couple of poll intervals) must
      // still be able to submit without a spurious conflict.
      const createRes = await engine.executeCommand({
        type: 'create_task',
        payload: { name: 'Should not conflict', project: 'tasks', adw: 'implement-feature' },
        expected_revision: boardBefore.revision
      });
      expect(createRes.success).toBe(true);
    });

    it('creates a task for a session discovered directly via SSSF, leaving adw unset; re-running is idempotent', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({
        type: 'create_project',
        payload: { id: 'ext-proj', path: projectPath, adws: [{ id: 'plan-build', path: 'adws/adw_plan_build.py' }] }
      });
      seedSssfDb(projectPath, [
        { adw_id: 'ab12ab12', adw_name: 'adw_plan_build', request: 'add a widget', status: 'running' }
      ]);

      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.success).toBe(true);
      expect(res.data.created.length).toBe(1);
      expect(res.data.created[0].id).toBe('ab12ab12');
      expect(res.data.created[0].status).toBe('in-progress');
      expect(res.data.created[0].adw).toBeUndefined();
      expect(res.data.created[0].project).toBe('ext-proj');

      const board = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;
      expect(board.task_order['in-progress']).toContain('ab12ab12');

      // Re-running must not create a duplicate.
      const again = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(again.data.created.length).toBe(0);
      const allTasks = await engine.executeCommand({ type: 'list_tasks', payload: {} });
      expect(allTasks.data.filter((t: any) => t.id === 'ab12ab12').length).toBe(1);
    });

    it('moves an in-progress synced task to ready-for-review when its session succeeds', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath } });
      const dbPath = seedSssfDb(projectPath, [{ adw_id: 'cd34cd34', status: 'running', request: 'fix bug' }]);

      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      let task = await engine.executeCommand({ type: 'get_task', payload: { id: 'cd34cd34' } });
      expect(task.data.status).toBe('in-progress');

      updateSessionStatus(dbPath, 'cd34cd34', 'success');
      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.data.moved).toEqual([{ id: 'cd34cd34', from: 'in-progress', to: 'ready-for-review' }]);

      task = await engine.executeCommand({ type: 'get_task', payload: { id: 'cd34cd34' } });
      expect(task.data.status).toBe('ready-for-review');
      const board = (await engine.executeCommand({ type: 'get_board', payload: {} })).data.board;
      expect(board.task_order['ready-for-review']).toContain('cd34cd34');
      expect(board.task_order['in-progress']).not.toContain('cd34cd34');
    });

    it('moves an in-progress synced task to failed when its session fails', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath } });
      const dbPath = seedSssfDb(projectPath, [{ adw_id: 'ef56ef56', status: 'running' }]);

      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      updateSessionStatus(dbPath, 'ef56ef56', 'fail');
      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.data.moved).toEqual([{ id: 'ef56ef56', from: 'in-progress', to: 'failed' }]);
    });

    it('does not resurrect a deleted synced task (tombstoned via sync-state.json)', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath } });
      seedSssfDb(projectPath, [{ adw_id: 'ab99ab99', status: 'success', request: 'one-off run' }]);

      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      let found = await engine.executeCommand({ type: 'get_task', payload: { id: 'ab99ab99' } });
      expect(found.success).toBe(true);

      await engine.executeCommand({ type: 'delete_task', payload: { id: 'ab99ab99' } });
      found = await engine.executeCommand({ type: 'get_task', payload: { id: 'ab99ab99' } });
      expect(found.success).toBe(false);

      // Session row is still sitting in the trace db, untouched by the delete.
      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.data.created.length).toBe(0);
      found = await engine.executeCommand({ type: 'get_task', payload: { id: 'ab99ab99' } });
      expect(found.success).toBe(false);
    });

    it('never touches a task that has been manually moved out of in-progress', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath } });
      const dbPath = seedSssfDb(projectPath, [{ adw_id: 'gh78gh78', status: 'running' }]);

      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      await engine.executeCommand({ type: 'move_task', payload: { id: 'gh78gh78', target_status: 'done' } });

      updateSessionStatus(dbPath, 'gh78gh78', 'fail');
      const res = await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      expect(res.data.moved).toEqual([]);

      const task = await engine.executeCommand({ type: 'get_task', payload: { id: 'gh78gh78' } });
      expect(task.data.status).toBe('done');
    });
  });

  describe('clear_task_run', () => {
    // A task's `--adw-id` is create-or-continue (see runtime.ts), so
    // deleting only the session *files* wouldn't be enough to force a
    // genuinely fresh pi session on the next "start" — the sqlite rows
    // that key a resumable session by adw_id have to go too.
    it('deletes the session directory and this adw_id\'s db rows, leaving other adw_ids untouched', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath } });
      const dbPath = seedSssfDb(projectPath, [
        { adw_id: 'aa11aa11', status: 'success', request: 'run to clear' },
        { adw_id: 'bb22bb22', status: 'success', request: 'unrelated run' }
      ]);

      await engine.executeCommand({ type: 'sync_sssf', payload: {} });
      const task = await engine.executeCommand({ type: 'get_task', payload: { id: 'aa11aa11' } });
      expect(task.data.project).toBe('ext-proj');

      const sessionDir = path.join(projectPath, 'adws', 'adw_data', 'sessions', 'aa11aa11');
      fs.mkdirSync(path.join(sessionDir, 'planner', 'pi_sessions'), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'planner', 'pi_sessions', 'abc.jsonl'), '{}\n');
      const otherSessionDir = path.join(projectPath, 'adws', 'adw_data', 'sessions', 'bb22bb22');
      fs.mkdirSync(otherSessionDir, { recursive: true });
      fs.writeFileSync(path.join(otherSessionDir, 'marker.txt'), 'keep me');

      const res = await engine.executeCommand({ type: 'clear_task_run', payload: { id: 'aa11aa11' } });
      expect(res.success).toBe(true);
      expect(res.data.sessionCleared).toBe(true);
      expect(res.data.dbRowsCleared).toBe(true);

      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(fs.existsSync(otherSessionDir)).toBe(true);

      const db = new DatabaseSync(dbPath);
      try {
        const remaining = db.prepare('SELECT adw_id FROM sessions').all() as { adw_id: string }[];
        expect(remaining.map((r) => r.adw_id)).toEqual(['bb22bb22']);
      } finally {
        db.close();
      }
    });

    it('is a no-op success when the task has no session on disk yet', async () => {
      const projectPath = path.join(tmpDir, 'external-project');
      fs.mkdirSync(projectPath, { recursive: true });
      await engine.executeCommand({ type: 'create_project', payload: { id: 'ext-proj', path: projectPath, adws: [{ id: 'plan-build', path: 'adws/adw_plan_build.py' }] } });
      const createRes = await engine.executeCommand({
        type: 'create_task',
        payload: { name: 'Fresh task', project: 'ext-proj', adw: 'plan-build' }
      });

      const res = await engine.executeCommand({ type: 'clear_task_run', payload: { id: createRes.data.id } });
      expect(res.success).toBe(true);
      expect(res.data.stopped).toBe(false);
      expect(res.data.sessionCleared).toBe(false);
    });

    it('rejects a nonexistent task', async () => {
      const res = await engine.executeCommand({ type: 'clear_task_run', payload: { id: 'does-not-exist' } });
      expect(res.success).toBe(false);
    });
  });

  describe('outcomeToColumn / mapSessionStatusToColumn (pure helpers)', () => {
    it('maps run outcomes to their target column, or null for a deliberate stop', () => {
      const outcomeToColumn = (DeterministicEngine as any).outcomeToColumn;
      expect(outcomeToColumn('success')).toBe('ready-for-review');
      expect(outcomeToColumn('fail')).toBe('failed');
      expect(outcomeToColumn('stopped')).toBeNull();
    });

    it('falls back gracefully when a board is missing the natural target column', () => {
      const mapSessionStatusToColumn = (DeterministicEngine as any).mapSessionStatusToColumn;
      const sparseBoard = {
        title: 'x',
        columns: [{ id: 'todo', name: 'To Do' }],
        task_order: {}
      };
      expect(mapSessionStatusToColumn(sparseBoard, 'running')).toBe('todo');
      expect(mapSessionStatusToColumn(sparseBoard, 'success')).toBe('todo');
      expect(mapSessionStatusToColumn(sparseBoard, 'fail')).toBe('todo');

      const noTodoBoard = { title: 'x', columns: [{ id: 'somewhere', name: 'Somewhere' }], task_order: {} };
      expect(mapSessionStatusToColumn(noTodoBoard, null)).toBe('somewhere');
    });
  });
});

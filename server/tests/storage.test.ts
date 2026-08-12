import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceStorage } from '../core/storage';

describe('WorkspaceStorage — ready-for-review column & sync-state.json', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function freshDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-storage-test-'));
    return tmpDir;
  }

  it('initWorkspace places ready-for-review between in-progress and done, with an empty task_order entry', () => {
    const dir = freshDir();
    WorkspaceStorage.initWorkspace(dir);
    const board = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
    expect(board.columns.map((c: any) => c.id)).toEqual(['failed', 'todo', 'in-progress', 'ready-for-review', 'done']);
    expect(board.task_order['ready-for-review']).toEqual([]);
  });

  it('initWorkspace also creates an empty sync-state.json', () => {
    const dir = freshDir();
    WorkspaceStorage.initWorkspace(dir);
    const syncState = JSON.parse(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf8'));
    expect(syncState).toEqual({});
  });

  it('migrates an existing old-shape board.json to include ready-for-review, idempotently', () => {
    const dir = freshDir();
    WorkspaceStorage.initWorkspace(dir);
    const boardPath = path.join(dir, 'board.json');
    const oldBoard = {
      title: 'Software Factory Board',
      columns: [
        { id: 'failed', name: 'Failed' },
        { id: 'todo', name: 'To Do' },
        { id: 'in-progress', name: 'In Progress' },
        { id: 'done', name: 'Done' }
      ],
      task_order: { failed: [], todo: [], 'in-progress': [], done: [] }
    };
    fs.writeFileSync(boardPath, JSON.stringify(oldBoard, null, 2), 'utf8');

    new WorkspaceStorage(dir);
    let board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    expect(board.columns.map((c: any) => c.id)).toEqual(['failed', 'todo', 'in-progress', 'ready-for-review', 'done']);
    expect(board.task_order['ready-for-review']).toEqual([]);

    // Idempotent: constructing again over the now-migrated board doesn't duplicate the column.
    new WorkspaceStorage(dir);
    board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    expect(board.columns.filter((c: any) => c.id === 'ready-for-review').length).toBe(1);
  });

  it('falls back to appending at the end when in-progress is absent', () => {
    const dir = freshDir();
    WorkspaceStorage.initWorkspace(dir);
    const boardPath = path.join(dir, 'board.json');
    const oldBoard = {
      title: 'Software Factory Board',
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'done', name: 'Done' }
      ],
      task_order: { todo: [], done: [] }
    };
    fs.writeFileSync(boardPath, JSON.stringify(oldBoard, null, 2), 'utf8');

    new WorkspaceStorage(dir);
    const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    expect(board.columns.map((c: any) => c.id)).toEqual(['todo', 'done', 'ready-for-review']);
  });

  it('readSyncState/writeSyncState round-trip and participate in snapshot/rollback', async () => {
    const dir = freshDir();
    WorkspaceStorage.initWorkspace(dir);
    const storage = new WorkspaceStorage(dir);

    expect(await storage.readSyncState()).toEqual({});
    await storage.writeSyncState({ 'my-project': ['aaaaaaaa', 'bbbbbbbb'] });
    expect(await storage.readSyncState()).toEqual({ 'my-project': ['aaaaaaaa', 'bbbbbbbb'] });

    const snapshot = storage.snapshotWorkspace();
    expect(snapshot.has(storage.getSyncStatePath())).toBe(true);

    await storage.writeSyncState({ 'my-project': ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] });
    storage.rollbackWorkspace(snapshot);
    expect(await storage.readSyncState()).toEqual({ 'my-project': ['aaaaaaaa', 'bbbbbbbb'] });
  });
});

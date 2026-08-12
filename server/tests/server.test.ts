import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';
import { WorkspaceStorage } from '../core/storage';

describe('BoardServer HTTP & SSE API', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-server-test-'));
    WorkspaceStorage.initWorkspace(tmpDir); // ensure default project "tasks" exists
    server = new BoardServer({ workspaceDir: tmpDir });
    activePort = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRequest(method: string, reqPath: string, body?: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://localhost:${activePort}${reqPath}`,
        {
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => (rawData += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(rawData);
              resolve({ status: res.statusCode || 200, data: json });
            } catch (e) {
              resolve({ status: res.statusCode || 200, data: rawData });
            }
          });
        }
      );
      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('responds to health check endpoint', async () => {
    const res = await makeRequest('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  it('handles task creation and board retrieval via REST API with ADW contract', async () => {
    const createRes = await makeRequest('POST', '/api/v1/tasks', {
      name: 'REST Task 1',
      description: 'Created via HTTP',
      project: 'tasks',
      adw: 'implement-feature'
    });
    expect(createRes.status).toBe(201);
    expect(createRes.data.success).toBe(true);
    expect(createRes.data.data.id).toBe('tasks-001');

    const boardRes = await makeRequest('GET', '/api/v1/board');
    expect(boardRes.status).toBe(200);
    expect(boardRes.data.data.tasks.length).toBe(1);
    expect(boardRes.data.data.tasks[0].name).toBe('REST Task 1');
    expect(boardRes.data.data.tasks[0].adw).toBe('implement-feature');
  });

  it('serves project ADWs endpoint GET /api/v1/projects/:id/adws', async () => {
    const adwsRes = await makeRequest('GET', '/api/v1/projects/tasks/adws');
    expect(adwsRes.status).toBe(200);
    expect(adwsRes.data.success).toBe(true);
    expect(adwsRes.data.data.length).toBeGreaterThan(0);
    expect(adwsRes.data.data[0].id).toBe('implement-feature');
  });

  it('enforces expected_revision and handles conflict detection via REST shortcuts and command API', async () => {
    // Create task
    const createRes = await makeRequest('POST', '/api/v1/tasks', {
      name: 'Concurrency REST Task',
      project: 'tasks',
      adw: 'implement-feature'
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.data.data.id;

    // Get current board revision
    const boardRes = await makeRequest('GET', '/api/v1/board');
    const rev = boardRes.data.data.board.revision;
    expect(typeof rev).toBe('number');

    // Attempt REST update with wrong expected_revision
    const staleRes = await makeRequest('PUT', `/api/v1/tasks/${taskId}`, {
      name: 'Stale Edit',
      expected_revision: rev + 999
    });
    expect(staleRes.status).toBe(400);
    expect(staleRes.data.success).toBe(false);
    expect(staleRes.data.error).toContain('Conflict: expected revision');

    // Command API with correct expected_revision (including revision 0 if rev === 1)
    const validCmdRes = await makeRequest('POST', '/api/v1/command', {
      type: 'update_task',
      payload: { id: taskId, name: 'Valid Edit' },
      expected_revision: rev
    });
    expect(validCmdRes.status).toBe(200);
    expect(validCmdRes.data.success).toBe(true);
    expect(validCmdRes.data.data.name).toBe('Valid Edit');
  });

  it('sssfSyncIntervalMs defaults to disabled — no existing test needs to account for background sync', async () => {
    // server built in beforeEach passes no sssfSyncIntervalMs, matching every
    // other test in this file; this just makes that assumption explicit.
    expect((server as any).sssfSyncIntervalMs).toBe(0);
    expect((server as any).syncTimer).toBeNull();
  });
});

describe('BoardServer — SSSF sync loop & live-agents routes', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;

  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

  afterEach(async () => {
    if (server) await server.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRequest(port: number, method: string, reqPath: string, body?: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://localhost:${port}${reqPath}`,
        {
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => (rawData += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 200, data: JSON.parse(rawData) });
            } catch {
              resolve({ status: res.statusCode || 200, data: rawData });
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function seedSssfDb(projectPath: string): string {
    const dbDir = path.join(projectPath, 'adws', 'adw_data');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'sssf.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (
      adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
      engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL
    )`);
    db.exec(`CREATE TABLE processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, adw_id TEXT, kind TEXT, name TEXT,
      pid INTEGER, command TEXT, started_at TEXT, ended_at TEXT
    )`);
    db.prepare(
      `INSERT INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost)
       VALUES ('ij90ij90', 'adw_plan_build', 'sync me', 'running', 'e1', datetime('now'), NULL, 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO processes (adw_id, kind, name, pid, command, started_at, ended_at)
       VALUES ('ij90ij90', 'agent', 'planner', 4242, 'pi ...', datetime('now'), NULL)`
    ).run();
    db.close();
    return dbPath;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000, stepMs = 25): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }

  it('auto-creates a task from a directly-started SSSF session within one sync tick', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-sync-test-'));
    WorkspaceStorage.initWorkspace(tmpDir);
    const projectPath = path.join(tmpDir, 'external-project');
    fs.mkdirSync(projectPath, { recursive: true });
    seedSssfDb(projectPath);

    server = new BoardServer({ workspaceDir: tmpDir, sssfSyncIntervalMs: 50 });
    activePort = await server.listen(0);

    await makeRequest(activePort, 'POST', '/api/v1/projects', { id: 'ext-proj', name: 'ext-proj', path: projectPath });

    await waitFor(async () => {
      const res = await makeRequest(activePort, 'GET', '/api/v1/tasks');
      return res.data.success && res.data.data.some((t: any) => t.id === 'ij90ij90');
    });
  });

  it('exposes live agents for a project via /api/v1/projects/:id/live-agents and /api/v1/live-agents', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-sync-test-'));
    WorkspaceStorage.initWorkspace(tmpDir);
    const projectPath = path.join(tmpDir, 'external-project');
    fs.mkdirSync(projectPath, { recursive: true });
    seedSssfDb(projectPath);

    server = new BoardServer({ workspaceDir: tmpDir }); // sync disabled — routes are read-only regardless
    activePort = await server.listen(0);

    await makeRequest(activePort, 'POST', '/api/v1/projects', { id: 'ext-proj', name: 'ext-proj', path: projectPath });

    const perProject = await makeRequest(activePort, 'GET', '/api/v1/projects/ext-proj/live-agents');
    expect(perProject.status).toBe(200);
    expect(perProject.data.data.length).toBe(1);
    expect(perProject.data.data[0].pid).toBe(4242);
    expect(perProject.data.data[0].agent_name).toBe('planner');
    expect(perProject.data.data[0].task_id).toBeNull(); // sync never ran — no matching task yet

    const aggregate = await makeRequest(activePort, 'GET', '/api/v1/live-agents');
    expect(aggregate.status).toBe(200);
    expect(aggregate.data.data.length).toBe(1);
  });
});

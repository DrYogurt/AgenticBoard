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
});

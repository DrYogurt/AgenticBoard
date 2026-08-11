import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';
import { WorkspaceStorage } from '../core/storage';

describe('SSE Synchronization', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-sse-test-'));
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

  function makeCommandRequest(payload: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        `http://localhost:${activePort}/api/v1/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => (rawData += chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode || 200, data: JSON.parse(rawData) });
          });
        }
      );
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  it('receives an SSE event on mutation with monotonic revision and affected_ids', () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(`http://localhost:${activePort}/api/v1/events`, { method: 'GET' }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n\n');
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'connected') {
                // Now that we are connected, trigger a mutation
                makeCommandRequest({
                  type: 'create_task',
                  payload: {
                    name: 'SSE Test Task',
                    project: 'tasks',
                    adw: 'implement-feature'
                  }
                }).catch(reject);
              } else if (data.type === 'create_task') {
                // Verify monotonic revision and affected_ids
                try {
                  expect(data.revision).toBe(1);
                  expect(data.affected_ids.length).toBe(1);
                  expect(data.affected_ids[0]).toBe('tasks-001');
                  req.destroy();
                  resolve();
                } catch (err) {
                  req.destroy();
                  reject(err);
                }
              }
            }
          }
          buffer = lines[lines.length - 1];
        });
      });
      req.on('error', reject);
      req.end();
    });
  });
});

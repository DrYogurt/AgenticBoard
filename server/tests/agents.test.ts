import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';
import { SchemaValidator } from '../core/validator';

describe('Agent commands (register_agent / update_agent / list_agents)', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-agents-'));
    server = new BoardServer({ workspaceDir: tmpDir });
    activePort = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function request(
    method: string,
    reqPath: string,
    body?: unknown
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: 'localhost',
          port: activePort,
          path: reqPath,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let json: any = null;
            try {
              json = JSON.parse(raw);
            } catch {
              json = raw;
            }
            resolve({ status: res.statusCode || 200, json });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function command(type: string, payload: unknown) {
    return request('POST', '/api/v1/command', { type, payload });
  }

  async function listAgents(): Promise<any[]> {
    const res = await command('list_agents', {});
    return res.json.data;
  }

  describe('register_agent', () => {
    it('upserts an agent with default type/status/current_task/created_at', async () => {
      const res = await command('register_agent', { id: 'coder', name: 'Coder' });
      expect(res.json.success).toBe(true);

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'coder');
      expect(saved).toBeTruthy();
      expect(saved.type).toBe('generic');
      expect(saved.status).toBe('idle');
      expect(saved.current_task).toBeNull();
      expect(typeof saved.created_at).toBe('string');
    });

    it('re-registering an existing id replaces the record (upsert, not merge)', async () => {
      await command('register_agent', { id: 'coder', name: 'Coder', status: 'busy' });
      await command('register_agent', { id: 'coder', name: 'Coder' });

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'coder');
      expect(saved.status).toBe('idle');
    });
  });

  describe('update_agent', () => {
    it('patches status/current_task without clobbering unrelated fields', async () => {
      await command('register_agent', { id: 'reviewer', name: 'Reviewer' });

      const res = await command('update_agent', { id: 'reviewer', status: 'busy', current_task: 'task-1' });
      expect(res.json.success).toBe(true);

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'reviewer');
      expect(saved.status).toBe('busy');
      expect(saved.current_task).toBe('task-1');
      expect(saved.name).toBe('Reviewer');
    });

    it('errors for a nonexistent id', async () => {
      const res = await command('update_agent', { id: 'does-not-exist', status: 'busy' });
      expect(res.json.success).toBe(false);
    });
  });

  describe('schema validation', () => {
    it('rejects an unknown top-level field against agent.schema.json directly', () => {
      const validator = new SchemaValidator();
      const result = validator.validate('agent', { id: 'bad', name: 'Bad', bogus_field: 'nope' });
      expect(result.valid).toBe(false);
    });
  });
});

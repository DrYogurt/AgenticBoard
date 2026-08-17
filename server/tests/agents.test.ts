import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';
import { SchemaValidator } from '../core/validator';

describe('Agent commands (register_agent / update_agent / delete_agent / list_agents)', () => {
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
    it('round-trips model/system_prompt/parameters through list_agents', async () => {
      const res = await command('register_agent', {
        id: 'planner',
        name: 'Planner',
        model: 'anthropic/claude-opus-5',
        system_prompt: 'You plan things.',
        parameters: [{ name: 'branch', flag: '--branch', type: 'string', label: 'Branch', default: 'main' }]
      });
      expect(res.json.success).toBe(true);

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'planner');
      expect(saved).toBeTruthy();
      expect(saved.model).toBe('anthropic/claude-opus-5');
      expect(saved.system_prompt).toBe('You plan things.');
      expect(saved.parameters).toEqual([
        { name: 'branch', flag: '--branch', type: 'string', label: 'Branch', default: 'main' }
      ]);
    });

    it('works without the new fields and keeps existing defaulting behavior', async () => {
      const res = await command('register_agent', { id: 'coder', name: 'Coder' });
      expect(res.json.success).toBe(true);

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'coder');
      expect(saved).toBeTruthy();
      expect(saved.type).toBe('generic');
      expect(saved.status).toBe('idle');
      expect(saved.current_task).toBeNull();
      expect(typeof saved.created_at).toBe('string');
      expect(saved.model).toBeUndefined();
      expect(saved.system_prompt).toBeUndefined();
      expect(saved.parameters).toBeUndefined();
    });
  });

  describe('update_agent', () => {
    it('patches model/system_prompt/parameters without clobbering unrelated fields', async () => {
      await command('register_agent', {
        id: 'reviewer',
        name: 'Reviewer',
        system_prompt: 'You review things.'
      });

      const patchModel = await command('update_agent', { id: 'reviewer', model: 'anthropic/claude-sonnet-5' });
      expect(patchModel.json.success).toBe(true);

      let agents = await listAgents();
      let saved = agents.find((a) => a.id === 'reviewer');
      expect(saved.model).toBe('anthropic/claude-sonnet-5');
      // system_prompt set earlier must survive an unrelated patch.
      expect(saved.system_prompt).toBe('You review things.');

      const patchParams = await command('update_agent', {
        id: 'reviewer',
        parameters: [{ name: 'strict', flag: '--strict', type: 'boolean' }]
      });
      expect(patchParams.json.success).toBe(true);

      agents = await listAgents();
      saved = agents.find((a) => a.id === 'reviewer');
      expect(saved.parameters).toEqual([{ name: 'strict', flag: '--strict', type: 'boolean' }]);
      expect(saved.model).toBe('anthropic/claude-sonnet-5');
      expect(saved.system_prompt).toBe('You review things.');
    });

    it('does not allow changing id or name', async () => {
      await command('register_agent', { id: 'fixed-id', name: 'Fixed Name' });

      const res = await command('update_agent', {
        id: 'fixed-id',
        name: 'Renamed',
        model: 'anthropic/claude-opus-5'
      });
      expect(res.json.success).toBe(true);

      const agents = await listAgents();
      const saved = agents.find((a) => a.id === 'fixed-id');
      expect(saved).toBeTruthy();
      // Name is silently ignored by update_agent — only status/current_task/
      // model/system_prompt/parameters are patchable.
      expect(saved.name).toBe('Fixed Name');
      expect(saved.model).toBe('anthropic/claude-opus-5');
    });
  });

  describe('delete_agent', () => {
    it('removes an existing agent', async () => {
      await command('register_agent', { id: 'temp', name: 'Temp' });
      expect((await listAgents()).some((a) => a.id === 'temp')).toBe(true);

      const res = await command('delete_agent', { id: 'temp' });
      expect(res.json.success).toBe(true);

      expect((await listAgents()).some((a) => a.id === 'temp')).toBe(false);
    });

    it('is idempotent for a nonexistent id', async () => {
      const res = await command('delete_agent', { id: 'does-not-exist' });
      expect(res.json.success).toBe(true);
      expect(res.json.data).toEqual({ removed: true, id: 'does-not-exist' });
    });
  });

  describe('schema validation', () => {
    // handleRegisterAgent whitelists which top-level fields it copies onto the
    // stored Agent (unlike update_project, which stores payload.adws
    // verbatim), so an unknown top-level field like `bogus_field` is simply
    // dropped rather than ever reaching the schema-validated object. Verify
    // additionalProperties:false directly against agent.schema.json instead —
    // same enforcement mechanism as the ADW-field rejection this mirrors.
    it('rejects an unknown top-level field against agent.schema.json directly', () => {
      const validator = new SchemaValidator();
      const result = validator.validate('agent', { id: 'bad', name: 'Bad', bogus_field: 'nope' });
      expect(result.valid).toBe(false);
    });

    // parameters[] IS stored verbatim from the payload, so an unknown field
    // nested inside a parameter object flows through register_agent
    // end-to-end and is rejected the same way the ADW-parameters test in
    // features.test.ts is.
    it('rejects an unknown field inside parameters[] end-to-end via register_agent', async () => {
      const res = await command('register_agent', {
        id: 'bad-params',
        name: 'Bad Params',
        parameters: [{ name: 'branch', flag: '--branch', type: 'string', bogus_field: 'nope' }]
      });
      expect(res.json.success).toBe(false);
    });
  });
});

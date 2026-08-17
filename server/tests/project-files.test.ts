import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';

const SAMPLE_CONFIG = `# sssf.config.yaml — the factory's agent roster.
defaults:
  coding_agent: pi
  model: google/gemini-3.7-flash   # provider/id — a bare pattern is ambiguous
  thinking: medium                 # off | minimal | low | medium | high | xhigh | max
  data_dir: adws/adw_data          # runtime home

agents:
  - name: planner
    model: fireworks/kimi-k3
    thinking: high
    color: "#a78bfa"                 # optional hex — the agent's lane color
    purpose: Turn a request into a plan the builder can implement.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user: adws/adw_data/prompt_engineering/planner/user.md
    tools:
      - read
      - write

  - name: builder
    color: "#22d3ee"
    purpose: Implement the plan exactly.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/builder/system.md
      user: adws/adw_data/prompt_engineering/builder/user.md
    tools:
      - read
      - edit
      - write
`;

describe('Project file editing (workflow scripts, prompt files, sssf.config.yaml)', () => {
  let tmpDir: string;
  let projectDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-projfiles-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-proj-'));
    server = new BoardServer({ workspaceDir: tmpDir });
    activePort = await server.listen(0);
    await request('POST', '/api/v1/projects', { id: 'demo', name: 'demo', path: projectDir });
  });

  afterEach(async () => {
    await server.close();
    for (const dir of [tmpDir, projectDir]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function request(method: string, reqPath: string, body?: unknown): Promise<{ status: number; json: any }> {
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

  describe('GET/PUT /api/v1/projects/:id/file', () => {
    it('reads an existing text file within the project', async () => {
      fs.mkdirSync(path.join(projectDir, 'adws'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'adws', 'adw_prompt.py'), '#!/usr/bin/env -S uv run\nprint("hi")\n');
      const res = await request('GET', '/api/v1/projects/demo/file?path=adws/adw_prompt.py');
      expect(res.json.success).toBe(true);
      expect(res.json.data.exists).toBe(true);
      expect(res.json.data.content).toContain('print("hi")');
    });

    it('reports a missing file as exists:false rather than an error', async () => {
      const res = await request('GET', '/api/v1/projects/demo/file?path=adws/does_not_exist.py');
      expect(res.json.success).toBe(true);
      expect(res.json.data.exists).toBe(false);
      expect(res.json.data.content).toBeNull();
    });

    it('writes a file, creating parent directories as needed', async () => {
      const res = await request('PUT', '/api/v1/projects/demo/file', {
        path: 'adws/adw_data/prompt_engineering/planner/system.md',
        content: '# Planner\n\nBe careful.\n'
      });
      expect(res.json.success).toBe(true);
      const written = fs.readFileSync(path.join(projectDir, 'adws/adw_data/prompt_engineering/planner/system.md'), 'utf-8');
      expect(written).toBe('# Planner\n\nBe careful.\n');
    });

    it('overwrites an existing file in place', async () => {
      fs.mkdirSync(path.join(projectDir, 'adws'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'adws', 'script.py'), 'old content\n');
      await request('PUT', '/api/v1/projects/demo/file', { path: 'adws/script.py', content: 'new content\n' });
      expect(fs.readFileSync(path.join(projectDir, 'adws/script.py'), 'utf-8')).toBe('new content\n');
    });

    it('confines reads to the project directory (path traversal rejected)', async () => {
      const res = await request('GET', '/api/v1/projects/demo/file?path=' + encodeURIComponent('../../../etc/passwd'));
      expect(res.json.success).toBe(false);
      expect(res.json.error).toContain('escapes the project directory');
    });

    it('confines writes to the project directory (path traversal rejected)', async () => {
      const res = await request('PUT', '/api/v1/projects/demo/file', { path: '../../evil.py', content: 'x' });
      expect(res.json.success).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(projectDir), 'evil.py'))).toBe(false);
    });

    it('rejects a write with no content field', async () => {
      const res = await request('PUT', '/api/v1/projects/demo/file', { path: 'adws/script.py' });
      expect(res.json.success).toBe(false);
    });
  });

  describe('GET/PUT /api/v1/projects/:id/sssf-config', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(projectDir, 'adws', 'adw_sssf_config'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'adws/adw_sssf_config/sssf.config.yaml'), SAMPLE_CONFIG);
    });

    it('reports no config found for a project that has not been stamped with SSSF', async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-bare-'));
      await request('POST', '/api/v1/projects', { id: 'bare', name: 'bare', path: bare });
      const res = await request('GET', '/api/v1/projects/bare/sssf-config');
      expect(res.json.success).toBe(true);
      expect(res.json.data).toBeNull();
      expect(res.json.error).toContain('stamped with SSSF');
      fs.rmSync(bare, { recursive: true, force: true });
    });

    it('parses defaults, observability, and the agent roster', async () => {
      const res = await request('GET', '/api/v1/projects/demo/sssf-config');
      expect(res.json.success).toBe(true);
      expect(res.json.data.defaults.model).toBe('google/gemini-3.7-flash');
      expect(res.json.data.defaults.thinking).toBe('medium');
      expect(res.json.data.agents).toHaveLength(2);
      const planner = res.json.data.agents.find((a: any) => a.name === 'planner');
      expect(planner.model).toBe('fireworks/kimi-k3');
      expect(planner.thinking).toBe('high');
      expect(planner.prompt_engineering.system).toBe('adws/adw_data/prompt_engineering/planner/system.md');
    });

    it('edits an existing agent\'s scalar fields while preserving the file\'s comments', async () => {
      const before = await request('GET', '/api/v1/projects/demo/sssf-config');
      const agents = before.json.data.agents;
      const planner = agents.find((a: any) => a.name === 'planner');
      planner.model = 'anthropic/claude-opus-5';
      planner.thinking = 'xhigh';

      const res = await request('PUT', '/api/v1/projects/demo/sssf-config', { agents });
      expect(res.json.success).toBe(true);

      const rawAfter = fs.readFileSync(path.join(projectDir, 'adws/adw_sssf_config/sssf.config.yaml'), 'utf-8');
      // Every inline comment from the original file must still be present —
      // this is the whole point of using yaml's Document API instead of a
      // naive parse-then-restringify round trip.
      expect(rawAfter).toContain("# sssf.config.yaml — the factory's agent roster.");
      expect(rawAfter).toContain('# provider/id — a bare pattern is ambiguous');
      expect(rawAfter).toContain("# optional hex — the agent's lane color");
      expect(rawAfter).toContain('# off | minimal | low | medium | high | xhigh | max');

      const after = await request('GET', '/api/v1/projects/demo/sssf-config');
      const plannerAfter = after.json.data.agents.find((a: any) => a.name === 'planner');
      expect(plannerAfter.model).toBe('anthropic/claude-opus-5');
      expect(plannerAfter.thinking).toBe('xhigh');
      // Untouched fields survive.
      expect(plannerAfter.color).toBe('#a78bfa');
      expect(plannerAfter.tools).toEqual(['read', 'write']);
    });

    it('clearing an optional field removes it from the YAML (falls back to defaults)', async () => {
      const before = await request('GET', '/api/v1/projects/demo/sssf-config');
      const agents = before.json.data.agents;
      const planner = agents.find((a: any) => a.name === 'planner');
      planner.model = '';
      planner.thinking = '';

      await request('PUT', '/api/v1/projects/demo/sssf-config', { agents });

      const after = await request('GET', '/api/v1/projects/demo/sssf-config');
      const plannerAfter = after.json.data.agents.find((a: any) => a.name === 'planner');
      expect(plannerAfter.model).toBeUndefined();
      expect(plannerAfter.thinking).toBeUndefined();
    });

    it('adding a new agent appends it to the roster and creates its prompt files', async () => {
      const before = await request('GET', '/api/v1/projects/demo/sssf-config');
      const agents = before.json.data.agents;
      agents.push({ name: 'reviewer', purpose: 'Confirm the work matches the ask.' });

      const res = await request('PUT', '/api/v1/projects/demo/sssf-config', { agents });
      expect(res.json.success).toBe(true);

      const after = await request('GET', '/api/v1/projects/demo/sssf-config');
      const reviewer = after.json.data.agents.find((a: any) => a.name === 'reviewer');
      expect(reviewer).toBeTruthy();
      expect(reviewer.prompt_engineering.system).toBe('adws/adw_data/prompt_engineering/reviewer/system.md');

      expect(fs.existsSync(path.join(projectDir, 'adws/adw_data/prompt_engineering/reviewer/system.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'adws/adw_data/prompt_engineering/reviewer/user.md'))).toBe(true);
    });

    it('omitting an agent from the payload removes it from the roster', async () => {
      const before = await request('GET', '/api/v1/projects/demo/sssf-config');
      const agents = before.json.data.agents.filter((a: any) => a.name !== 'builder');

      await request('PUT', '/api/v1/projects/demo/sssf-config', { agents });

      const after = await request('GET', '/api/v1/projects/demo/sssf-config');
      expect(after.json.data.agents.map((a: any) => a.name)).toEqual(['planner']);
    });

    it('rejects a payload with a missing or empty agent name', async () => {
      const res = await request('PUT', '/api/v1/projects/demo/sssf-config', { agents: [{ name: '' }] });
      expect(res.json.success).toBe(false);
    });

    it('rejects a payload with no agents array', async () => {
      const res = await request('PUT', '/api/v1/projects/demo/sssf-config', {});
      expect(res.json.success).toBe(false);
    });
  });
});

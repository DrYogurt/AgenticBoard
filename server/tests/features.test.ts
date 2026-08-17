import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer, parseModelsTable } from '../index';

const SAMPLE_TABLE = [
  'provider           model                                     context  max-out  thinking  images',
  'anthropic          claude-opus-5                             1M       128K     yes       yes   ',
  'anthropic          claude-sonnet-5                           1M       128K     yes       yes   ',
  'google             gemini-3-pro-preview                      1.0M     65.5K    yes       yes   ',
  'google-gemini-cli  gemini-2.0-flash                          1.0M     8.2K     no        yes   ',
  '',
  'truncated'
].join('\n');

describe('parseModelsTable', () => {
  it('parses provider and model out of the fixed-width table', () => {
    const rows = parseModelsTable(SAMPLE_TABLE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      context: '1M',
      max_output: '128K',
      thinking: true,
      images: true,
      id: 'anthropic/claude-opus-5'
    });
  });

  it('keeps hyphenated provider names intact', () => {
    const rows = parseModelsTable(SAMPLE_TABLE);
    const cli = rows.find((r) => r.model === 'gemini-2.0-flash');
    expect(cli?.provider).toBe('google-gemini-cli');
    expect(cli?.id).toBe('google-gemini-cli/gemini-2.0-flash');
  });

  it('coerces the thinking/images columns to booleans', () => {
    const rows = parseModelsTable(SAMPLE_TABLE);
    expect(rows.find((r) => r.model === 'gemini-2.0-flash')?.thinking).toBe(false);
    expect(rows.find((r) => r.model === 'gemini-3-pro-preview')?.thinking).toBe(true);
  });

  it('skips the header row and any malformed lines', () => {
    const rows = parseModelsTable(SAMPLE_TABLE);
    expect(rows.some((r) => r.provider === 'provider')).toBe(false);
    expect(rows.some((r) => r.provider === 'truncated')).toBe(false);
  });

  it('returns an empty list for empty output', () => {
    expect(parseModelsTable('')).toEqual([]);
  });
});

describe('New website feature endpoints', () => {
  let tmpDir: string;
  let projectDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-features-'));
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

  /** Minimal multipart/form-data body so the upload path is exercised for real. */
  function uploadFiles(
    projectId: string,
    files: { filename: string; content: string }[]
  ): Promise<{ status: number; json: any }> {
    const boundary = '----agenticboardtest' + Date.now();
    const parts: Buffer[] = [];
    for (const f of files) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\n` +
            `Content-Type: text/plain\r\n\r\n${f.content}\r\n`
        )
      );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port: activePort,
          path: `/api/v1/projects/${encodeURIComponent(projectId)}/documents`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
          }
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
      req.write(payload);
      req.end();
    });
  }

  describe('GET /api/v1/models', () => {
    it('always responds 200 with an array, even if `pi` is unavailable', async () => {
      const res = await request('GET', '/api/v1/models');
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(Array.isArray(res.json.data)).toBe(true);
    });

    it('exposes provider and model separately on every entry', async () => {
      const res = await request('GET', '/api/v1/models?refresh=1');
      for (const entry of res.json.data) {
        expect(typeof entry.provider).toBe('string');
        expect(typeof entry.model).toBe('string');
        expect(entry.id).toBe(`${entry.provider}/${entry.model}`);
      }
    });
  });

  describe('GET/POST /api/v1/projects/:id/documents', () => {
    it('returns an empty list before anything is uploaded', async () => {
      const res = await request('GET', '/api/v1/projects/demo/documents');
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual([]);
    });

    it('stores uploads under <project>/documents', async () => {
      const res = await uploadFiles('demo', [{ filename: 'spec.md', content: '# spec' }]);
      expect(res.json.success).toBe(true);
      expect(res.json.data[0].filename).toBe('spec.md');
      expect(fs.readFileSync(path.join(projectDir, 'documents', 'spec.md'), 'utf-8')).toBe('# spec');
    });

    it('reports stored paths relative to the project, never absolute host paths', async () => {
      const res = await uploadFiles('demo', [{ filename: 'notes.txt', content: 'x' }]);
      expect(res.json.data[0].path).not.toContain(projectDir);
      expect(path.isAbsolute(res.json.data[0].path)).toBe(false);
    });

    it('accepts multiple files in one request', async () => {
      const res = await uploadFiles('demo', [
        { filename: 'a.md', content: 'a' },
        { filename: 'b.md', content: 'b' }
      ]);
      expect(res.json.data).toHaveLength(2);
      const listed = await request('GET', '/api/v1/projects/demo/documents');
      expect(listed.json.data.map((d: any) => d.filename).sort()).toEqual(['a.md', 'b.md']);
    });

    it('suffixes instead of overwriting an existing document', async () => {
      await uploadFiles('demo', [{ filename: 'dup.md', content: 'first' }]);
      const second = await uploadFiles('demo', [{ filename: 'dup.md', content: 'second' }]);
      expect(second.json.data[0].filename).not.toBe('dup.md');
      expect(fs.readFileSync(path.join(projectDir, 'documents', 'dup.md'), 'utf-8')).toBe('first');
    });

    it('confines traversal filenames to the documents directory', async () => {
      await uploadFiles('demo', [{ filename: '../../escaped.md', content: 'nope' }]);
      expect(fs.existsSync(path.join(projectDir, 'escaped.md'))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(projectDir), 'escaped.md'))).toBe(false);
      const listed = await request('GET', '/api/v1/projects/demo/documents');
      for (const doc of listed.json.data) {
        expect(doc.filename).not.toContain('..');
        expect(doc.filename).not.toContain('/');
      }
    });

    it('confines absolute-path filenames to the documents directory', async () => {
      await uploadFiles('demo', [{ filename: '/etc/evil.md', content: 'nope' }]);
      const stored = fs.readdirSync(path.join(projectDir, 'documents'));
      expect(stored).toContain('evil.md');
    });

    it('rejects an unknown project', async () => {
      const res = await request('GET', '/api/v1/projects/nope/documents');
      expect(res.json.success).toBe(false);
      const posted = await uploadFiles('nope', [{ filename: 'x.md', content: 'x' }]);
      expect(posted.json.success).toBe(false);
    });
  });

  describe('ADW editor persistence (update_project)', () => {
    it('round-trips the editable ADW fields the workflow editor writes, including agent-typed parameters', async () => {
      const adws = [
        {
          id: 'implement-feature',
          path: './workflows/implement-feature',
          name: 'Implement Feature',
          model: 'anthropic/claude-opus-5',
          parameters: [
            { name: 'branch', flag: '--branch', type: 'string', label: 'Branch', default: 'main' },
            { name: 'agent', flag: '--agent', type: 'agent', label: 'Agent to run', default: 'builder' }
          ]
        }
      ];
      const res = await request('POST', '/api/v1/command', {
        type: 'update_project',
        payload: { id: 'demo', adws }
      });
      expect(res.json.success).toBe(true);

      const fetched = await request('GET', '/api/v1/projects/demo');
      const saved = fetched.json.data.adws[0];
      expect(saved.name).toBe('Implement Feature');
      expect(saved.model).toBe('anthropic/claude-opus-5');
      expect(saved.agents).toBeUndefined();
      expect(saved.parameters[0].flag).toBe('--branch');
      expect(saved.parameters[1]).toEqual({ name: 'agent', flag: '--agent', type: 'agent', label: 'Agent to run', default: 'builder' });
    });

    it('rejects an ADW field the schema does not allow', async () => {
      const res = await request('POST', '/api/v1/command', {
        type: 'update_project',
        payload: { id: 'demo', adws: [{ id: 'x', path: './x', bogus_field: 'nope' }] }
      });
      expect(res.json.success).toBe(false);
    });
  });
});

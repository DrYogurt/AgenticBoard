import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { BoardServer } from '../index';

describe('Web UI Static Asset Serving', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-web-test-'));
    server = new BoardServer({ workspaceDir: tmpDir });
    activePort = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function fetchAsset(reqPath: string): Promise<{ status: number; contentType: string; body: string }> {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${activePort}${reqPath}`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            contentType: res.headers['content-type'] || '',
            body
          });
        });
      }).on('error', reject);
    });
  }

  it('serves index.html at root route /', async () => {
    const res = await fetchAsset('/');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('<title>AgenticBoard — Dr. Yogurt\'s Zen Terminal</title>');
    expect(res.body).toContain('kanban-canvas');
  });

  it('serves styles.css with correct Content-Type', async () => {
    const res = await fetchAsset('/styles.css');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/css');
    expect(res.body).toContain('--mocha-base: #1e1e2e');
  });

  it('serves app.js with correct Content-Type', async () => {
    const res = await fetchAsset('/app.js');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('javascript');
    expect(res.body).toContain('AgenticBoard Web UI Client Script');
  });

  it('serves favicon-dark.png and favicon-light.png', async () => {
    const resDark = await fetchAsset('/favicon-dark.png');
    expect(resDark.status).toBe(200);
    expect(resDark.contentType).toContain('image/png');

    const resLight = await fetchAsset('/favicon-light.png');
    expect(resLight.status).toBe(200);
    expect(resLight.contentType).toContain('image/png');
  });
});

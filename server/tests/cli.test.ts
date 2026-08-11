import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import util from 'util';
import { exec } from 'child_process';
import { BoardServer } from '../index';
import { WorkspaceStorage } from '../core/storage';

const execAsync = util.promisify(exec);

describe('CLI Commands Integration', () => {
  let tmpDir: string;
  let server: BoardServer;
  let activePort: number;
  const binPath = path.join(__dirname, '../cli/bin/factory.js');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-cli-test-'));
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

  async function runCli(args: string, options: { expectError?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await execAsync(`node ${binPath} -w "${tmpDir}" -s "http://127.0.0.1:${activePort}" ${args}`, {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' }
      });
      return stdout;
    } catch (err: any) {
      if (options.expectError) {
        return err.stderr || err.stdout || err.message;
      }
      throw err;
    }
  }

  it('initializes workspace via init command', async () => {
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-test-'));
    const output = await runCli(`init "${initDir}"`);
    expect(output).toContain('Workspace successfully initialized');
    expect(fs.existsSync(path.join(initDir, 'board.json'))).toBe(true);
  });

  it('creates, lists, moves, and deletes tasks via CLI against server', async () => {
    await runCli('task create "CLI Task 1" --desc "Description 1" --project tasks --workflow implement-feature');
    
    const listOutput = await runCli('task list');
    expect(listOutput).toContain('CLI Task 1');

    const tasks = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tasks', 'tasks-001.json'), 'utf8'));
    expect(tasks.status).toBe('todo');

    await runCli('task move tasks-001 in-progress');
    const board = JSON.parse(fs.readFileSync(path.join(tmpDir, 'board.json'), 'utf8'));
    expect(board.task_order['in-progress']).toContain('tasks-001');

    await runCli('task delete tasks-001');
    const listOutput2 = await runCli('task list');
    expect(listOutput2).toContain('No tasks found');
  });

  it('manages columns, projects, project ADWs, and extensions via CLI', async () => {
    await runCli('column add review "In Review"');
    const boardOutput = await runCli('board');
    expect(boardOutput).toContain('In Review');

    await runCli('project create test-proj "/path/to/test-proj"');
    const projOutput = await runCli('project list');
    expect(projOutput).toContain('test-proj');

    const adwOutput = await runCli('project adws tasks');
    expect(adwOutput).toContain('implement-feature');

    await runCli('extension register test-ext dashboard "http://localhost:9090"');
    const extOutput = await runCli('extension list');
    expect(extOutput).toContain('test-ext');
  });

  it('strictly reports server error when server is unavailable', async () => {
    let errorOutput = '';
    try {
      await execAsync(`node ${binPath} -s "http://127.0.0.1:59999" task list`, {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' }
      });
    } catch (err: any) {
      errorOutput = err.stderr || err.stdout || err.message;
    }

    expect(errorOutput).toContain('Server connection error');
  });
});

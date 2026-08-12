import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TraceDb } from '../core/trace';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

describe('TraceDb.sessions / TraceDb.liveProcesses', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-board-trace-test-'));
    dbPath = path.join(tmpDir, 'sssf.db');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function seedDb(opts: { withArchivedColumn?: boolean; withProcessesTable?: boolean } = {}) {
    const { withArchivedColumn = true, withProcessesTable = true } = opts;
    const db = new DatabaseSync(dbPath);
    const archivedCol = withArchivedColumn ? ', archived INTEGER' : '';
    db.exec(`CREATE TABLE sessions (
      adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
      engineer TEXT, started_at TEXT, ended_at TEXT,
      total_tokens INTEGER, total_cost REAL${archivedCol}
    )`);
    if (withProcessesTable) {
      db.exec(`CREATE TABLE processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, adw_id TEXT, kind TEXT, name TEXT,
        pid INTEGER, command TEXT, started_at TEXT, ended_at TEXT
      )`);
    }
    return db;
  }

  it('lists sessions ordered most-recent-first, tolerating a missing archived column', () => {
    const db = seedDb({ withArchivedColumn: false });
    db.prepare(
      `INSERT INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('aaaaaaaa', 'adw_plan_build', 'first request', 'success', 'e1', '2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z', 100, 0.01);
    db.prepare(
      `INSERT INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('bbbbbbbb', 'adw_scout', 'second request', 'running', 'e1', '2024-01-02T00:00:00Z', null, 10, 0.001);
    db.close();

    const trace = new TraceDb(dbPath);
    try {
      const sessions = trace.sessions();
      expect(sessions.length).toBe(2);
      expect(sessions[0].adw_id).toBe('bbbbbbbb'); // most recent started_at first
      expect(sessions[1].adw_id).toBe('aaaaaaaa');
    } finally {
      trace.close();
    }
  });

  it('excludes archived sessions when the archived column is present', () => {
    const db = seedDb({ withArchivedColumn: true });
    const insert = db.prepare(
      `INSERT INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run('aaaaaaaa', 'adw_plan_build', 'live one', 'running', 'e1', '2024-01-01T00:00:00Z', null, 0, 0, 0);
    insert.run('bbbbbbbb', 'adw_plan_build', 'archived one', 'success', 'e1', '2024-01-01T00:00:00Z', null, 0, 0, 1);
    db.close();

    const trace = new TraceDb(dbPath);
    try {
      const sessions = trace.sessions();
      expect(sessions.map((s) => s.adw_id)).toEqual(['aaaaaaaa']);
    } finally {
      trace.close();
    }
  });

  it('liveProcesses returns only ended_at IS NULL rows, optionally filtered by kind', () => {
    const db = seedDb();
    const insert = db.prepare(
      `INSERT INTO processes (adw_id, kind, name, pid, command, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run('aaaaaaaa', 'adw', '', 111, 'uv run adws/adw_plan_build.py', '2024-01-01T00:00:00Z', null);
    insert.run('aaaaaaaa', 'agent', 'planner', 112, 'pi ...', '2024-01-01T00:00:01Z', null);
    insert.run('aaaaaaaa', 'agent', 'builder', 113, 'pi ...', '2024-01-01T00:00:02Z', '2024-01-01T00:01:00Z');
    db.close();

    const trace = new TraceDb(dbPath);
    try {
      const allLive = trace.liveProcesses();
      expect(allLive.length).toBe(2);
      expect(allLive.map((p) => p.pid).sort()).toEqual([111, 112]);

      const liveAgents = trace.liveProcesses('agent');
      expect(liveAgents.length).toBe(1);
      expect(liveAgents[0].pid).toBe(112);
      expect(liveAgents[0].name).toBe('planner');
    } finally {
      trace.close();
    }
  });

  it('liveProcesses returns [] when the processes table does not exist', () => {
    const db = seedDb({ withProcessesTable: false });
    db.close();

    const trace = new TraceDb(dbPath);
    try {
      expect(trace.liveProcesses()).toEqual([]);
      expect(trace.liveProcesses('agent')).toEqual([]);
    } finally {
      trace.close();
    }
  });
});

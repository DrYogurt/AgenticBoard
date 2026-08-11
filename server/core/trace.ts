import fs from 'fs';
import path from 'path';

// process.getBuiltinModule (not a static `import 'node:sqlite'`) — the test
// runner's esbuild-based transform doesn't yet recognize node:sqlite as a
// built-in and tries to resolve it as an npm package. A runtime lookup sidesteps
// that entirely since it isn't a specifier for any bundler to analyze.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/**
 * Read-only view over a project's SSSF trace db (adws/adw_data/sssf.db).
 *
 * Ported from super-simple-software-factory's visualizer (apps/visualizer/server/db.ts),
 * trimmed to the single-session case: AgenticBoard runs an ADW with
 * `--adw-id <task.id>`, so a task's adw_id IS its trace session id — there is
 * no multi-session listing to do here, the board's own task list is that index.
 */

export interface TraceSession {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: 'running' | 'success' | 'fail' | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  total_cost: number | null;
}

export interface TracePhase {
  phase_id: string;
  adw_id: string;
  seq: number | null;
  name: string | null;
  kind: 'engineer' | 'code' | 'agent' | null;
  owner: string | null;
  description: string | null;
  status: 'queued' | 'running' | 'success' | 'fail' | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface TraceAgentSession {
  adw_id: string;
  agent: string;
  coding_agent: string | null;
  model: string | null;
  session_id: string | null;
  color: string | null;
  context_tokens: number | null;
  context_window: number | null;
  created_at: string | null;
  last_used_at: string | null;
}

export interface TraceEvent {
  rowid: number;
  event_id: string;
  adw_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: string | null;
  name: string | null;
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface TraceUsage {
  read: number;
  written: number;
}

export interface TraceSessionDetail {
  session: TraceSession;
  usage: TraceUsage;
  phases: TracePhase[];
  agents: TraceAgentSession[];
}

export interface TraceEventsPage {
  events: TraceEvent[];
  cursor: number;
  has_more: boolean;
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export class TraceDb {
  readonly dbPath: string;
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly columnCache = new Map<string, boolean>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  close(): void {
    this.db.close();
  }

  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  session(adwId: string): TraceSession | null {
    const row = this.db
      .prepare(
        `SELECT adw_id, ${this.optionalColumn('sessions', 'adw_name')}, request,
                status, engineer, started_at, ended_at, total_tokens, total_cost
           FROM sessions WHERE adw_id = ?`
      )
      .get(adwId) as TraceSession | undefined;
    return row ?? null;
  }

  phases(adwId: string): TracePhase[] {
    return this.db
      .prepare(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id = ? ORDER BY seq, rowid`
      )
      .all(adwId) as TracePhase[];
  }

  agentSessions(adwId: string): TraceAgentSession[] {
    const results: TraceAgentSession[] = [];

    const color = this.optionalColumn('agent_sessions', 'color');
    const ctxUsed = this.optionalColumn('agent_sessions', 'context_tokens');
    const ctxWindow = this.optionalColumn('agent_sessions', 'context_window');

    const completed = this.db
      .prepare(
        `SELECT adw_id, agent, coding_agent, model, session_id, ${color},
                ${ctxUsed}, ${ctxWindow}, created_at, last_used_at
           FROM agent_sessions WHERE adw_id = ? ORDER BY created_at, agent`
      )
      .all(adwId) as TraceAgentSession[];
    results.push(...completed);

    const started = this.db
      .prepare(
        `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
           FROM events e JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.adw_id = ? AND e.type = 'agent_start'
          ORDER BY e.rowid`
      )
      .all(adwId) as { adw_id: string; agent: string | null; payload_json: string | null; started_at: string | null }[];

    for (const row of started) {
      if (!row.agent) continue;
      if (results.some((a) => a.agent === row.agent)) continue;
      let payload: { model?: string; session_id?: string; color?: string } = {};
      try {
        payload = JSON.parse(row.payload_json ?? '{}');
      } catch {
        // malformed payload just means no label
      }
      results.push({
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at
      });
    }
    return results;
  }

  usage(adwId: string): TraceUsage {
    const rows = this.db
      .prepare(`SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'`)
      .all(adwId) as { payload_json: string | null }[];

    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const usage = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!usage) continue;
        read += (usage.input_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
        written += usage.output_tokens ?? 0;
      } catch {
        // a payload written by an older tracer simply contributes nothing
      }
    }
    return { read, written };
  }

  sessionDetail(adwId: string): TraceSessionDetail | null {
    const session = this.session(adwId);
    if (!session) return null;
    return {
      session,
      usage: this.usage(adwId),
      phases: this.phases(adwId),
      agents: this.agentSessions(adwId)
    };
  }

  events(adwId: string, after = 0, limit = DEFAULT_LIMIT): TraceEventsPage {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const events = this.db
      .prepare(
        `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE adw_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`
      )
      .all(adwId, Math.max(0, after), cappedLimit) as TraceEvent[];

    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, after),
      has_more: events.length === cappedLimit
    };
  }

  /** Live-tracked pids from SSSF's own `processes` table (adw_id -> pid, ended_at IS NULL). */
  livePids(adwId: string): number[] {
    if (!this.tableExists('processes')) return [];
    const rows = this.db
      .prepare(`SELECT pid FROM processes WHERE adw_id = ? AND ended_at IS NULL`)
      .all(adwId) as { pid: number }[];
    return rows.map((r) => r.pid);
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    return !!row;
  }
}

/** Default location SSSF's tracer writes to, relative to a project's root. */
export const DEFAULT_TRACE_DB_RELATIVE = 'adws/adw_data/sssf.db';

export function resolveTraceDbPath(projectPath: string): string {
  return path.isAbsolute(DEFAULT_TRACE_DB_RELATIVE)
    ? DEFAULT_TRACE_DB_RELATIVE
    : path.resolve(projectPath, DEFAULT_TRACE_DB_RELATIVE);
}

export function openTraceDb(projectPath: string): TraceDb | null {
  const dbPath = resolveTraceDbPath(projectPath);
  if (!fs.existsSync(dbPath)) return null;
  return new TraceDb(dbPath);
}

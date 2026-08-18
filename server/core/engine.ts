import EventEmitter from 'events';
import { WorkspaceStorage, DEFAULT_ADWS } from './storage';
import {
  Board,
  Task,
  Project,
  Extension,
  Agent,
  Command,
  CommandResult,
  BoardEvent,
  ADW,
  RunHandle
} from './types';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { AdwRuntime, RunOutcome } from './runtime';
import { openTraceDb, TraceSession, resolveTraceDbPath } from './trace';

const MUTATION_COMMANDS = new Set([
  'create_task',
  'update_task',
  'move_task',
  'delete_task',
  'create_column',
  'rename_column',
  'delete_column',
  'reorder_columns',
  'archive_column_tasks',
  'create_project',
  'update_project',
  'delete_project',
  'register_extension',
  'remove_extension',
  'register_agent',
  'update_agent',
  'sync_sssf'
]);

/** How many most-recent sessions to consider per project on each sync pass —
 *  generous enough that a project with heavy direct-SSSF usage won't miss
 *  older still-relevant rows, cheap enough to run every few seconds. */
const SYNC_SESSION_SCAN_LIMIT = 500;

/** A real board column (satisfies the same referential-integrity invariants
 *  as any other — every task must belong to exactly one column with a
 *  matching status), auto-created on first use and deliberately never shown
 *  on the main kanban grid or offered as a manual move target — see
 *  app.js's own ARCHIVED_COLUMN_ID filtering. */
const ARCHIVED_COLUMN_ID = 'archived';

export class DeterministicEngine extends EventEmitter {
  private storage: WorkspaceStorage;
  private runtime: AdwRuntime;

  constructor(workspaceDir: string) {
    super();
    this.storage = new WorkspaceStorage(workspaceDir);
    this.runtime = new AdwRuntime(this.storage.workspaceDir);
  }

  public getWorkspaceDir(): string {
    return this.storage.workspaceDir;
  }

  public getActiveRuns(): RunHandle[] {
    return this.runtime.activeRuns();
  }

  public async executeCommand<T = any>(command: Command): Promise<CommandResult<T>> {
    try {
      let resultData: any;
      const isMutation = MUTATION_COMMANDS.has(command.type);

      if (isMutation) {
        // sync_sssf runs unattended on a timer and is a genuine no-op on most
        // ticks (nothing new to sync, nothing to reconcile). Every OTHER
        // mutation command is always user-initiated, so bumping board.revision
        // and emitting an event on every call is correct there. For sync_sssf
        // specifically, doing that unconditionally turns board.revision into a
        // fast-moving counter that silently invalidates every client's
        // in-flight expected_revision check — e.g. a "new task" form left open
        // for two tick intervals would reliably 409 on submit even though
        // nothing anyone cares about actually changed. So: skip the bump/write/
        // event entirely when this particular command made no real change.
        let mutated = true;

        resultData = await this.storage.withWorkspaceLock(async () => {
          if (command.expected_revision !== undefined) {
            const b = await this.storage.readBoard();
            if ((b.revision || 0) !== command.expected_revision) {
              throw new Error(`Conflict: expected revision ${command.expected_revision}, but current is ${b.revision || 0}`);
            }
          }

          const snapshot = this.storage.snapshotWorkspace();
          try {
            const res = await this.dispatchCommand(command);

            if (command.type === 'sync_sssf' && DeterministicEngine.isNoOpSyncResult(res)) {
              mutated = false;
              return res;
            }

            const board = await this.storage.readBoard();
            board.revision = (board.revision || 0) + 1;
            await this.storage.writeBoard(board);
            await this.validateStateInvariants();

            return res;
          } catch (err) {
            this.storage.rollbackWorkspace(snapshot);
            throw err;
          }
        });

        if (!mutated) {
          return { success: true, data: resultData };
        }

        let affected_ids: string[] = [];
        if (command.payload && (command.payload as any).id) {
          affected_ids.push((command.payload as any).id);
        } else if (resultData && Array.isArray(resultData.ids)) {
          affected_ids.push(...resultData.ids);
        } else if (resultData && resultData.id) {
          affected_ids.push(resultData.id);
        }

        let currentRevision = 0;
        try {
          const board = await this.storage.readBoard();
          currentRevision = board.revision || 0;
        } catch {}

        const event: BoardEvent = {
          id: uuidv4(),
          type: command.type,
          payload: { commandPayload: command.payload, resultData },
          timestamp: new Date().toISOString(),
          revision: currentRevision,
          affected_ids
        };
        this.emit('event', event);
      } else {
        resultData = await this.dispatchCommand(command);
      }

      return { success: true, data: resultData };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Internal command execution error',
        code: 'EXECUTION_ERROR'
      };
    }
  }

  private async dispatchCommand(command: Command): Promise<any> {
    switch (command.type) {
      case 'create_task':
        return await this.handleCreateTask(command.payload);
      case 'update_task':
        return await this.handleUpdateTask(command.payload);
      case 'move_task':
        return await this.handleMoveTask(command.payload);
      case 'delete_task':
        return await this.handleDeleteTask(command.payload);
      case 'get_task':
        return await this.handleGetTask(command.payload);
      case 'list_tasks':
        return await this.handleListTasks(command.payload);

      case 'create_column':
        return await this.handleCreateColumn(command.payload);
      case 'rename_column':
        return await this.handleRenameColumn(command.payload);
      case 'delete_column':
        return await this.handleDeleteColumn(command.payload);
      case 'reorder_columns':
        return await this.handleReorderColumns(command.payload);
      case 'archive_column_tasks':
        return await this.handleArchiveColumnTasks(command.payload);

      case 'create_project':
        return await this.handleCreateProject(command.payload);
      case 'get_project':
        return await this.handleGetProject(command.payload);
      case 'update_project':
        return await this.handleUpdateProject(command.payload);
      case 'delete_project':
        return await this.handleDeleteProject(command.payload);
      case 'list_projects':
        return await this.handleListProjects();
      case 'list_project_adws':
        return await this.handleListProjectAdws(command.payload);

      case 'start_task':
        return await this.handleStartTask(command.payload);
      case 'stop_task':
        return await this.handleStopTask(command.payload);
      case 'clear_task_run':
        return await this.handleClearTaskRun(command.payload);
      case 'sync_sssf':
        return await this.handleSyncSssf(command.payload);

      case 'register_extension':
        return await this.handleRegisterExtension(command.payload);
      case 'remove_extension':
        return await this.handleRemoveExtension(command.payload);
      case 'list_extensions':
        return await this.handleListExtensions();

      case 'register_agent':
        return await this.handleRegisterAgent(command.payload);
      case 'update_agent':
        return await this.handleUpdateAgent(command.payload);
      case 'list_agents':
        return await this.handleListAgents();

      case 'get_board':
        return await this.handleGetBoard();

      default:
        throw new Error(`Unknown command type: ${(command as any).type}`);
    }
  }

  private async generateTaskId(prefix: string): Promise<string> {
    const cleanPrefix = prefix.trim() || 'tasks';
    const tasks = await this.storage.listTasks();
    let maxId = 0;
    const escapedPrefix = cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedPrefix}-(\\d+)$`);
    for (const t of tasks) {
      const match = t.id.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxId) maxId = num;
      }
    }
    const nextNum = maxId + 1;
    const padded = String(nextNum).padStart(3, '0');
    return `${cleanPrefix}-${padded}`;
  }

  private async validateStateInvariants(): Promise<void> {
    const board = await this.storage.readBoard();
    const projects = await this.storage.readProjects();
    const tasks = await this.storage.listTasks();
    const check = this.storage.getValidator().validateReferentialIntegrity(board, projects, tasks);
    if (!check.valid) {
      throw new Error(`Referential integrity error: ${check.errors.join('; ')}`);
    }
  }

  // --- Task Handlers ---
  private async handleCreateTask(payload: {
    name?: string;
    title?: string;
    status?: string;
    project?: string;
    adw?: string;
    workflow?: string;
    description?: string;
  }): Promise<Task> {
    const taskName = (payload.name || payload.title || '').trim();
    if (!taskName) {
      throw new Error('Name or title is required to create a task');
    }

    const projects = await this.storage.readProjects();
    const projectId = payload.project || (projects[0] ? projects[0].id : 'tasks');
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) {
      throw new Error(`Project '${projectId}' not found`);
    }

    const projectAdws = proj.adws || [];
    const requestedAdw = payload.adw || payload.workflow;
    let adwId: string | undefined;
    if (requestedAdw) {
      if (!projectAdws.some((a) => a.id === requestedAdw)) {
        throw new Error(`ADW '${requestedAdw}' is not declared by project '${projectId}'`);
      }
      adwId = requestedAdw;
    } else {
      // No ADW requested: default to the project's first one for convenience
      // if it has any, otherwise this is a plain, non-agentic task — nothing
      // to default to, and that's fine.
      adwId = projectAdws[0]?.id;
    }

    const board = await this.storage.readBoard();
    // Default status is 'todo' by convention, not "whichever column is
    // leftmost" — column display order (e.g. 'failed' pinned first so it's
    // easy to triage) is independent of where new tasks should land.
    const defaultColumn = board.columns.find((c) => c.id === 'todo') || board.columns[0];
    const status = payload.status || (defaultColumn ? defaultColumn.id : 'todo');
    if (!board.columns.some((c) => c.id === status)) {
      throw new Error(`Column '${status}' does not exist on board`);
    }

    const taskId = await this.generateTaskId(projectId);
    const now = new Date().toISOString();

    const newTask: Task = {
      id: taskId,
      name: taskName,
      title: taskName,
      status: status,
      project: projectId,
      adw: adwId,
      description: payload.description || '',
      created_at: now,
      updated_at: now
    };

    await this.storage.writeTask(newTask);

    if (!board.task_order[status]) {
      board.task_order[status] = [];
    }
    if (!board.task_order[status].includes(taskId)) {
      board.task_order[status].push(taskId);
    }
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();

    return newTask;
  }

  private async handleUpdateTask(payload: {
    id: string;
    name?: string;
    title?: string;
    description?: string;
    project?: string;
    adw?: string;
    workflow?: string;
    status?: string;
  }): Promise<Task> {
    if (!payload.id) throw new Error('Task ID is required for update');

    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);

    if (payload.name !== undefined) {
      task.name = payload.name.trim();
      task.title = payload.name.trim();
    } else if (payload.title !== undefined) {
      task.name = payload.title.trim();
      task.title = payload.title.trim();
    }

    if (payload.description !== undefined) task.description = payload.description;

    const newProject = payload.project || task.project;
    const projects = await this.storage.readProjects();
    const proj = projects.find((p) => p.id === newProject);
    if (!proj) throw new Error(`Project '${newProject}' not found`);
    task.project = newProject;

    // An explicit empty string clears the ADW (opt out to a plain task);
    // omitting the field entirely keeps whatever the task already had.
    let newAdw: string | undefined;
    if (payload.adw !== undefined) {
      newAdw = payload.adw || undefined;
    } else if (payload.workflow !== undefined) {
      newAdw = payload.workflow || undefined;
    } else {
      newAdw = task.adw;
    }
    if (newAdw && !(proj.adws || []).some((a) => a.id === newAdw)) {
      throw new Error(`ADW '${newAdw}' is not declared by project '${newProject}'`);
    }
    task.adw = newAdw;
    task.updated_at = new Date().toISOString();

    await this.storage.writeTask(task);

    if (payload.status && payload.status !== task.status) {
      await this.handleMoveTask({ id: task.id, target_status: payload.status });
    }

    await this.validateStateInvariants();

    return (await this.storage.readTask(task.id))!;
  }

  private async handleMoveTask(payload: {
    id: string;
    target_status: string;
    target_index?: number;
  }): Promise<Task> {
    if (!payload.id || !payload.target_status) {
      throw new Error('Task ID and target_status are required');
    }

    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);

    const board = await this.storage.readBoard();
    const targetStatus = payload.target_status;

    if (!board.columns.some((c) => c.id === targetStatus)) {
      throw new Error(`Column '${targetStatus}' does not exist on board`);
    }

    const oldStatus = task.status;
    task.status = targetStatus;
    task.updated_at = new Date().toISOString();

    if (board.task_order[oldStatus]) {
      board.task_order[oldStatus] = board.task_order[oldStatus].filter((id) => id !== task.id);
    }

    if (!board.task_order[targetStatus]) {
      board.task_order[targetStatus] = [];
    }
    board.task_order[targetStatus] = board.task_order[targetStatus].filter((id) => id !== task.id);

    if (typeof payload.target_index === 'number' && payload.target_index >= 0) {
      board.task_order[targetStatus].splice(payload.target_index, 0, task.id);
    } else {
      board.task_order[targetStatus].push(task.id);
    }

    await this.storage.writeTask(task);
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();

    return task;
  }

  private async handleDeleteTask(payload: { id: string }): Promise<{ deleted: boolean; id: string }> {
    if (!payload.id) throw new Error('Task ID is required');

    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);

    await this.storage.deleteTask(payload.id);

    const board = await this.storage.readBoard();
    for (const colId of Object.keys(board.task_order)) {
      board.task_order[colId] = board.task_order[colId].filter((id) => id !== payload.id);
    }
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();

    return { deleted: true, id: payload.id };
  }

  private async handleGetTask(payload: { id: string }): Promise<Task> {
    if (!payload.id) throw new Error('Task ID is required');
    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);
    return task;
  }

  private async handleListTasks(payload?: { status?: string; project?: string }): Promise<Task[]> {
    let tasks = await this.storage.listTasks();
    if (payload?.status) {
      tasks = tasks.filter((t) => t.status === payload.status);
    }
    if (payload?.project) {
      tasks = tasks.filter((t) => t.project === payload.project);
    }
    return tasks;
  }

  // --- Task Runtime Handlers (Phase 3: SSSF ADW execution) ---
  private async handleStartTask(payload: { id: string }): Promise<RunHandle> {
    if (!payload.id) throw new Error('Task ID is required');
    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);
    if (!task.project) throw new Error(`Task '${task.id}' has no project assigned`);

    const projects = await this.storage.readProjects();
    const project = projects.find((p) => p.id === task.project);
    if (!project) throw new Error(`Project '${task.project}' not found`);

    if (!task.adw) throw new Error(`Task '${task.id}' has no ADW selected — nothing to run`);
    const adwEntry = (project.adws || []).find((a) => a.id === task.adw);
    if (!adwEntry) throw new Error(`ADW '${task.adw}' is not declared by project '${project.id}'`);

    const handle = this.runtime.start(task, project, adwEntry, (outcome) => {
      // Best-effort: on a genuine ADW finish (success or failure), move the
      // card so its outcome is visible without opening the task. A deliberate
      // stop leaves the column alone — that's the one outcome that isn't a
      // real verdict on the run.
      const targetColumn = DeterministicEngine.outcomeToColumn(outcome);
      if (!targetColumn) return;
      this.storage
        .readBoard()
        .then((board) => {
          if (board.columns.some((c) => c.id === targetColumn)) {
            return this.executeCommand({ type: 'move_task', payload: { id: task.id, target_status: targetColumn } });
          }
        })
        .catch(() => {});
    });

    // Best-effort: move the card into an "in-progress" column if the board has one.
    // Not required for the run itself, so a failure here never fails the start.
    try {
      const board = await this.storage.readBoard();
      if (task.status !== 'in-progress' && board.columns.some((c) => c.id === 'in-progress')) {
        await this.executeCommand({ type: 'move_task', payload: { id: task.id, target_status: 'in-progress' } });
      }
    } catch {}

    return handle;
  }

  private async handleStopTask(payload: { id: string }): Promise<{ stopped: boolean; pid?: number; message: string }> {
    if (!payload.id) throw new Error('Task ID is required');
    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);

    const projects = await this.storage.readProjects();
    const project = task.project ? projects.find((p) => p.id === task.project) : undefined;

    return this.runtime.stop(payload.id, project);
  }

  /** "Clear this task's run history and restart the pi coding session."
   *  A task's SSSF session lives entirely outside the workspace — a
   *  directory of files at <project>/adws/adw_data/sessions/<task.id>/
   *  (findings, envelopes, and each agent's own `pi_sessions/*.jsonl`
   *  transcript) plus rows in the project's own sssf.db keyed by adw_id
   *  (== task.id). Since `--adw-id` is create-or-continue (see runtime.ts),
   *  simply clicking "start" again would resume the old pi session rather
   *  than begin one — deleting both is what actually forces a fresh start.
   *  Stops any active run first: you cannot safely delete files (or open a
   *  second writable connection to sssf.db) a live process may still be
   *  using. The db rows are best-effort — TraceDb itself stays read-only
   *  (see trace.ts), this opens its own short-lived writable connection
   *  purely to delete this task's own rows, and failing that still leaves
   *  the session files cleared, which is what actually forces the next
   *  `pi` invocation to start a new session instead of resuming. */
  private async handleClearTaskRun(payload: { id: string }): Promise<{
    stopped: boolean;
    sessionCleared: boolean;
    dbRowsCleared: boolean;
    message: string;
  }> {
    if (!payload.id) throw new Error('Task ID is required');
    const task = await this.storage.readTask(payload.id);
    if (!task) throw new Error(`Task '${payload.id}' not found`);
    if (!task.project) throw new Error(`Task '${task.id}' has no project assigned`);

    const projects = await this.storage.readProjects();
    const project = projects.find((p) => p.id === task.project);
    if (!project) throw new Error(`Project '${task.project}' not found`);

    const stopResult = await this.runtime.stop(payload.id, project);

    const projectPath = path.resolve(project.path);
    const dbPath = resolveTraceDbPath(projectPath);
    const sessionsDir = path.resolve(path.dirname(dbPath), 'sessions');
    const sessionDir = path.resolve(sessionsDir, task.id);

    let sessionCleared = false;
    if (
      (sessionDir === sessionsDir || sessionDir.startsWith(sessionsDir + path.sep)) &&
      fs.existsSync(sessionDir)
    ) {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      sessionCleared = true;
    }

    let dbRowsCleared = false;
    if (fs.existsSync(dbPath)) {
      try {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
        const db = new DatabaseSync(dbPath);
        try {
          for (const table of ['gate_results', 'events', 'envelopes', 'agent_sessions', 'phases', 'processes', 'sessions']) {
            try {
              db.prepare(`DELETE FROM ${table} WHERE adw_id = ?`).run(task.id);
            } catch {
              // table doesn't exist in this SSSF version, or another writer
              // holds the db right now — leave it, session files are already gone.
            }
          }
          dbRowsCleared = true;
        } finally {
          db.close();
        }
      } catch {
        // best-effort — see doc comment above.
      }
    }

    return {
      stopped: stopResult.stopped,
      sessionCleared,
      dbRowsCleared,
      message: `cleared run history for task ${task.id}${stopResult.stopped ? ' (active run stopped)' : ''}`
    };
  }

  /** True when a sync_sssf result made no real change — nothing created,
   *  nothing reconciled — the case executeCommand uses to skip the revision
   *  bump/event for that particular call. */
  private static isNoOpSyncResult(res: any): boolean {
    return Array.isArray(res?.created) && res.created.length === 0 && Array.isArray(res?.moved) && res.moved.length === 0;
  }

  /** Pure outcome->column mapping for handleStartTask's onExit callback, split
   *  out so it's unit-testable without spawning a real ADW process. */
  private static outcomeToColumn(outcome: RunOutcome): string | null {
    if (outcome === 'fail') return 'failed';
    if (outcome === 'success') return 'ready-for-review';
    return null; // 'stopped' is not a verdict on the run — leave the column alone
  }

  /** Where a freshly-discovered (or just-created) task should land, based on
   *  its SSSF session's status, with graceful fallbacks if this board doesn't
   *  have the "natural" column for that status. */
  private static mapSessionStatusToColumn(board: Board, status: TraceSession['status']): string {
    const has = (id: string) => board.columns.some((c) => c.id === id);
    if (status === 'running' && has('in-progress')) return 'in-progress';
    if (status === 'success' && has('ready-for-review')) return 'ready-for-review';
    if (status === 'fail' && has('failed')) return 'failed';
    if (has('todo')) return 'todo';
    return board.columns[0]?.id ?? 'todo';
  }

  /**
   * Polls every registered project's SSSF trace db (or just one, if
   * `project_id` is given) for two things a board-only view would otherwise
   * miss entirely: ADWs started directly via SSSF (bypassing the board), and
   * board-started runs whose completion this process never saw (e.g. a server
   * restart lost AdwRuntime's in-memory tracking). See trace.ts's `sessions()`/
   * `session()` — SSSF itself has no push/hook mechanism, so polling is the
   * only option (confirmed: even SSSF's own visualizer works this way).
   *
   * Two steps per project, sharing one board read/write so a tick that touches
   * several projects still costs one lock + one validation + one SSE event:
   *  1. Create: any session id not already a task in that project (and not
   *     already tombstoned in sync-state.json, so a deleted synced task never
   *     resurrects) becomes a new task. `task.adw` is deliberately left unset —
   *     SSSF's `adw_name` (script filename) and `project.adws[].id` (board-
   *     declared workflow id) are different namespaces with no safe mapping,
   *     and an unset adw is already a valid, "can't be started from the board"
   *     state used elsewhere for plain tasks.
   *  2. Reconcile: tasks already in 'in-progress' whose session has since
   *     finished get moved — scoped to 'in-progress' ONLY so this never
   *     fights a user who dragged a card somewhere else by hand.
   * A malformed row must not fail the whole pass, so per-row errors are caught
   * and skipped rather than thrown.
   */
  private async handleSyncSssf(payload?: { project_id?: string }): Promise<{
    ids: string[];
    created: Task[];
    moved: { id: string; from: string; to: string }[];
  }> {
    const allProjects = await this.storage.readProjects();
    const projects = payload?.project_id ? allProjects.filter((p) => p.id === payload.project_id) : allProjects;

    const board = await this.storage.readBoard();
    const syncState = await this.storage.readSyncState();
    const created: Task[] = [];
    const moved: { id: string; from: string; to: string }[] = [];

    for (const project of projects) {
      let db;
      try {
        db = openTraceDb(project.path);
      } catch {
        continue;
      }
      if (!db) continue;

      try {
        const seen = new Set(syncState[project.id] || []);
        const allTasks = await this.storage.listTasks();
        const existingIds = new Set(allTasks.filter((t) => t.project === project.id).map((t) => t.id));

        // Step 1: create tasks for sessions this project's board doesn't know about yet.
        let sessions: TraceSession[] = [];
        try {
          sessions = db.sessions(SYNC_SESSION_SCAN_LIMIT);
        } catch {
          // a trace db mid-write or with an unexpected shape just yields nothing this tick
        }
        for (const session of sessions) {
          try {
            if (!session.adw_id || existingIds.has(session.adw_id) || seen.has(session.adw_id)) continue;

            const status = DeterministicEngine.mapSessionStatusToColumn(board, session.status);
            const now = new Date().toISOString();
            const label = (session.request || session.adw_id).slice(0, 200);
            const task: Task = {
              id: session.adw_id,
              name: label,
              title: label,
              status,
              project: project.id,
              description: session.request || '',
              created_at: session.started_at || now,
              updated_at: now
            };

            await this.storage.writeTask(task);
            if (!board.task_order[status]) board.task_order[status] = [];
            board.task_order[status].push(task.id);

            created.push(task);
            existingIds.add(task.id);
            seen.add(task.id);
          } catch {
            // one bad session row must not fail the whole sync pass
          }
        }

        // Step 2: reconcile in-progress tasks whose sessions have since finished.
        const inProgress = (await this.storage.listTasks()).filter(
          (t) => t.project === project.id && t.status === 'in-progress'
        );
        for (const task of inProgress) {
          try {
            const session = db.session(task.id);
            if (!session) continue;

            const target = session.status === 'success' ? 'ready-for-review' : session.status === 'fail' ? 'failed' : null;
            if (!target || !board.columns.some((c) => c.id === target)) continue;

            task.status = target;
            task.updated_at = new Date().toISOString();
            await this.storage.writeTask(task);

            board.task_order['in-progress'] = (board.task_order['in-progress'] || []).filter((id) => id !== task.id);
            if (!board.task_order[target]) board.task_order[target] = [];
            if (!board.task_order[target].includes(task.id)) board.task_order[target].push(task.id);

            moved.push({ id: task.id, from: 'in-progress', to: target });
          } catch {
            // one bad row must not fail the whole sync pass
          }
        }

        syncState[project.id] = Array.from(seen);
      } finally {
        db.close();
      }
    }

    // A no-op tick (nothing created, nothing reconciled) is by far the common
    // case on an unattended timer — skip the writes/validation entirely rather
    // than churning board.json/sync-state.json (and their locks) every tick
    // for content that didn't change.
    if (created.length > 0 || moved.length > 0) {
      await this.storage.writeBoard(board);
      await this.storage.writeSyncState(syncState);
      await this.validateStateInvariants();
    }

    return { ids: [...created.map((t) => t.id), ...moved.map((m) => m.id)], created, moved };
  }

  // --- Column Handlers ---
  private async handleCreateColumn(payload: { id: string; name: string; description?: string }): Promise<Board> {
    if (!payload.id || !payload.name) {
      throw new Error('Column id and name are required');
    }
    const board = await this.storage.readBoard();
    if (board.columns.some((c) => c.id === payload.id)) {
      throw new Error(`Column '${payload.id}' already exists`);
    }

    board.columns.push({
      id: payload.id,
      name: payload.name,
      description: payload.description || ''
    });
    if (!board.task_order[payload.id]) {
      board.task_order[payload.id] = [];
    }
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();
    return board;
  }

  private async handleRenameColumn(payload: { id: string; new_name: string }): Promise<Board> {
    if (!payload.id || !payload.new_name) {
      throw new Error('Column id and new_name are required');
    }
    const board = await this.storage.readBoard();
    const col = board.columns.find((c) => c.id === payload.id);
    if (!col) throw new Error(`Column '${payload.id}' not found`);

    col.name = payload.new_name;
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();
    return board;
  }

  private async handleDeleteColumn(payload: { id: string }): Promise<Board> {
    if (!payload.id) throw new Error('Column id is required');

    const tasks = await this.storage.listTasks();
    const referringTask = tasks.find((t) => t.status === payload.id);
    if (referringTask) {
      throw new Error(`Cannot delete column '${payload.id}': task '${referringTask.id}' belongs to this column`);
    }

    const board = await this.storage.readBoard();
    board.columns = board.columns.filter((c) => c.id !== payload.id);
    delete board.task_order[payload.id];
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();
    return board;
  }

  /** The column's own delete button no longer deletes the column — it
   *  archives everything in it instead (see app.js's confirm() dialog).
   *  Reuses handleMoveTask per task (not a bulk task_order splice) so every
   *  existing single-task invariant/side-effect stays correct without
   *  duplicating that logic; auto-creates the (hidden, never-deleted)
   *  Archived column on first use so this works on workspaces that
   *  predate this feature with no migration step. */
  private async handleArchiveColumnTasks(payload: { column_id: string }): Promise<{ archived: string[] }> {
    if (!payload.column_id) throw new Error('column_id is required');
    if (payload.column_id === ARCHIVED_COLUMN_ID) {
      throw new Error('The Archived column cannot archive itself');
    }

    const board = await this.storage.readBoard();
    if (!board.columns.some((c) => c.id === payload.column_id)) {
      throw new Error(`Column '${payload.column_id}' does not exist on board`);
    }
    if (!board.columns.some((c) => c.id === ARCHIVED_COLUMN_ID)) {
      board.columns.push({ id: ARCHIVED_COLUMN_ID, name: 'Archived' });
      await this.storage.writeBoard(board);
    }

    const tasks = await this.storage.listTasks();
    const toArchive = tasks.filter((t) => t.status === payload.column_id);
    const archivedIds: string[] = [];
    for (const task of toArchive) {
      const moved = await this.handleMoveTask({ id: task.id, target_status: ARCHIVED_COLUMN_ID });
      archivedIds.push(moved.id);
    }
    return { archived: archivedIds };
  }

  private async handleReorderColumns(payload: { column_ids: string[] }): Promise<Board> {
    if (!Array.isArray(payload.column_ids)) {
      throw new Error('column_ids array is required');
    }
    const board = await this.storage.readBoard();
    const colMap = new Map(board.columns.map((c) => [c.id, c]));
    const newCols: typeof board.columns = [];

    for (const id of payload.column_ids) {
      const c = colMap.get(id);
      if (c) newCols.push(c);
    }
    for (const c of board.columns) {
      if (!newCols.some((nc) => nc.id === c.id)) {
        newCols.push(c);
      }
    }
    board.columns = newCols;
    await this.storage.writeBoard(board);
    await this.validateStateInvariants();
    return board;
  }

  // --- Project Handlers ---
  private async handleCreateProject(payload: {
    id: string;
    name?: string;
    path: string;
    agent_files?: string[];
    adws?: ADW[];
    integrations?: any[];
    metadata?: Record<string, any>;
  }): Promise<Project> {
    if (!payload.id || !payload.path) {
      throw new Error('Project id and path are required');
    }
    const projects = await this.storage.readProjects();
    if (projects.some((p) => p.id === payload.id)) {
      throw new Error(`Project '${payload.id}' already exists`);
    }

    const newProj: Project = {
      id: payload.id,
      name: payload.name || payload.id,
      path: payload.path,
      agent_files: payload.agent_files || ['AGENTS.md'],
      // No fabricated placeholder ADWs — a project with none is a valid,
      // permanent state (a plain, non-agentic project). Register real ones
      // via update_project/register once SSSF (or another workflow) exists.
      adws: payload.adws || [],
      integrations: payload.integrations || [],
      metadata: payload.metadata || {},
      created_at: new Date().toISOString()
    };

    projects.push(newProj);
    await this.storage.writeProjects(projects);
    await this.validateStateInvariants();
    return newProj;
  }

  private async handleGetProject(payload: { id: string }): Promise<Project> {
    if (!payload.id) throw new Error('Project id is required');
    const projects = await this.storage.readProjects();
    const proj = projects.find((p) => p.id === payload.id);
    if (!proj) throw new Error(`Project '${payload.id}' not found`);
    return proj;
  }

  private async handleUpdateProject(payload: {
    id: string;
    name?: string;
    path?: string;
    agent_files?: string[];
    adws?: ADW[];
    integrations?: any[];
    metadata?: Record<string, any>;
  }): Promise<Project> {
    if (!payload.id) throw new Error('Project id is required');
    const projects = await this.storage.readProjects();
    const proj = projects.find((p) => p.id === payload.id);
    if (!proj) throw new Error(`Project '${payload.id}' not found`);

    if (payload.name) proj.name = payload.name;
    if (payload.path) proj.path = payload.path;
    if (payload.agent_files) proj.agent_files = payload.agent_files;
    if (payload.adws) proj.adws = payload.adws;
    if (payload.integrations) proj.integrations = payload.integrations;
    if (payload.metadata) proj.metadata = payload.metadata;

    await this.storage.writeProjects(projects);
    await this.validateStateInvariants();
    return proj;
  }

  private async handleDeleteProject(payload: { id: string }): Promise<{ deleted: boolean; id: string }> {
    if (!payload.id) throw new Error('Project id is required');

    const tasks = await this.storage.listTasks();
    const referringTask = tasks.find((t) => t.project === payload.id);
    if (referringTask) {
      throw new Error(`Cannot delete project '${payload.id}': task '${referringTask.id}' belongs to this project`);
    }

    let projects = await this.storage.readProjects();
    const initialLen = projects.length;
    projects = projects.filter((p) => p.id !== payload.id);
    if (projects.length === initialLen) {
      throw new Error(`Project '${payload.id}' not found`);
    }
    await this.storage.writeProjects(projects);
    await this.validateStateInvariants();
    return { deleted: true, id: payload.id };
  }

  private async handleListProjects(): Promise<Project[]> {
    return await this.storage.readProjects();
  }

  private async handleListProjectAdws(payload: { id: string }): Promise<ADW[]> {
    if (!payload.id) throw new Error('Project id is required');
    const projects = await this.storage.readProjects();
    const proj = projects.find((p) => p.id === payload.id);
    if (!proj) throw new Error(`Project '${payload.id}' not found`);
    return proj.adws || [...DEFAULT_ADWS];
  }

  // --- Extension Handlers ---
  private async handleRegisterExtension(payload: {
    id: string;
    type: string;
    url: string;
    config?: Record<string, any>;
  }): Promise<Extension> {
    if (!payload.id || !payload.type || !payload.url) {
      throw new Error('Extension id, type, and url are required');
    }
    const extensions = await this.storage.readExtensions();
    const existingIndex = extensions.findIndex((e) => e.id === payload.id);

    const extObj: Extension = {
      id: payload.id,
      type: payload.type,
      url: payload.url,
      config: payload.config || {},
      created_at: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      extensions[existingIndex] = extObj;
    } else {
      extensions.push(extObj);
    }

    await this.storage.writeExtensions(extensions);
    return extObj;
  }

  private async handleRemoveExtension(payload: { id: string }): Promise<{ removed: boolean; id: string }> {
    if (!payload.id) throw new Error('Extension id is required');
    let extensions = await this.storage.readExtensions();
    const len = extensions.length;
    extensions = extensions.filter((e) => e.id !== payload.id);
    if (extensions.length === len) {
      throw new Error(`Extension '${payload.id}' not found`);
    }
    await this.storage.writeExtensions(extensions);
    return { removed: true, id: payload.id };
  }

  private async handleListExtensions(): Promise<Extension[]> {
    return await this.storage.readExtensions();
  }

  // --- Agent Handlers ---
  private async handleRegisterAgent(payload: {
    id: string;
    name: string;
    type?: string;
    status?: string;
  }): Promise<Agent> {
    if (!payload.id || !payload.name) {
      throw new Error('Agent id and name are required');
    }
    const agents = await this.storage.readAgents();
    const existingIndex = agents.findIndex((a) => a.id === payload.id);

    const agObj: Agent = {
      id: payload.id,
      name: payload.name,
      type: payload.type || 'generic',
      status: payload.status || 'idle',
      current_task: null,
      created_at: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      agents[existingIndex] = agObj;
    } else {
      agents.push(agObj);
    }

    await this.storage.writeAgents(agents);
    return agObj;
  }

  private async handleUpdateAgent(payload: {
    id: string;
    status?: string;
    current_task?: string | null;
  }): Promise<Agent> {
    if (!payload.id) throw new Error('Agent id is required');
    const agents = await this.storage.readAgents();
    const ag = agents.find((a) => a.id === payload.id);
    if (!ag) throw new Error(`Agent '${payload.id}' not found`);

    if (payload.status !== undefined) ag.status = payload.status;
    if (payload.current_task !== undefined) ag.current_task = payload.current_task;

    await this.storage.writeAgents(agents);
    return ag;
  }

  private async handleListAgents(): Promise<Agent[]> {
    return await this.storage.readAgents();
  }

  // --- Board State Handler ---
  private async handleGetBoard(): Promise<{ board: Board; tasks: Task[]; projects: Project[]; extensions: Extension[]; agents: Agent[] }> {
    const board = await this.storage.readBoard();
    const tasks = await this.storage.listTasks();
    const projects = await this.storage.readProjects();
    const extensions = await this.storage.readExtensions();
    const agents = await this.storage.readAgents();
    
    try {
      const check = this.storage.getValidator().validateReferentialIntegrity(board, projects, tasks);
      if (!check.valid) {
        console.warn(`[WARNING] Workspace is in an invalid state: ${check.errors.join('; ')}`);
      }
    } catch (err: any) {
      console.warn(`[WARNING] Failed to validate workspace state: ${err.message}`);
    }

    return { board, tasks, projects, extensions, agents };
  }
}

import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { Board, Task, Project, Extension, Agent, ADW } from './types';
import { SchemaValidator } from './validator';

export const DEFAULT_ADWS: ADW[] = [
  { id: 'implement-feature', path: './workflows/implement-feature' },
  { id: 'fix-bug', path: './workflows/fix-bug' }
];

export class WorkspaceStorage {
  public workspaceDir: string;
  private validator: SchemaValidator;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    const schemasDir = path.join(this.workspaceDir, 'schemas');
    const possibleFallbackDirs = [
      path.join(__dirname, 'schemas'),
      path.join(__dirname, '../../../server/core/schemas'),
      path.join(__dirname, '../../server/core/schemas'),
      path.join(process.cwd(), 'server/core/schemas'),
      path.join(process.cwd(), 'core/schemas'),
      path.join(process.cwd(), 'schemas'),
      path.join(__dirname, '../schemas'),
      path.join(__dirname, '../../schemas')
    ];
    const fallbackSchemasDir = fs.existsSync(schemasDir)
      ? schemasDir
      : (possibleFallbackDirs.find((d) => fs.existsSync(d)) || possibleFallbackDirs[0]);
    this.validator = new SchemaValidator(fallbackSchemasDir);
    
    // Auto-migrate workspace data on instantiation if workspace exists and needs migration
    if (fs.existsSync(path.join(this.workspaceDir, 'board.json'))) {
      this.ensureBoardColumns();
      if (this.needsMigration()) {
        this.migrateWorkspaceData();
      }
    }
  }

  public getValidator(): SchemaValidator {
    return this.validator;
  }

  // Columns that must exist on every board, added here (rather than baked only
  // into initWorkspace's default) so an EXISTING workspace's board.json also
  // picks them up on next boot — a board-shape addition, not a task/project
  // field migration, so it's deliberately separate from needsMigration()/
  // migrateWorkspaceData() below.
  private static readonly REQUIRED_COLUMNS: { id: string; name: string; description: string; after: string }[] = [
    {
      id: 'ready-for-review',
      name: 'Ready for Review',
      description: 'ADW runs that finished successfully — review before marking done',
      after: 'in-progress'
    }
  ];

  private ensureBoardColumns(): void {
    const boardPath = path.join(this.workspaceDir, 'board.json');
    if (!fs.existsSync(boardPath)) return;
    let board: Board;
    try {
      board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    } catch {
      return; // malformed board.json is handled (and reported) by readBoard()
    }

    let changed = false;
    for (const col of WorkspaceStorage.REQUIRED_COLUMNS) {
      if (board.columns.some((c) => c.id === col.id)) continue;
      const afterIdx = board.columns.findIndex((c) => c.id === col.after);
      board.columns.splice(afterIdx >= 0 ? afterIdx + 1 : board.columns.length, 0, {
        id: col.id,
        name: col.name,
        description: col.description
      });
      if (!board.task_order[col.id]) board.task_order[col.id] = [];
      changed = true;
    }
    if (changed) this.atomicWriteJSON(boardPath, board);
  }

  public static initWorkspace(targetDir: string): void {
    const absPath = path.resolve(targetDir);
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(absPath, { recursive: true });
    }

    const subdirs = ['tasks', 'projects', 'schemas'];
    for (const subdir of subdirs) {
      const p = path.join(absPath, subdir);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
    }

    // Copy schemas if not present in target workspace
    const possibleSchemaSourceDirs = [
      path.join(__dirname, 'schemas'),
      path.join(__dirname, '../../../server/core/schemas'),
      path.join(__dirname, '../../server/core/schemas'),
      path.join(process.cwd(), 'server/core/schemas'),
      path.join(process.cwd(), 'core/schemas'),
      path.join(process.cwd(), 'schemas'),
      path.join(__dirname, '../../schemas')
    ];
    const defaultSchemasDir = possibleSchemaSourceDirs.find((d) => fs.existsSync(d));
    if (defaultSchemasDir) {
      const files = fs.readdirSync(defaultSchemasDir);
      for (const f of files) {
        const dest = path.join(absPath, 'schemas', f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(defaultSchemasDir, f), dest);
        }
      }
    }

    // Default board.json
    const boardPath = path.join(absPath, 'board.json');
    if (!fs.existsSync(boardPath)) {
      const defaultBoard: Board = {
        title: 'Software Factory Board',
        columns: [
          { id: 'failed', name: 'Failed', description: 'ADW runs that ended in failure — re-run from here' },
          { id: 'todo', name: 'To Do', description: 'Tasks pending work' },
          { id: 'in-progress', name: 'In Progress', description: 'Tasks currently active' },
          { id: 'ready-for-review', name: 'Ready for Review', description: 'ADW runs that finished successfully — review before marking done' },
          { id: 'done', name: 'Done', description: 'Completed tasks' }
        ],
        task_order: {
          'failed': [],
          'todo': [],
          'in-progress': [],
          'ready-for-review': [],
          'done': []
        },
        updated_at: new Date().toISOString()
      };
      fs.writeFileSync(boardPath, JSON.stringify(defaultBoard, null, 2), 'utf8');
    }

    // Default projects.json
    const projectsPath = path.join(absPath, 'projects.json');
    if (!fs.existsSync(projectsPath)) {
      const defaultProjects: Project[] = [
        {
          id: 'tasks',
          name: 'tasks',
          path: '.',
          agent_files: ['AGENTS.md'],
          adws: [...DEFAULT_ADWS],
          integrations: [],
          metadata: {},
          created_at: new Date().toISOString()
        }
      ];
      fs.writeFileSync(projectsPath, JSON.stringify(defaultProjects, null, 2), 'utf8');
    }

    // Default extensions.json
    const extensionsPath = path.join(absPath, 'extensions.json');
    if (!fs.existsSync(extensionsPath)) {
      fs.writeFileSync(extensionsPath, JSON.stringify([], null, 2), 'utf8');
    }

    // Default agents.json
    const agentsPath = path.join(absPath, 'agents.json');
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), 'utf8');
    }

    // Default sync-state.json — tombstones adw_ids the SSSF sync pass has
    // already synced, per project, so a deleted synced task is never
    // recreated just because its underlying SSSF session row still exists.
    const syncStatePath = path.join(absPath, 'sync-state.json');
    if (!fs.existsSync(syncStatePath)) {
      fs.writeFileSync(syncStatePath, JSON.stringify({}, null, 2), 'utf8');
    }
  }

  private atomicWriteJSON(filePath: string, data: any): void {
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  public async withWorkspaceLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const lockFilePath = path.join(this.workspaceDir, '.workspace.lock');
    if (!fs.existsSync(lockFilePath)) {
      WorkspaceStorage.initWorkspace(this.workspaceDir); // Ensure dirs exist
      fs.writeFileSync(lockFilePath, '', 'utf8');
    }
    const release = await lockfile.lock(lockFilePath, { 
      retries: { retries: 100, minTimeout: 10, maxTimeout: 200 },
      realpath: false 
    });
    try {
      return await fn();
    } finally {
      try { await release(); } catch {}
    }
  }

  private async withLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
    if (!fs.existsSync(filePath)) {
      this.atomicWriteJSON(filePath, {});
    }
    const release = await lockfile.lock(filePath, { 
      retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
      realpath: false 
    });
    try {
      return await fn();
    } finally {
      try { await release(); } catch {}
    }
  }

  // --- Path helpers (used by engine for transactional snapshots) ---
  public getBoardPath(): string {
    return path.join(this.workspaceDir, 'board.json');
  }

  public getTaskPath(id: string): string {
    return path.join(this.workspaceDir, 'tasks', `${id}.json`);
  }

  public getProjectsPath(): string {
    return path.join(this.workspaceDir, 'projects.json');
  }

  // --- Snapshot / Rollback for transactional multi-file writes ---
  public snapshotFiles(paths: string[]): Map<string, Buffer | null> {
    const snapshot = new Map<string, Buffer | null>();
    for (const p of paths) {
      if (fs.existsSync(p)) {
        snapshot.set(p, fs.readFileSync(p));
      } else {
        snapshot.set(p, null);
      }
    }
    return snapshot;
  }

  public getSyncStatePath(): string {
    return path.join(this.workspaceDir, 'sync-state.json');
  }

  public snapshotWorkspace(): Map<string, Buffer | null> {
    const paths: string[] = [
      this.getBoardPath(),
      this.getProjectsPath(),
      path.join(this.workspaceDir, 'extensions.json'),
      path.join(this.workspaceDir, 'agents.json'),
      this.getSyncStatePath()
    ];
    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          paths.push(path.join(tasksDir, f));
        }
      }
    }
    return this.snapshotFiles(paths);
  }

  public rollbackFiles(snapshot: Map<string, Buffer | null>): void {
    for (const [filePath, content] of snapshot) {
      if (content === null) {
        // File didn't exist before — delete it
        try { fs.unlinkSync(filePath); } catch {}
      } else {
        // Restore original content
        fs.writeFileSync(filePath, content);
      }
    }
  }

  public rollbackWorkspace(snapshot: Map<string, Buffer | null>): void {
    this.rollbackFiles(snapshot);
    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          const fullPath = path.join(tasksDir, f);
          if (!snapshot.has(fullPath)) {
            try { fs.unlinkSync(fullPath); } catch {}
          }
        }
      }
    }
  }

  private getLegacyDataDirs(): string[] {
    const dirs = [
      path.join(this.workspaceDir, 'core', 'data'),
      path.join(this.workspaceDir, 'server', 'core', 'data')
    ];
    return Array.from(new Set(dirs)).filter(
      (d) => fs.existsSync(d) && path.resolve(d) !== path.resolve(this.workspaceDir)
    );
  }

  public needsMigration(): boolean {
    if (this.getLegacyDataDirs().length > 0) return true;

    const pPath = path.join(this.workspaceDir, 'projects.json');
    if (fs.existsSync(pPath)) {
      try {
        const projects: Project[] = JSON.parse(fs.readFileSync(pPath, 'utf8'));
        for (const proj of projects) {
          // adws.length === 0 is a legitimate, permanent state (a project
          // that only ever hosts plain, non-agentic tasks) — not a sign of
          // un-migrated legacy data, so it must not force a migration pass.
          if (!proj.integrations || !proj.metadata) {
            return true;
          }
        }
      } catch {
        return true;
      }
    }

    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(tasksDir, f), 'utf8');
            const taskObj = JSON.parse(raw);
            if (taskObj.title && !taskObj.name) return true;
            // A missing adw is a legitimate, permanent state (a plain,
            // non-agentic task) — not a sign of un-migrated legacy data.
            if (!taskObj.name || !taskObj.project || 'agent' in taskObj) return true;
          } catch {
            return true;
          }
        }
      }
    }

    return false;
  }

  public migrateWorkspaceData(): void {
    // 1. Create a backup before modifying anything
    const backupDir = path.join(this.workspaceDir, '.backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    
    const filesToBackup = ['projects.json', 'board.json'];
    for (const file of filesToBackup) {
      const srcPath = path.join(this.workspaceDir, file);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(backupDir, file));
      }
    }

    const tasksSrcDir = path.join(this.workspaceDir, 'tasks');
    if (fs.existsSync(tasksSrcDir)) {
      const tasksDestDir = path.join(backupDir, 'tasks');
      fs.mkdirSync(tasksDestDir, { recursive: true });
      const files = fs.readdirSync(tasksSrcDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.copyFileSync(path.join(tasksSrcDir, file), path.join(tasksDestDir, file));
        }
      }
    }
    console.log(`[AgenticBoard] Workspace backup created at ${backupDir}`);

    // 2. Consolidate legacy data directories
    const legacyDirs = this.getLegacyDataDirs();
    for (const legacyDir of legacyDirs) {
      const legacyTasksDir = path.join(legacyDir, 'tasks');
      if (fs.existsSync(legacyTasksDir)) {
        const destTasksDir = path.join(this.workspaceDir, 'tasks');
        if (!fs.existsSync(destTasksDir)) {
          fs.mkdirSync(destTasksDir, { recursive: true });
        }
        const legacyFiles = fs.readdirSync(legacyTasksDir);
        for (const f of legacyFiles) {
          if (f.endsWith('.json')) {
            const srcFile = path.join(legacyTasksDir, f);
            const destFile = path.join(destTasksDir, f);
            if (!fs.existsSync(destFile)) {
              fs.copyFileSync(srcFile, destFile);
            }
          }
        }
      }

      // Check for stranded root json files in legacyDir
      const rootFiles = ['projects.json', 'board.json', 'extensions.json', 'agents.json'];
      for (const rf of rootFiles) {
        const srcRf = path.join(legacyDir, rf);
        const destRf = path.join(this.workspaceDir, rf);
        if (fs.existsSync(srcRf) && !fs.existsSync(destRf)) {
          fs.copyFileSync(srcRf, destRf);
        }
      }
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {}
    }

    const pPath = path.join(this.workspaceDir, 'projects.json');
    let projects: Project[] = [];
    if (fs.existsSync(pPath)) {
      try {
        projects = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      } catch (err) {
        throw new Error(`Malformed JSON in projects.json: ${(err as Error).message}`);
      }
    }

    let projectsModified = false;
    for (const proj of projects) {
      // Deliberately not backfilling DEFAULT_ADWS onto adws-less projects
      // here — that's now a valid permanent state, not something to migrate.
      if (!proj.integrations) {
        proj.integrations = [];
        projectsModified = true;
      }
      if (!proj.metadata) {
        proj.metadata = {};
        projectsModified = true;
      }
    }
    if (projectsModified) {
      this.atomicWriteJSON(pPath, projects);
    }

    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          const taskPath = path.join(tasksDir, f);
          let taskObj: any;
          try {
            const raw = fs.readFileSync(taskPath, 'utf8');
            taskObj = JSON.parse(raw);
          } catch (err) {
            throw new Error(`Malformed JSON in task file '${f}': ${(err as Error).message}`);
          }

          let taskModified = false;
          if (taskObj.title && !taskObj.name) {
            taskObj.name = taskObj.title;
            taskModified = true;
          }
          if (!taskObj.name) {
            taskObj.name = taskObj.title || f.replace('.json', '');
            taskModified = true;
          }
          if (!taskObj.project) {
            taskObj.project = projects[0]?.id || 'tasks';
            taskModified = true;
          }
          // Deliberately not backfilling a default adw here — a missing one
          // is now a valid permanent state (a plain, non-agentic task).
          if ('agent' in taskObj) {
            delete taskObj.agent;
            taskModified = true;
          }

          if (taskModified) {
            this.atomicWriteJSON(taskPath, taskObj);
          }
        }
      }
    }
  }

  // Board
  public async readBoard(): Promise<Board> {
    const boardPath = path.join(this.workspaceDir, 'board.json');
    if (!fs.existsSync(boardPath)) {
      WorkspaceStorage.initWorkspace(this.workspaceDir);
    }
    let content: string;
    try {
      content = fs.readFileSync(boardPath, 'utf8');
    } catch (err) {
      throw new Error(`Malformed JSON in board.json: ${(err as Error).message}`);
    }
    const board: Board = JSON.parse(content);
    const valResult = this.validator.validate('board', board);
    if (!valResult.valid) {
      throw new Error(`Board schema validation error: ${valResult.errors?.join(', ')}`);
    }
    return board;
  }

  public async writeBoard(board: Board): Promise<void> {
    const boardPath = path.join(this.workspaceDir, 'board.json');
    board.updated_at = new Date().toISOString();
    
    const valResult = this.validator.validate('board', board);
    if (!valResult.valid) {
      throw new Error(`Board schema validation error: ${valResult.errors?.join(', ')}`);
    }

    await this.withLock(boardPath, () => {
      this.atomicWriteJSON(boardPath, board);
    });
  }

  // Tasks
  public async readTask(id: string): Promise<Task | null> {
    const taskPath = path.join(this.workspaceDir, 'tasks', `${id}.json`);
    if (!fs.existsSync(taskPath)) return null;
    let content: string;
    try {
      content = fs.readFileSync(taskPath, 'utf8');
    } catch (err) {
      throw new Error(`Malformed JSON in task file '${id}.json': ${(err as Error).message}`);
    }
    const task: Task = JSON.parse(content);
    const valResult = this.validator.validate('task', task);
    if (!valResult.valid) {
      throw new Error(`Task schema validation error for '${id}': ${valResult.errors?.join(', ')}`);
    }
    return task;
  }

  public async writeTask(task: Task): Promise<void> {
    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }
    const taskPath = path.join(tasksDir, `${task.id}.json`);
    
    const valResult = this.validator.validate('task', task);
    if (!valResult.valid) {
      throw new Error(`Task schema validation error: ${valResult.errors?.join(', ')}`);
    }

    await this.withLock(taskPath, () => {
      this.atomicWriteJSON(taskPath, task);
    });
  }

  public async deleteTask(id: string): Promise<boolean> {
    const taskPath = path.join(this.workspaceDir, 'tasks', `${id}.json`);
    if (!fs.existsSync(taskPath)) return false;
    fs.unlinkSync(taskPath);
    return true;
  }

  public async listTasks(): Promise<Task[]> {
    const tasksDir = path.join(this.workspaceDir, 'tasks');
    if (!fs.existsSync(tasksDir)) return [];
    const files = fs.readdirSync(tasksDir);
    const tasks: Task[] = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        let content: string;
        try {
          content = fs.readFileSync(path.join(tasksDir, f), 'utf8');
          tasks.push(JSON.parse(content));
        } catch (err) {
          throw new Error(`Malformed JSON in task file '${f}': ${(err as Error).message}`);
        }
      }
    }
    return tasks;
  }

  // Projects
  public async readProjects(): Promise<Project[]> {
    const pPath = path.join(this.workspaceDir, 'projects.json');
    if (!fs.existsSync(pPath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(pPath, 'utf8');
    } catch (err) {
      throw new Error(`Malformed JSON in projects.json: ${(err as Error).message}`);
    }
    return JSON.parse(content);
  }

  public async writeProjects(projects: Project[]): Promise<void> {
    const pPath = path.join(this.workspaceDir, 'projects.json');
    for (const proj of projects) {
      const valResult = this.validator.validate('project', proj);
      if (!valResult.valid) {
        throw new Error(`Project schema validation error for ${proj.id}: ${valResult.errors?.join(', ')}`);
      }
    }
    await this.withLock(pPath, () => {
      this.atomicWriteJSON(pPath, projects);
    });
  }

  // Extensions
  public async readExtensions(): Promise<Extension[]> {
    const ePath = path.join(this.workspaceDir, 'extensions.json');
    if (!fs.existsSync(ePath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(ePath, 'utf8');
    } catch (err) {
      throw new Error(`Malformed JSON in extensions.json: ${(err as Error).message}`);
    }
    return JSON.parse(content);
  }

  public async writeExtensions(extensions: Extension[]): Promise<void> {
    const ePath = path.join(this.workspaceDir, 'extensions.json');
    for (const ext of extensions) {
      const valResult = this.validator.validate('extension', ext);
      if (!valResult.valid) {
        throw new Error(`Extension schema validation error for ${ext.id}: ${valResult.errors?.join(', ')}`);
      }
    }
    await this.withLock(ePath, () => {
      this.atomicWriteJSON(ePath, extensions);
    });
  }

  // Agents
  public async readAgents(): Promise<Agent[]> {
    const aPath = path.join(this.workspaceDir, 'agents.json');
    if (!fs.existsSync(aPath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(aPath, 'utf8');
    } catch (err) {
      throw new Error(`Malformed JSON in agents.json: ${(err as Error).message}`);
    }
    return JSON.parse(content);
  }

  public async writeAgents(agents: Agent[]): Promise<void> {
    const aPath = path.join(this.workspaceDir, 'agents.json');
    for (const ag of agents) {
      const valResult = this.validator.validate('agent', ag);
      if (!valResult.valid) {
        throw new Error(`Agent schema validation error for ${ag.id}: ${valResult.errors?.join(', ')}`);
      }
    }
    await this.withLock(aPath, () => {
      this.atomicWriteJSON(aPath, agents);
    });
  }

  // Sync state — internal bookkeeping for the SSSF sync pass (which adw_ids
  // have already been synced per project), not part of the public data model,
  // so it's deliberately not schema-validated like the collections above.
  public async readSyncState(): Promise<Record<string, string[]>> {
    const sPath = this.getSyncStatePath();
    if (!fs.existsSync(sPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(sPath, 'utf8'));
    } catch {
      return {};
    }
  }

  public async writeSyncState(state: Record<string, string[]>): Promise<void> {
    const sPath = this.getSyncStatePath();
    await this.withLock(sPath, () => {
      this.atomicWriteJSON(sPath, state);
    });
  }
}


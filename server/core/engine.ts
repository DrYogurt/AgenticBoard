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
import { AdwRuntime } from './runtime';

const MUTATION_COMMANDS = new Set([
  'create_task',
  'update_task',
  'move_task',
  'delete_task',
  'create_column',
  'rename_column',
  'delete_column',
  'reorder_columns',
  'create_project',
  'update_project',
  'delete_project',
  'register_extension',
  'remove_extension',
  'register_agent',
  'update_agent'
]);

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

        let affected_ids: string[] = [];
        if (command.payload && (command.payload as any).id) {
          affected_ids.push((command.payload as any).id);
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

    const adwId = payload.adw || payload.workflow || (proj.adws && proj.adws[0] ? proj.adws[0].id : 'implement-feature');
    if (!proj.adws || !proj.adws.some((a) => a.id === adwId)) {
      throw new Error(`ADW '${adwId}' is not declared by project '${projectId}'`);
    }

    const board = await this.storage.readBoard();
    const status = payload.status || (board.columns[0] ? board.columns[0].id : 'todo');
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

    const newAdw = payload.adw || payload.workflow || task.adw;
    if (!proj.adws || !proj.adws.some((a) => a.id === newAdw)) {
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

    const adwEntry = (project.adws || []).find((a) => a.id === task.adw);
    if (!adwEntry) throw new Error(`ADW '${task.adw}' is not declared by project '${project.id}'`);

    const handle = this.runtime.start(task, project, adwEntry);

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
      adws: payload.adws && payload.adws.length > 0 ? payload.adws : [...DEFAULT_ADWS],
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

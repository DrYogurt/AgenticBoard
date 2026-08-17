export type TaskStatus = string;

export interface ADWParameter {
  name: string;
  flag: string;
  type: 'string' | 'number' | 'boolean';
  label?: string;
  default?: string | number | boolean;
}

export interface ADW {
  id: string;
  path: string;
  name?: string;
  model?: string;
  agents?: string[];
  parameters?: ADWParameter[];
}

export interface Task {
  id: string;
  name: string;
  title?: string;
  status: TaskStatus;
  project: string;
  /** Optional: a task with no ADW is a plain, non-agentic checklist item —
   *  there's nothing for start_task to run. */
  adw?: string;
  description?: string;
  /** Values for the chosen ADW's declared `parameters[]`, keyed by name. */
  parameter_values?: Record<string, string | number | boolean>;
  created_at?: string;
  updated_at?: string;
}

export interface Project {
  id: string;
  name?: string;
  path: string;
  agent_files?: string[];
  adws?: ADW[];
  integrations?: any[];
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface Extension {
  id: string;
  type: string;
  url: string;
  config?: Record<string, any>;
  created_at?: string;
}

export interface Agent {
  id: string;
  name: string;
  type?: string;
  status?: string;
  current_task?: string | null;
  created_at?: string;
  model?: string;
  system_prompt?: string;
  parameters?: ADWParameter[];
}

export interface BoardColumn {
  id: string;
  name: string;
  description?: string;
}

export interface Board {
  title: string;
  columns: BoardColumn[];
  task_order: Record<string, string[]>;
  updated_at?: string;
  revision?: number;
}

export type CommandType =
  | 'create_task'
  | 'update_task'
  | 'delete_task'
  | 'move_task'
  | 'get_task'
  | 'list_tasks'
  | 'create_column'
  | 'rename_column'
  | 'delete_column'
  | 'reorder_columns'
  | 'create_project'
  | 'get_project'
  | 'update_project'
  | 'delete_project'
  | 'list_projects'
  | 'list_project_adws'
  | 'start_task'
  | 'stop_task'
  | 'sync_sssf'
  | 'register_extension'
  | 'remove_extension'
  | 'list_extensions'
  | 'register_agent'
  | 'update_agent'
  | 'delete_agent'
  | 'list_agents'
  | 'get_board';

export interface Command<T = any> {
  type: CommandType;
  payload: T;
  timestamp?: string;
  expected_revision?: number;
}

export interface CommandResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface BoardEvent {
  id: string;
  type: string;
  payload: any;
  timestamp: string;
  revision: number;
  affected_ids: string[];
}

export type RunStatus = 'starting' | 'running' | 'success' | 'fail' | 'stopped';

export interface RunHandle {
  task_id: string;
  adw_id: string;
  project_id: string;
  pid: number;
  status: RunStatus;
  started_at: string;
  ended_at?: string;
  log_path: string;
}

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import http from 'http';
import path from 'path';
import { WorkspaceStorage } from '../core/storage';
import { BoardServer } from '../index';
import { Task, Project, Extension, Board, ADW } from '../core/types';

const program = new Command();
program
  .name('factory')
  .description('AI Software Factory — Deterministic Kanban CLI')
  .version('0.1.0')
  .option('-w, --workspace <path>', 'Workspace directory path', process.cwd())
  .option('-s, --server <url>', 'Server URL (if running as client)', process.env.FACTORY_SERVER_URL || 'http://localhost:3000');

// Strict server client helper — does NOT silently fall back to local mutation
async function runClientCommand(cmdType: string, payload: any, options: any): Promise<any> {
  const serverUrl = options.server || process.env.FACTORY_SERVER_URL || 'http://localhost:3000';

  let urlObj: URL;
  try {
    urlObj = new URL('/api/v1/command', serverUrl);
  } catch (err: any) {
    throw new Error(`Invalid server URL '${serverUrl}': ${err.message}`);
  }

  const body = JSON.stringify({ type: cmdType, payload });

  return new Promise<any>((resolve, reject) => {
    const req = http.request(
      urlObj,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(rawData);
            if (json && json.success === false) {
              reject(new Error(json.error || `Server command '${cmdType}' failed`));
            } else if (json && json.success === true) {
              resolve(json.data);
            } else {
              reject(new Error(`Unexpected server response structure: ${rawData}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response from server: ${rawData}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`Server connection error (${serverUrl}): ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout connecting to server at ${serverUrl}`));
    });

    req.write(body);
    req.end();
  });
}

// Administrative Subcommand: init workspace
program
  .command('init [dir]')
  .description('Initialize a new Kanban workspace')
  .action((dir) => {
    const targetDir = dir || program.opts().workspace || process.cwd();
    WorkspaceStorage.initWorkspace(targetDir);
    console.log(chalk.green(`✓ Workspace successfully initialized at ${path.resolve(targetDir)}`));
  });

// Administrative Subcommand: server start
const serverCmd = program.command('server').description('Manage deterministic server');

serverCmd
  .command('start')
  .description('Start deterministic Kanban server')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const workspaceDir = path.resolve(program.opts().workspace || process.cwd());
    const server = new BoardServer({ port, workspaceDir });
    await server.listen(port);
  });

// Subcommands for Task
const taskCmd = program.command('task').description('Manage board tasks');

taskCmd
  .command('create [name]')
  .description('Create a new task')
  .option('-n, --name <name>', 'Task name')
  .option('-s, --status <status>', 'Status column ID')
  .option('-d, --desc <description>', 'Task description')
  .option('-p, --project <project>', 'Project ID (required)')
  .option('-w, --workflow <workflow>', 'ADW / Workflow ID')
  .option('--adw <adw>', 'ADW / Workflow ID (alias for --workflow)')
  .action(async (nameArg, opts) => {
    try {
      const name = opts.name || nameArg;
      if (!name) {
        throw new Error('Task name is required (--name "Task name" or positional argument)');
      }
      const workflow = opts.workflow || opts.adw;
      let projectId = opts.project;
      
      if (!projectId) {
        const projects = await runClientCommand('list_projects', {}, program.opts());
        if (projects.length === 1) {
          projectId = projects[0].id;
        } else {
          const avail = projects.map((p: any) => p.id).join(', ');
          throw new Error(`Multiple projects exist; specify --project <id>. Available: ${avail}`);
        }
      }

      const result: Task = await runClientCommand(
        'create_task',
        {
          name,
          title: name,
          status: opts.status,
          description: opts.desc,
          project: projectId,
          adw: workflow
        },
        program.opts()
      );
      console.log(chalk.green(`✓ Created task ${chalk.bold(result.id)}: "${result.name || result.title}" [Project: ${result.project}, ADW: ${result.adw}, Status: ${result.status}]`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error creating task: ${err.message}`));
      process.exit(1);
    }
  });

taskCmd
  .command('list')
  .description('List workspace tasks')
  .option('-s, --status <status>', 'Filter by status')
  .option('-p, --project <project>', 'Filter by project')
  .action(async (opts) => {
    try {
      const tasks: Task[] = await runClientCommand(
        'list_tasks',
        { status: opts.status, project: opts.project },
        program.opts()
      );

      if (tasks.length === 0) {
        console.log(chalk.yellow('No tasks found.'));
        return;
      }

      const table = new Table({
        head: [chalk.cyan('ID'), chalk.cyan('Name'), chalk.cyan('Status'), chalk.cyan('Project'), chalk.cyan('ADW')],
        colWidths: [12, 35, 15, 15, 20]
      });

      tasks.forEach((t) => {
        const displayName = t.name || t.title || '';
        table.push([
          t.id,
          displayName.length > 32 ? displayName.substring(0, 29) + '...' : displayName,
          t.status,
          t.project || '-',
          t.adw || '-'
        ]);
      });

      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`✗ Error listing tasks: ${err.message}`));
      process.exit(1);
    }
  });

taskCmd
  .command('show <id>')
  .description('Show detailed task info')
  .action(async (id) => {
    try {
      const task: Task = await runClientCommand('get_task', { id }, program.opts());
      console.log(chalk.bold(`Task Details: ${task.id}`));
      console.log(`Name:        ${task.name || task.title}`);
      console.log(`Status:      ${task.status}`);
      console.log(`Project:     ${task.project || '(None)'}`);
      console.log(`ADW:         ${task.adw || '(None)'}`);
      console.log(`Created:     ${task.created_at || 'N/A'}`);
      console.log(`Updated:     ${task.updated_at || 'N/A'}`);
      console.log(`Description:`);
      console.log(task.description || '(No description provided)');
    } catch (err: any) {
      console.error(chalk.red(`✗ Error showing task: ${err.message}`));
      process.exit(1);
    }
  });

taskCmd
  .command('move <id> <status>')
  .description('Move task to another status column')
  .option('-i, --index <index>', 'Target position index')
  .action(async (id, status, opts) => {
    try {
      const index = opts.index ? parseInt(opts.index, 10) : undefined;
      const result: Task = await runClientCommand(
        'move_task',
        { id, target_status: status, target_index: index },
        program.opts()
      );
      console.log(chalk.green(`✓ Moved task ${chalk.bold(result.id)} to column "${result.status}"`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error moving task: ${err.message}`));
      process.exit(1);
    }
  });

taskCmd
  .command('update <id>')
  .description('Update task attributes')
  .option('-n, --name <name>', 'New name')
  .option('-t, --title <title>', 'New title (alias for name)')
  .option('-d, --desc <description>', 'New description')
  .option('-w, --workflow <workflow>', 'New ADW assignment')
  .option('--adw <adw>', 'New ADW assignment')
  .option('-p, --project <project>', 'New project assignment')
  .action(async (id, opts) => {
    try {
      const result: Task = await runClientCommand(
        'update_task',
        {
          id,
          name: opts.name || opts.title,
          description: opts.desc,
          adw: opts.workflow || opts.adw,
          project: opts.project
        },
        program.opts()
      );
      console.log(chalk.green(`✓ Updated task ${chalk.bold(result.id)}`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error updating task: ${err.message}`));
      process.exit(1);
    }
  });

taskCmd
  .command('delete <id>')
  .description('Delete a task')
  .action(async (id) => {
    try {
      await runClientCommand('delete_task', { id }, program.opts());
      console.log(chalk.green(`✓ Deleted task ${chalk.bold(id)}`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error deleting task: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommands for Column
const colCmd = program.command('column').description('Manage board columns');

colCmd
  .command('add <id> <name>')
  .description('Add a new column')
  .option('-d, --desc <description>', 'Column description')
  .action(async (id, name, opts) => {
    try {
      await runClientCommand('create_column', { id, name, description: opts.desc }, program.opts());
      console.log(chalk.green(`✓ Created column ${chalk.bold(id)} ("${name}")`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error adding column: ${err.message}`));
      process.exit(1);
    }
  });

colCmd
  .command('rename <id> <newName>')
  .description('Rename column display name')
  .action(async (id, newName) => {
    try {
      await runClientCommand('rename_column', { id, new_name: newName }, program.opts());
      console.log(chalk.green(`✓ Renamed column ${chalk.bold(id)} to "${newName}"`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error renaming column: ${err.message}`));
      process.exit(1);
    }
  });

colCmd
  .command('delete <id>')
  .description('Delete a column')
  .action(async (id) => {
    try {
      await runClientCommand('delete_column', { id }, program.opts());
      console.log(chalk.green(`✓ Deleted column ${chalk.bold(id)}`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error deleting column: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommands for Project
const projCmd = program.command('project').description('Manage workspace projects');

projCmd
  .command('create <name> <path>')
  .description('Register a new project')
  .option('-i, --id <id>', 'Project ID / prefix for task IDs (defaults to project name)')
  .action(async (name, projPath, opts) => {
    try {
      const projId = opts.id || name;
      const result: Project = await runClientCommand('create_project', { id: projId, name, path: projPath }, program.opts());
      console.log(chalk.green(`✓ Registered project ${chalk.bold(result.name || result.id)} [ID: ${result.id}] at path "${result.path}"`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error creating project: ${err.message}`));
      process.exit(1);
    }
  });

projCmd
  .command('list')
  .description('List registered projects')
  .action(async () => {
    try {
      const projects: Project[] = await runClientCommand('list_projects', {}, program.opts());
      if (projects.length === 0) {
        console.log(chalk.yellow('No projects registered.'));
        return;
      }
      const table = new Table({ head: [chalk.cyan('Project ID'), chalk.cyan('Name'), chalk.cyan('Path'), chalk.cyan('ADWs')] });
      projects.forEach((p) => {
        const adwSummary = (p.adws || []).map((a) => a.id).join(', ');
        table.push([p.id, p.name || p.id, p.path, adwSummary || '-']);
      });
      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`✗ Error listing projects: ${err.message}`));
      process.exit(1);
    }
  });

projCmd
  .command('adws <projectId>')
  .description('List ADWs configured for a project')
  .action(async (projectId) => {
    try {
      const adws: ADW[] = await runClientCommand('list_project_adws', { id: projectId }, program.opts());
      if (!adws || adws.length === 0) {
        console.log(chalk.yellow(`No ADWs found for project '${projectId}'.`));
        return;
      }
      const table = new Table({ head: [chalk.cyan('ADW ID'), chalk.cyan('Path')] });
      adws.forEach((a) => table.push([a.id, a.path]));
      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`✗ Error listing project ADWs: ${err.message}`));
      process.exit(1);
    }
  });

// Subcommands for Extension
const extCmd = program.command('extension').description('Manage external extensions');

extCmd
  .command('register <id> <type> <url>')
  .description('Register external extension')
  .action(async (id, type, url) => {
    try {
      const result: Extension = await runClientCommand('register_extension', { id, type, url }, program.opts());
      console.log(chalk.green(`✓ Registered extension ${chalk.bold(result.id)} [${result.type}] -> ${result.url}`));
    } catch (err: any) {
      console.error(chalk.red(`✗ Error registering extension: ${err.message}`));
      process.exit(1);
    }
  });

extCmd
  .command('list')
  .description('List registered extensions')
  .action(async () => {
    try {
      const extensions: Extension[] = await runClientCommand('list_extensions', {}, program.opts());
      if (extensions.length === 0) {
        console.log(chalk.yellow('No extensions registered.'));
        return;
      }
      const table = new Table({ head: [chalk.cyan('ID'), chalk.cyan('Type'), chalk.cyan('URL')] });
      extensions.forEach((e) => table.push([e.id, e.type, e.url]));
      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`✗ Error listing extensions: ${err.message}`));
      process.exit(1);
    }
  });

// Board Overview Command
program
  .command('board')
  .description('Display board structure and cards')
  .action(async () => {
    try {
      const data: { board: Board; tasks: Task[] } = await runClientCommand('get_board', {}, program.opts());
      const { board, tasks } = data;

      console.log(chalk.bold.magenta(`=== ${board.title} ===\n`));

      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      board.columns.forEach((col) => {
        console.log(chalk.bold.cyan(`[ ${col.name} ] (${col.id})`));
        const ids = board.task_order[col.id] || [];
        if (ids.length === 0) {
          console.log(chalk.dim('  (empty)\n'));
        } else {
          ids.forEach((id) => {
            const task = taskMap.get(id);
            if (task) {
              const proj = task.project ? chalk.yellow(` [${task.project}]`) : '';
              const adw = task.adw ? chalk.blue(` (workflow: ${task.adw})`) : '';
              const displayName = task.name || task.title;
              console.log(`  • ${chalk.bold(task.id)}: ${displayName}${proj}${adw}`);
            }
          });
          console.log('');
        }
      });
    } catch (err: any) {
      console.error(chalk.red(`✗ Error showing board: ${err.message}`));
      process.exit(1);
    }
  });

// TUI Command Launcher
program
  .command('tui')
  .description('Launch Interactive Terminal UI')
  .action(async () => {
    const { spawnSync } = await import('child_process');
    const serverUrl = program.opts().server || process.env.FACTORY_SERVER_URL || 'http://localhost:3000';
    const workspaceDir = path.resolve(program.opts().workspace || process.cwd());
    const tuiDir = path.join(__dirname, '../../tui');
    const tsxBin = path.join(tuiDir, 'node_modules/.bin/tsx');
    const tuiEntry = path.join(tuiDir, 'index.ts');
    const distEntry = path.join(tuiDir, 'dist/index.js');
    const fs = await import('fs');

    if (fs.existsSync(distEntry)) {
      const result = spawnSync('node', ['-e', `require('${distEntry.replace(/\\/g, '\\\\')}').startTUI('${workspaceDir.replace(/\\/g, '\\\\')}', '${serverUrl.replace(/\\/g, '\\\\')}')`], {
        stdio: 'inherit'
      });
      process.exit(result.status || 0);
    } else if (fs.existsSync(tsxBin)) {
      const result = spawnSync(tsxBin, ['-e', `require('${tuiEntry.replace(/\\/g, '\\\\')}').startTUI('${workspaceDir.replace(/\\/g, '\\\\')}', '${serverUrl.replace(/\\/g, '\\\\')}')`], {
        stdio: 'inherit'
      });
      process.exit(result.status || 0);
    } else {
      console.error('TUI project not found. Please install the @agentic-board/tui package in ../tui/');
      process.exit(1);
    }
  });

program.parse(process.argv);

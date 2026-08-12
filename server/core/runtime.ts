import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Task, Project, ADW, RunHandle, RunStatus } from './types';
import { openTraceDb } from './trace';

interface ActiveRun {
  proc: ChildProcess;
  adwId: string;
  projectId: string;
  startedAt: string;
  logPath: string;
  stoppedByUser: boolean;
}

export type RunOutcome = 'success' | 'fail' | 'stopped';

/**
 * Spawns and tracks SSSF ADW processes (uv run adws/adw_*.py) for tasks.
 *
 * Uses the task id as the ADW's --adw-id, so a task's trace session is always
 * `adw_id = task.id` — resuming the same task's ADW joins its prior session
 * (SSSF treats --adw-id as create-or-continue) instead of minting a new one.
 *
 * Process tracking is in-memory only: it does not survive a server restart.
 * `stop()` falls back to SSSF's own `processes` table (tracked by its tracer,
 * independent of this process) for the cross-restart case.
 */
export class AdwRuntime {
  private active = new Map<string, ActiveRun>();
  private runsDir: string;

  constructor(workspaceDir: string) {
    this.runsDir = path.join(workspaceDir, '.runs');
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  activeRuns(): RunHandle[] {
    return Array.from(this.active.entries()).map(([taskId, run]) => ({
      task_id: taskId,
      adw_id: run.adwId,
      project_id: run.projectId,
      pid: run.proc.pid ?? -1,
      status: 'running' as RunStatus,
      started_at: run.startedAt,
      log_path: run.logPath
    }));
  }

  private resolveScript(project: Project, adw: ADW): string {
    return path.resolve(project.path, adw.path);
  }

  start(task: Task, project: Project, adw: ADW, onExit?: (outcome: RunOutcome) => void): RunHandle {
    const existing = this.active.get(task.id);
    if (existing) {
      throw new Error(`Task '${task.id}' already has a running ADW (pid ${existing.proc.pid})`);
    }

    const scriptPath = this.resolveScript(project, adw);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(
        `ADW script not found at '${scriptPath}'. Has SSSF been stamped into project ` +
          `'${project.id}' (uv run .claude/skills/sssf/scripts/install.py from ${project.path})?`
      );
    }
    const configPath = path.join(project.path, 'adws', 'adw_sssf_config', 'sssf.config.yaml');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `SSSF roster config not found at '${configPath}'. Stamp SSSF into this project before starting tasks.`
      );
    }

    const prompt = (task.description && task.description.trim()) || task.name;

    if (!fs.existsSync(this.runsDir)) {
      fs.mkdirSync(this.runsDir, { recursive: true });
    }
    const logPath = path.join(this.runsDir, `${task.id}.log`);
    const logFd = fs.openSync(logPath, 'a');

    let proc: ChildProcess;
    try {
      proc = spawn('uv', ['run', scriptPath, prompt, '--adw-id', task.id], {
        cwd: project.path,
        env: process.env,
        stdio: ['ignore', logFd, logFd]
      });
    } finally {
      fs.closeSync(logFd);
    }

    const startedAt = new Date().toISOString();
    const run: ActiveRun = { proc, adwId: task.id, projectId: project.id, startedAt, logPath, stoppedByUser: false };
    this.active.set(task.id, run);

    const finish = (exitCode: number | null) => {
      this.active.delete(task.id);
      if (!onExit) return;
      if (run.stoppedByUser) {
        onExit('stopped');
        return;
      }
      // The trace db (written by SSSF's own tracer) is the authoritative source
      // for success/fail — it reflects run.finish(accepted=...), not just the
      // process exit code. Fall back to the exit code only if no session row
      // exists at all (e.g. the process died before ever reaching a phase).
      let outcome: RunOutcome = exitCode === 0 ? 'success' : 'fail';
      try {
        const db = openTraceDb(project.path);
        if (db) {
          try {
            const session = db.session(task.id);
            if (session?.status === 'success' || session?.status === 'fail') {
              outcome = session.status;
            }
          } finally {
            db.close();
          }
        }
      } catch {
        // keep the exit-code-derived outcome
      }
      onExit(outcome);
    };

    proc.on('exit', (code) => finish(code));
    proc.on('error', () => finish(1));

    return {
      task_id: task.id,
      adw_id: task.id,
      project_id: project.id,
      pid: proc.pid ?? -1,
      status: 'starting',
      started_at: startedAt,
      log_path: logPath
    };
  }

  stop(taskId: string, project?: Project): { stopped: boolean; pid?: number; message: string } {
    const run = this.active.get(taskId);
    if (run) {
      run.stoppedByUser = true;
      try {
        run.proc.kill('SIGTERM');
        return { stopped: true, pid: run.proc.pid, message: `Sent SIGTERM to pid ${run.proc.pid}` };
      } catch (err: any) {
        return { stopped: false, message: `Failed to signal pid ${run.proc.pid}: ${err.message}` };
      }
    }

    if (project) {
      const db = openTraceDb(project.path);
      if (db) {
        try {
          const pids = db.livePids(taskId);
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              // best effort — pid may already be gone
            }
          }
          if (pids.length > 0) {
            return {
              stopped: true,
              pid: pids[0],
              message: `Sent SIGTERM to ${pids.length} pid(s) tracked in the trace db`
            };
          }
        } finally {
          db.close();
        }
      }
    }

    return { stopped: false, message: `No running ADW tracked for task '${taskId}'` };
  }
}

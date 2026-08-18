import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import multer from 'multer';
import * as YAML from 'yaml';
import { DeterministicEngine } from './core/engine';
import { BoardEvent, Project, Task } from './core/types';
import { openTraceDb } from './core/trace';

export interface ModelEntry {
  provider: string;
  model: string;
  context: string;
  max_output: string;
  thinking: boolean;
  images: boolean;
  id: string;
}

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache: { data: ModelEntry[]; error?: string; timestamp: number } | null = null;

export function parseModelsTable(stdout: string): ModelEntry[] {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const rows: ModelEntry[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 6) continue;
    const [provider, model, context, max_output, thinking, images] = cols;
    rows.push({
      provider,
      model,
      context,
      max_output,
      thinking: thinking.toLowerCase() === 'yes',
      images: images.toLowerCase() === 'yes',
      id: `${provider}/${model}`
    });
  }
  return rows;
}

export interface ServerOptions {
  port?: number;
  workspaceDir?: string;
  /** Poll interval (ms) for reconciling SSSF trace dbs across all registered
   *  projects — surfaces directly-started SSSF runs as tasks and catches up
   *  runs whose completion this process missed (see engine.ts's handleSyncSssf).
   *  Default 0 = disabled: tests construct/listen() a BoardServer repeatedly
   *  and assert on exact revision numbers, so this must never start itself. */
  sssfSyncIntervalMs?: number;
}

export class BoardServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private engine: DeterministicEngine;
  private sseClients: Response[] = [];
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly sssfSyncIntervalMs: number;

  constructor(options: ServerOptions = {}) {
    const workspaceDir = options.workspaceDir || process.cwd();
    this.engine = new DeterministicEngine(workspaceDir);
    this.sssfSyncIntervalMs = options.sssfSyncIntervalMs ?? 0;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupEventStream();
  }

  public getEngine(): DeterministicEngine {
    return this.engine;
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // Static assets for Web UI
    const possiblePublicDirs = [
      path.join(__dirname, '../public'),
      path.join(process.cwd(), '../website/public'),
      path.join(process.cwd(), 'public'),
      path.join(__dirname, '../../website/public'),
      path.join(__dirname, '../../public')
    ];
    const publicDir = possiblePublicDirs.find((dir) => fs.existsSync(dir)) || possiblePublicDirs[0];
    this.app.use(express.static(publicDir));
  }

  private setupEventStream(): void {
    this.engine.on('event', (event: BoardEvent) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      this.sseClients.forEach((client) => client.write(data));
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', workspace: this.engine.getWorkspaceDir(), timestamp: new Date().toISOString() });
    });

    // SSE Event Stream
    this.app.get('/api/v1/events', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
      this.sseClients.push(res);

      req.on('close', () => {
        this.sseClients = this.sseClients.filter((c) => c !== res);
      });
    });

    const getExpectedRevision = (req: Request): number | undefined => {
      if (typeof req.body?.expected_revision === 'number') return req.body.expected_revision;
      if (req.headers['x-expected-revision']) {
        const rev = parseInt(req.headers['x-expected-revision'] as string, 10);
        if (!isNaN(rev)) return rev;
      }
      if (req.query?.expected_revision) {
        const rev = parseInt(req.query.expected_revision as string, 10);
        if (!isNaN(rev)) return rev;
      }
      return undefined;
    };

    // Unified Command Endpoint
    this.app.post('/api/v1/command', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { type, payload, expected_revision } = req.body;
        if (!type) {
          res.status(400).json({ success: false, error: 'Command type is required' });
          return;
        }
        const expRev = typeof expected_revision === 'number' ? expected_revision : getExpectedRevision(req);
        const result = await this.engine.executeCommand({
          type,
          payload: payload || {},
          expected_revision: expRev
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    // Get Full Board State
    this.app.get('/api/v1/board', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'get_board', payload: {} });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    // Tasks API Shortcuts
    this.app.get('/api/v1/tasks', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { status, project } = req.query;
        const result = await this.engine.executeCommand({
          type: 'list_tasks',
          payload: { status: status as string, project: project as string }
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/tasks', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'create_task',
          payload: req.body,
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 201 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'get_task',
          payload: { id: req.params.id }
        });
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.put('/api/v1/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'update_task',
          payload: { id: req.params.id, ...req.body },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/tasks/:id/move', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { target_status, target_index } = req.body;
        const result = await this.engine.executeCommand({
          type: 'move_task',
          payload: { id: req.params.id, target_status, target_index },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.delete('/api/v1/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'delete_task',
          payload: { id: req.params.id },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // Columns Shortcuts
    this.app.post('/api/v1/columns', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'create_column',
          payload: req.body,
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 201 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.put('/api/v1/columns/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'rename_column',
          payload: { id: req.params.id, new_name: req.body.new_name },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.delete('/api/v1/columns/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'delete_column',
          payload: { id: req.params.id },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // The column itself is never deleted by the board's own trash-can
    // button anymore — this moves every task currently in it to the
    // (hidden) Archived column instead. See handleArchiveColumnTasks.
    this.app.post('/api/v1/columns/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'archive_column_tasks',
          payload: { column_id: req.params.id },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // `pi` model catalog for the model picker — cached in memory since spawning
    // `pi --list-models` on every picker open is unnecessary.
    this.app.get('/api/v1/models', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const refresh = req.query.refresh === '1';
        if (!refresh && modelsCache && Date.now() - modelsCache.timestamp < MODELS_CACHE_TTL_MS) {
          res.json({ success: true, data: modelsCache.data, error: modelsCache.error });
          return;
        }
        execFile('pi', ['--list-models'], { timeout: 15000 }, (err, stdout) => {
          if (err) {
            // A missing/broken `pi` shouldn't 500 the whole board — respond 200
            // with an empty list so the UI can show "model list unavailable".
            modelsCache = { data: [], error: err.message, timestamp: Date.now() };
            res.json({ success: true, data: [], error: err.message });
            return;
          }
          const data = parseModelsTable(stdout);
          modelsCache = { data, timestamp: Date.now() };
          res.json({ success: true, data });
        });
      } catch (err) {
        next(err);
      }
    });

    // Projects Shortcuts
    this.app.get('/api/v1/projects', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'list_projects', payload: {} });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/projects', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'create_project',
          payload: req.body,
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 201 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'get_project', payload: { id: req.params.id } });
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/projects/:id/adws', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'list_project_adws', payload: { id: req.params.id } });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    const resolveProjectPath = async (id: string): Promise<{ project: Project; projectPath: string } | { error: string }> => {
      const result = await this.engine.executeCommand<Project>({ type: 'get_project', payload: { id } });
      if (!result.success || !result.data) {
        return { error: result.error || `Project '${id}' not found` };
      }
      // Mirrors runtime.ts: project.path is used as-is / via path.resolve, never
      // rejoined onto WORKSPACE_DIR (a project is an unrelated external repo).
      return { project: result.data, projectPath: path.resolve(result.data.path) };
    };

    const sanitizeDocumentFilename = (original: string): string => {
      const stripped = original.replace(/\0/g, '');
      const base = path.basename(stripped).replace(/^\.+/, '');
      return base || 'file';
    };

    const uniqueDocumentPath = (dir: string, filename: string): string => {
      let candidate = path.join(dir, filename);
      if (!fs.existsSync(candidate)) return candidate;
      const ext = path.extname(filename);
      const stem = filename.slice(0, filename.length - ext.length);
      let n = 1;
      do {
        candidate = path.join(dir, `${stem}-${n}${ext}`);
        n++;
      } while (fs.existsSync(candidate));
      return candidate;
    };

    const documentsUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024, files: 20 }
    });

    this.app.get('/api/v1/projects/:id/documents', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const documentsDir = path.join(resolved.projectPath, 'documents');
        if (!fs.existsSync(documentsDir)) {
          res.json({ success: true, data: [] });
          return;
        }
        const entries = await fs.promises.readdir(documentsDir, { withFileTypes: true });
        const files = await Promise.all(
          entries
            .filter((e) => e.isFile())
            .map(async (e) => {
              const stat = await fs.promises.stat(path.join(documentsDir, e.name));
              return { filename: e.name, size: stat.size, modified: stat.mtime.toISOString() };
            })
        );
        res.json({ success: true, data: files });
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/projects/:id/documents', documentsUpload.array('files', 20), async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) {
          res.status(400).json({ success: false, error: 'No files uploaded (expected multipart field "files")' });
          return;
        }
        const documentsDir = path.join(resolved.projectPath, 'documents');
        await fs.promises.mkdir(documentsDir, { recursive: true });
        const resolvedDocumentsDir = path.resolve(documentsDir);

        const stored: Array<{ filename: string; size: number; path: string }> = [];
        for (const file of files) {
          const safeName = sanitizeDocumentFilename(file.originalname);
          const candidatePath = path.resolve(documentsDir, safeName);
          // Defense in depth beyond basename/leading-dot stripping above — refuse
          // to write anywhere the resolved path escapes documents/.
          if (candidatePath !== resolvedDocumentsDir && !candidatePath.startsWith(resolvedDocumentsDir + path.sep)) {
            res.status(400).json({ success: false, error: `Rejected unsafe filename '${file.originalname}'` });
            return;
          }
          const destPath = uniqueDocumentPath(documentsDir, safeName);
          await fs.promises.writeFile(destPath, file.buffer);
          stored.push({
            filename: path.basename(destPath),
            size: file.buffer.length,
            path: path.relative(resolved.projectPath, destPath)
          });
        }
        res.status(201).json({ success: true, data: stored });
      } catch (err) {
        next(err);
      }
    });

    // Generic project-file editor: reads/writes any text file within a
    // project's own directory (workflow scripts at adw.path, SSSF's
    // per-agent system.md/user.md prompt files, etc). Confined to the
    // project root the same way document uploads are, via path.resolve +
    // prefix-check rather than trusting the client-supplied relative path.
    const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

    const resolveConfinedFilePath = (projectPath: string, relPath: string): { filePath: string } | { error: string } => {
      if (!relPath || typeof relPath !== 'string') return { error: 'path is required' };
      const cleaned = relPath.replace(/\0/g, '');
      const resolvedRoot = path.resolve(projectPath);
      const candidate = path.resolve(resolvedRoot, cleaned);
      if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
        return { error: `path '${relPath}' escapes the project directory` };
      }
      return { filePath: candidate };
    };

    this.app.get('/api/v1/projects/:id/file', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const relPath = String(req.query.path || '');
        const pathResolved = resolveConfinedFilePath(resolved.projectPath, relPath);
        if ('error' in pathResolved) {
          res.status(400).json({ success: false, error: pathResolved.error });
          return;
        }
        if (!fs.existsSync(pathResolved.filePath)) {
          res.json({ success: true, data: { path: relPath, content: null, exists: false } });
          return;
        }
        const stat = await fs.promises.stat(pathResolved.filePath);
        if (!stat.isFile()) {
          res.status(400).json({ success: false, error: `'${relPath}' is not a file` });
          return;
        }
        if (stat.size > MAX_EDITABLE_FILE_BYTES) {
          res.status(400).json({ success: false, error: `file too large to edit (${stat.size} bytes, limit ${MAX_EDITABLE_FILE_BYTES})` });
          return;
        }
        const content = await fs.promises.readFile(pathResolved.filePath, 'utf-8');
        res.json({ success: true, data: { path: relPath, content, exists: true } });
      } catch (err) {
        next(err);
      }
    });

    this.app.put('/api/v1/projects/:id/file', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const relPath = String((req.body && req.body.path) || '');
        const content = req.body && typeof req.body.content === 'string' ? req.body.content : null;
        if (content === null) {
          res.status(400).json({ success: false, error: 'content (string) is required' });
          return;
        }
        if (Buffer.byteLength(content, 'utf-8') > MAX_EDITABLE_FILE_BYTES) {
          res.status(400).json({ success: false, error: `content too large to save (limit ${MAX_EDITABLE_FILE_BYTES} bytes)` });
          return;
        }
        const pathResolved = resolveConfinedFilePath(resolved.projectPath, relPath);
        if ('error' in pathResolved) {
          res.status(400).json({ success: false, error: pathResolved.error });
          return;
        }
        await fs.promises.mkdir(path.dirname(pathResolved.filePath), { recursive: true });
        await fs.promises.writeFile(pathResolved.filePath, content, 'utf-8');
        res.json({ success: true, data: { path: relPath, saved: true } });
      } catch (err) {
        next(err);
      }
    });

    // SSSF agent roster: adws/adw_sssf_config/sssf.config.yaml. This is the
    // REAL source of truth for a project's agent roles (name/model/thinking/
    // prompt files) — not a board-owned concept. Reads/writes go through the
    // `yaml` package's Document API (not a parse-then-restringify round trip)
    // specifically because this file is heavily hand-commented; a naive
    // parse/serialize cycle would silently discard every comment. Editing an
    // existing agent's scalar fields (model/thinking/color/purpose) mutates
    // that agent's own YAML node in place, so its comments and everything
    // else in the file survive untouched.
    const SSSF_CONFIG_REL_PATH = path.join('adws', 'adw_sssf_config', 'sssf.config.yaml');
    const SSSF_EDITABLE_AGENT_FIELDS = ['model', 'thinking', 'color', 'purpose'] as const;

    function promptPathsForAgent(dataDir: string, name: string): { system: string; user: string } {
      return {
        system: path.posix.join(dataDir, 'prompt_engineering', name, 'system.md'),
        user: path.posix.join(dataDir, 'prompt_engineering', name, 'user.md')
      };
    }

    this.app.get('/api/v1/projects/:id/sssf-config', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const configPath = path.join(resolved.projectPath, SSSF_CONFIG_REL_PATH);
        if (!fs.existsSync(configPath)) {
          res.json({ success: true, data: null, error: `no ${SSSF_CONFIG_REL_PATH.replace(/\\/g, '/')} found — has this project been stamped with SSSF?` });
          return;
        }
        let doc: YAML.Document;
        try {
          doc = YAML.parseDocument(await fs.promises.readFile(configPath, 'utf-8'));
        } catch (e: any) {
          res.json({ success: true, data: null, error: `failed to parse sssf.config.yaml: ${(e && e.message) || e}` });
          return;
        }
        const defaults = (doc.get('defaults') as any)?.toJSON?.() ?? doc.get('defaults') ?? {};
        const observability = (doc.get('observability') as any)?.toJSON?.() ?? doc.get('observability') ?? {};
        const agentsNode = doc.get('agents', true);
        const agents = YAML.isSeq(agentsNode) ? agentsNode.items.map((item) => (YAML.isMap(item) ? item.toJSON() : item)) : [];
        res.json({ success: true, data: { defaults, observability, agents } });
      } catch (err) {
        next(err);
      }
    });

    this.app.put('/api/v1/projects/:id/sssf-config', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const payloadAgents = Array.isArray(req.body && req.body.agents) ? req.body.agents : null;
        if (!payloadAgents) {
          res.status(400).json({ success: false, error: 'agents (array) is required' });
          return;
        }
        for (const a of payloadAgents) {
          if (!a || typeof a.name !== 'string' || !a.name.trim()) {
            res.status(400).json({ success: false, error: 'every agent needs a non-empty name' });
            return;
          }
        }

        const configPath = path.join(resolved.projectPath, SSSF_CONFIG_REL_PATH);
        if (!fs.existsSync(configPath)) {
          res.status(404).json({ success: false, error: `no ${SSSF_CONFIG_REL_PATH.replace(/\\/g, '/')} found — has this project been stamped with SSSF?` });
          return;
        }
        const raw = await fs.promises.readFile(configPath, 'utf-8');
        let doc: YAML.Document;
        try {
          doc = YAML.parseDocument(raw);
        } catch (e: any) {
          res.status(400).json({ success: false, error: `failed to parse sssf.config.yaml: ${(e && e.message) || e}` });
          return;
        }

        const dataDirNode = doc.getIn(['defaults', 'data_dir']);
        const dataDir = typeof dataDirNode === 'string' && dataDirNode ? dataDirNode : 'adws/adw_data';

        let agentsSeq = doc.get('agents', true) as YAML.YAMLSeq | undefined;
        if (!agentsSeq || !YAML.isSeq(agentsSeq)) {
          agentsSeq = doc.createNode([]) as YAML.YAMLSeq;
          doc.set('agents', agentsSeq);
        }

        const byName = new Map<string, YAML.YAMLMap>();
        for (const item of agentsSeq.items) {
          if (YAML.isMap(item)) {
            const name = item.get('name');
            if (typeof name === 'string') byName.set(name, item);
          }
        }

        const newlyCreated: Array<{ name: string; system: string; user: string }> = [];
        const resultItems: YAML.YAMLMap[] = [];
        const payloadByName = new Map<string, any>(payloadAgents.map((a: any) => [a.name, a]));

        // Preserve original file order for agents that survive; only their
        // own node is mutated in place, so untouched agents (and every
        // comment attached to them) are byte-identical.
        for (const item of agentsSeq.items) {
          if (!YAML.isMap(item)) continue;
          const name = item.get('name');
          if (typeof name !== 'string') continue;
          const payloadAgent = payloadByName.get(name);
          if (!payloadAgent) continue; // omitted from payload => deleted
          for (const field of SSSF_EDITABLE_AGENT_FIELDS) {
            const value = payloadAgent[field];
            if (value === undefined || value === null || value === '') {
              item.delete(field);
            } else {
              item.set(field, value);
            }
          }
          resultItems.push(item);
        }

        // Anything in the payload not matched above is a brand-new agent.
        for (const payloadAgent of payloadAgents) {
          if (byName.has(payloadAgent.name)) continue;
          const prompts = promptPathsForAgent(dataDir, payloadAgent.name);
          const fields: Record<string, any> = { name: payloadAgent.name };
          for (const field of SSSF_EDITABLE_AGENT_FIELDS) {
            if (payloadAgent[field]) fields[field] = payloadAgent[field];
          }
          fields.prompt_engineering = { system: prompts.system, user: prompts.user };
          const node = doc.createNode(fields) as YAML.YAMLMap;
          resultItems.push(node);
          newlyCreated.push({ name: payloadAgent.name, ...prompts });
        }

        agentsSeq.items = resultItems;
        await fs.promises.writeFile(configPath, doc.toString(), 'utf-8');

        // A new agent's prompt files must exist before the UI can edit them.
        for (const created of newlyCreated) {
          for (const relPath of [created.system, created.user]) {
            const filePath = path.resolve(resolved.projectPath, relPath);
            if (!filePath.startsWith(path.resolve(resolved.projectPath) + path.sep)) continue;
            if (fs.existsSync(filePath)) continue;
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const label = relPath.endsWith('system.md') ? 'System' : 'User';
            await fs.promises.writeFile(filePath, `# ${created.name} — ${label} Prompt\n\n`, 'utf-8');
          }
        }

        res.json({ success: true, data: { saved: true } });
      } catch (err) {
        next(err);
      }
    });

    // Which agents a workflow actually uses lives nowhere structured — it's
    // baked into the script's own Python. Every real multi-phase SSSF ADW
    // (anything beyond the single-agent adw_prompt.py) declares a top-level
    // `REQUIRED_AGENTS = ["planner", "builder"]` list right after its
    // imports (see adw_modules.agents.validate(cfg, REQUIRED_AGENTS)) — this
    // is a load-bearing, consistently-used convention across SSSF's own
    // generated workflows, not a guess. Best-effort regex extraction, read
    // via the same file-reading path as the generic file editor; a script
    // that doesn't follow the convention just yields an empty list rather
    // than an error.
    function extractRequiredAgents(scriptSource: string): string[] {
      const match = scriptSource.match(/^\s*REQUIRED_AGENTS\s*=\s*\[([^\]]*)\]/m);
      if (!match) return [];
      const names: string[] = [];
      const strRe = /['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = strRe.exec(match[1])) !== null) {
        names.push(m[1]);
      }
      return names;
    }

    this.app.get('/api/v1/projects/:id/adw-agents', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveProjectPath(req.params.id);
        if ('error' in resolved) {
          res.status(404).json({ success: false, error: resolved.error });
          return;
        }
        const adws = resolved.project.adws || [];
        const data: Record<string, string[]> = {};
        for (const adw of adws) {
          if (!adw.id || !adw.path) continue;
          const pathResolved = resolveConfinedFilePath(resolved.projectPath, adw.path);
          if ('error' in pathResolved) {
            data[adw.id] = [];
            continue;
          }
          try {
            if (!fs.existsSync(pathResolved.filePath)) {
              data[adw.id] = [];
              continue;
            }
            const stat = await fs.promises.stat(pathResolved.filePath);
            if (!stat.isFile() || stat.size > MAX_EDITABLE_FILE_BYTES) {
              data[adw.id] = [];
              continue;
            }
            const content = await fs.promises.readFile(pathResolved.filePath, 'utf-8');
            data[adw.id] = extractRequiredAgents(content);
          } catch {
            data[adw.id] = [];
          }
        }
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    });

    this.app.delete('/api/v1/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({
          type: 'delete_project',
          payload: { id: req.params.id },
          expected_revision: getExpectedRevision(req)
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // Task Execution Stubs (Phase 3 Extension Points)
    this.app.post('/api/v1/tasks/:id/start', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'start_task', payload: { id: req.params.id } });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/tasks/:id/stop', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'stop_task', payload: { id: req.params.id } });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    // Stops any active run and deletes this task's SSSF session (files +
    // best-effort trace-db rows), so the next "start" begins a genuinely
    // fresh pi session instead of resuming the old one.
    this.app.post('/api/v1/tasks/:id/clear-run', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'clear_task_run', payload: { id: req.params.id } });
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // ADW trace (SSSF observability) — a task's adw_id is its own id, so its
    // trace session lives at <project.path>/adws/adw_data/sssf.db.
    const resolveTaskProject = async (taskId: string): Promise<{ task: Task; project: Project } | { error: string; status: number }> => {
      const taskResult = await this.engine.executeCommand<Task>({ type: 'get_task', payload: { id: taskId } });
      if (!taskResult.success || !taskResult.data) {
        return { error: taskResult.error || `Task '${taskId}' not found`, status: 404 };
      }
      const task = taskResult.data;
      if (!task.project) {
        return { error: `Task '${taskId}' has no project assigned`, status: 404 };
      }
      const projectResult = await this.engine.executeCommand<Project>({ type: 'get_project', payload: { id: task.project } });
      if (!projectResult.success || !projectResult.data) {
        return { error: projectResult.error || `Project '${task.project}' not found`, status: 404 };
      }
      return { task, project: projectResult.data };
    };

    this.app.get('/api/v1/tasks/:id/trace', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveTaskProject(req.params.id);
        if ('error' in resolved) {
          res.status(resolved.status).json({ success: false, error: resolved.error });
          return;
        }
        const db = openTraceDb(resolved.project.path);
        if (!db) {
          res.status(404).json({ success: false, error: 'No SSSF trace db yet — has this task been started?' });
          return;
        }
        try {
          const detail = db.sessionDetail(resolved.task.id);
          if (!detail) {
            res.status(404).json({ success: false, error: `No trace session for task '${resolved.task.id}' yet` });
            return;
          }
          res.json({ success: true, data: detail });
        } finally {
          db.close();
        }
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/tasks/:id/trace/events', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveTaskProject(req.params.id);
        if ('error' in resolved) {
          res.status(resolved.status).json({ success: false, error: resolved.error });
          return;
        }
        const db = openTraceDb(resolved.project.path);
        if (!db) {
          res.status(404).json({ success: false, error: 'No SSSF trace db yet — has this task been started?' });
          return;
        }
        try {
          const after = parseInt((req.query.after as string) || '0', 10) || 0;
          const limit = parseInt((req.query.limit as string) || '500', 10) || 500;
          const page = db.events(resolved.task.id, after, limit);
          res.json({ success: true, data: page });
        } finally {
          db.close();
        }
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/tasks/:id/trace/envelopes', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveTaskProject(req.params.id);
        if ('error' in resolved) {
          res.status(resolved.status).json({ success: false, error: resolved.error });
          return;
        }
        const db = openTraceDb(resolved.project.path);
        if (!db) {
          res.status(404).json({ success: false, error: 'No SSSF trace db yet — has this task been started?' });
          return;
        }
        try {
          res.json({ success: true, data: db.envelopes(resolved.task.id) });
        } finally {
          db.close();
        }
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/tasks/:id/trace/gates', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resolved = await resolveTaskProject(req.params.id);
        if ('error' in resolved) {
          res.status(resolved.status).json({ success: false, error: resolved.error });
          return;
        }
        const db = openTraceDb(resolved.project.path);
        if (!db) {
          res.status(404).json({ success: false, error: 'No SSSF trace db yet — has this task been started?' });
          return;
        }
        try {
          res.json({ success: true, data: db.gates(resolved.task.id) });
        } finally {
          db.close();
        }
      } catch (err) {
        next(err);
      }
    });

    const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

    this.app.get('/api/v1/tasks/:id/trace/agents/:agent/prompts', async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!SAFE_SEGMENT.test(req.params.agent)) {
          res.status(400).json({ success: false, error: 'Invalid agent name' });
          return;
        }
        const resolved = await resolveTaskProject(req.params.id);
        if ('error' in resolved) {
          res.status(resolved.status).json({ success: false, error: resolved.error });
          return;
        }
        const db = openTraceDb(resolved.project.path);
        if (!db) {
          res.status(404).json({ success: false, error: 'No SSSF trace db yet — has this task been started?' });
          return;
        }
        try {
          res.json({ success: true, data: db.prompts(resolved.task.id, req.params.agent) });
        } finally {
          db.close();
        }
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/tasks/:id/run-log', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const logPath = path.join(this.engine.getWorkspaceDir(), '.runs', `${req.params.id}.log`);
        if (!fs.existsSync(logPath)) {
          res.status(404).json({ success: false, error: 'No run log for this task yet' });
          return;
        }
        const content = fs.readFileSync(logPath, 'utf8');
        const tail = content.split('\n').slice(-500).join('\n');
        res.json({ success: true, data: { log: tail } });
      } catch (err) {
        next(err);
      }
    });

    // Runs currently tracked by this server process (in-memory — see AdwRuntime).
    this.app.get('/api/v1/runs/active', async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json({ success: true, data: this.engine.getActiveRuns() });
      } catch (err) {
        next(err);
      }
    });

    // Live `pi` agents (SSSF observability) — every currently-running agent
    // invocation in a project's trace db, whether or not it's tied to a board
    // task (e.g. an ADW started directly via SSSF, bypassing the board). Not
    // scoped to this server process, unlike /api/v1/runs/active above.
    const liveAgentsForProject = async (project: Project): Promise<any[]> => {
      const db = openTraceDb(project.path);
      if (!db) return [];
      try {
        const tasksResult = await this.engine.executeCommand<Task[]>({
          type: 'list_tasks',
          payload: { project: project.id }
        });
        const taskIds = new Set((tasksResult.data || []).map((t) => t.id));
        return db.liveProcesses('agent').map((proc) => {
          const session = db.session(proc.adw_id);
          return {
            adw_id: proc.adw_id,
            agent_name: proc.name,
            pid: proc.pid,
            command: proc.command,
            started_at: proc.started_at,
            project_id: project.id,
            task_id: taskIds.has(proc.adw_id) ? proc.adw_id : null,
            session_request: session?.request ?? null,
            session_status: session?.status ?? null
          };
        });
      } finally {
        db.close();
      }
    };

    this.app.get('/api/v1/projects/:id/live-agents', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectResult = await this.engine.executeCommand<Project>({
          type: 'get_project',
          payload: { id: req.params.id }
        });
        if (!projectResult.success || !projectResult.data) {
          res.status(404).json({ success: false, error: projectResult.error || `Project '${req.params.id}' not found` });
          return;
        }
        res.json({ success: true, data: await liveAgentsForProject(projectResult.data) });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/v1/live-agents', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectsResult = await this.engine.executeCommand<Project[]>({ type: 'list_projects', payload: {} });
        const projects = projectsResult.data || [];
        const perProject = await Promise.all(projects.map((p) => liveAgentsForProject(p)));
        res.json({ success: true, data: perProject.flat() });
      } catch (err) {
        next(err);
      }
    });

    // Extensions Shortcuts
    this.app.get('/api/v1/extensions', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'list_extensions', payload: {} });
        res.json(result);
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/v1/extensions', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.engine.executeCommand({ type: 'register_extension', payload: req.body });
        res.status(result.success ? 201 : 400).json(result);
      } catch (err) {
        next(err);
      }
    });

    // Error handler middleware
    this.app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      console.error('Unhandled server error:', err);
      res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    });
  }

  public async listen(port: number, host: string = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, host, () => {
        const addr = this.server!.address();
        console.log(`[AgenticBoard Server] Deterministic server listening on http://${host}:${typeof addr === 'string' ? port : (addr as any)?.port}`);
        console.log(`[AgenticBoard Server] Workspace: ${this.engine.getWorkspaceDir()}`);
        if (this.sssfSyncIntervalMs > 0) this.startSssfSyncLoop(this.sssfSyncIntervalMs);
        resolve(typeof addr === 'string' ? port : (addr as any)?.port);
      });
    });
  }

  private startSssfSyncLoop(intervalMs: number): void {
    const tick = () => {
      this.engine
        .executeCommand({ type: 'sync_sssf', payload: {} })
        .catch((err) => console.error('[AgenticBoard Server] SSSF sync tick failed:', err));
    };
    this.syncTimer = setInterval(tick, intervalMs);
    // Never let this loop keep the process alive on its own (tests, CLI-embedded use, etc).
    this.syncTimer.unref?.();
    tick();
  }

  public async close(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    return new Promise((resolve, reject) => {
      if (this.server) {
        // Destroy active SSE responses / open sockets
        this.sseClients.forEach((client) => {
          try { client.end(); } catch {}
        });
        this.sseClients = [];
        this.server.closeAllConnections?.();
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// Standalone entrypoint execution if run directly
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const host = process.env.HOST || '0.0.0.0';
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  // Auto-init workspace on first boot (idempotent — safe to call on existing workspaces)
  const { WorkspaceStorage } = require('./core/storage');
  WorkspaceStorage.initWorkspace(workspaceDir);
  const sssfSyncIntervalMs = process.env.SSSF_SYNC_INTERVAL_MS
    ? parseInt(process.env.SSSF_SYNC_INTERVAL_MS, 10)
    : 5000;
  const server = new BoardServer({ port, workspaceDir, sssfSyncIntervalMs });
  server.listen(port, host);
}

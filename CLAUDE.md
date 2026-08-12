# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgenticBoard is a deterministic Kanban board that runs [Super Simple Software
Factory](./super-simple-software-factory) (SSSF) "ADWs" (AI Developer
Workflows) against real, arbitrary git repos ("projects") registered with the
board. Three independent Node.js projects, each with its own
`package.json`/`node_modules`/`tsconfig.json`/`Dockerfile`:

- **`server/`** — Express API + DeterministicEngine (the source of truth) + CLI. Runs on the **host**, not in a container — it shells out to `uv`/`pi`/`git` and needs host filesystem access to whatever project directories it's running ADWs against.
- **`website/`** — static HTML/CSS/JS UI (no build step, no framework). Talks to the server's REST + SSE API. Can run directly off the server's own static hosting (`:3000`) or as a separate dockerized nginx reverse proxy (`:8080` → `host.docker.internal:3000`).
- **`tui/`** — a `blessed` terminal UI. Also a pure HTTP client of the server's API (talks over `FACTORY_SERVER_URL`), not a local engine.
- **`super-simple-software-factory/`** — vendored copy of the SSSF skill/framework this board stamps into projects and shells out to. See its own README for what SSSF is; AgenticBoard's `server/core/runtime.ts` and `server/core/trace.ts` are the integration points.

See `TUTORIAL.md` for the full end-to-end walkthrough (register a project, stamp SSSF into it, create a task, run an ADW, watch the trace) and `plan.md` for the original component breakdown.

## Commands

### Server (`server/`)
```bash
npm install
npm run build       # tsc -> dist/
npm run dev          # tsx cli/index.ts (CLI, hot, no build step)
npm start            # node dist/index.js (production server; requires build first)
npm test             # npm run build && vitest run
npm run test:watch   # vitest --watch
npx vitest run tests/engine.test.ts       # single test file
npx vitest run -t "some test name"        # single test by name
```
Run the server itself with `WORKSPACE_DIR=<dir> npm start` (or `PORT`, `HOST` env vars) — see "Workspace vs. Project" below.

### Website (`website/`)
```bash
npm install
npm run dev    # http-server public -p 8080 -c-1 (no build step; static files served as-is)
```

### TUI (`tui/`)
```bash
npm install
npm run dev     # tsx index.ts
npm start        # node dist/index.js (requires build first)
```

### Docker
```bash
docker compose up -d website        # dockerized UI only, proxies to host server on :3000
docker compose --profile tui up tui # dockerized TUI, also proxies to host server
```
The server is intentionally **not** in `docker-compose.yml` — see the comment at the top of that file.

## Architecture

### Command/event core (`server/core/engine.ts`)
`DeterministicEngine` is the single source of truth. Every read/write goes
through `executeCommand({ type, payload, expected_revision? })`, dispatched
by `CommandType` to a handler. For commands in `MUTATION_COMMANDS`:
1. Acquire the workspace file lock (`WorkspaceStorage.withWorkspaceLock`).
2. Optionally check `expected_revision` against the board's current `revision` for optimistic-concurrency conflict detection.
3. Snapshot every workspace file (`snapshotWorkspace`), run the handler, bump `board.revision`, then `validateStateInvariants()` (referential integrity between board/projects/tasks).
4. On any error, roll back the snapshot (`rollbackWorkspace`) so a failed mutation never leaves partial state.
5. Emit a `BoardEvent` (via `EventEmitter`) that `index.ts` forwards to all connected SSE clients at `/api/v1/events`.

Non-mutation commands (`get_task`, `list_projects`, etc.) skip the lock/snapshot/event machinery entirely.

The REST API (`server/index.ts`) is a thin HTTP layer over this: `POST /api/v1/command` is the fully general endpoint, and most other routes (`/api/v1/tasks`, `/api/v1/projects`, ...) are convenience shortcuts that build a `Command` and call `engine.executeCommand`. The CLI (`server/cli/index.ts`) does the same thing but as an HTTP client against a running server (`runClientCommand`) — it does not touch `DeterministicEngine` directly, so CLI and website/TUI are peers, not privileged.

### Storage (`server/core/storage.ts`)
File-based persistence: `board.json`, `projects.json`, `tasks/<id>.json`,
`extensions.json`, `agents.json`, all under a workspace directory. Every
read/write validates against JSON Schema (`server/core/schemas/*.json`, via
`SchemaValidator` in `validator.ts`). Writes are atomic (write to a temp file
then `rename`) and per-file-locked with `proper-lockfile`; mutating commands
additionally take a whole-workspace lock. `WorkspaceStorage` also
auto-migrates older workspace layouts on construction (`needsMigration` /
`migrateWorkspaceData`) — be careful not to treat a legitimately empty/absent
field (e.g. a project with no `adws`, a task with no `adw`) as something that
needs migrating; those are valid permanent states, not legacy data.

### Workspace vs. Project — two different directories
- **Workspace** (`WORKSPACE_DIR`): where the *board's own* state lives — `board.json`, `tasks/`, `projects.json`, `.runs/` (ADW stdout/stderr logs). Owned entirely by AgenticBoard.
- **Project** (`Project.path`): an arbitrary external git repo registered with the board, which is what an ADW actually runs against and commits to. Unrelated to `WORKSPACE_DIR` — it can be anywhere, including nested inside the workspace dir if you want.
Don't conflate the two: a task's `id`/`status`/`description` lives in the workspace; the actual code changes and commits happen inside the project's own repo.

### SSSF integration (`server/core/runtime.ts`, `server/core/trace.ts`)
- `AdwRuntime.start()` spawns `uv run <project.path>/<adw.path> <prompt> --adw-id <task.id>` as a detached child process, logging stdout/stderr to `<workspace>/.runs/<task.id>.log`. Using the **task id as the ADW's `--adw-id`** means a task's SSSF trace session is always keyed by its own id — re-running/resuming a task continues the same SSSF session rather than starting cold (SSSF treats `--adw-id` as create-or-continue).
- Process tracking is in-memory only (`AdwRuntime.active`), so it does not survive a server restart; `stop()` falls back to SSSF's own `processes` table in the trace db for the cross-restart case.
- Run outcome (success/fail/stopped) is determined primarily from SSSF's own trace db (`session.status`), falling back to the process exit code only if no session row exists yet.
- `trace.ts`'s `TraceDb` is a **read-only** view over a project's `adws/adw_data/sssf.db` (ported from SSSF's own visualizer, `apps/visualizer/server/db.ts`, trimmed to the single-session case since a task's `adw_id` already scopes everything). It uses `node:sqlite` loaded via `process.getBuiltinModule` rather than a static import, specifically to dodge the test runner's esbuild transform not recognizing `node:sqlite` as a built-in.
- On a genuine ADW failure (not a user-initiated stop), the engine best-effort moves the task's card to a `failed` column if the board has one (`handleStartTask`'s `onExit` callback) — success never auto-moves a card, only failure does, since that's the state a user would otherwise miss.

### Frontend (`website/public/`)
Plain JS, no bundler/framework/build step. `app.js` is the main Kanban board
(SSE-driven live updates, task/project CRUD, drag-and-drop). `trace.js` is
the gantt-style ADW trace viewer (waterfall of phases/tool calls, ported from
SSSF's own visualizer UI, re-themed) — opened from a task's mini trace
preview or the "Workflow Preview" drawer. Both talk to the same REST/SSE API
the CLI and TUI use.

### Testing
`server/tests/*.test.ts` (vitest): `engine.test.ts` (core command handlers),
`validator.test.ts` (schema validation), `server.test.ts`/`web.test.ts` (HTTP
routes), `sse.test.ts` (event stream), `cli.test.ts` (CLI-as-HTTP-client
behavior). `npm test` builds first (`tsc`) because some tests may exercise
the compiled output; use `npx vitest run <file>` directly during iteration
to skip the rebuild.

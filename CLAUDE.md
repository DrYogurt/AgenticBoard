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

Two further self-contained modules attach themselves to `window` and are
wired in from `app.js`, so each stays out of the main board file:
- `project-view.js` (`window.ProjectView`) — the project view opened by
  clicking a row in the projects modal. Edits each ADW's `id`, `name`,
  `path`, `model` and `parameters[]`, then saves the **whole** `adws` array
  through the `update_project` command (there is no REST shortcut for it).
  Its model picker is fed by `GET /api/v1/models`, which shells out to
  `pi --list-models`; that endpoint answers 200 with an empty list plus an
  `error` when `pi` is unavailable, so the picker degrades to manual entry
  instead of breaking the board.
  Agent selection is **just another parameter** — there is deliberately no
  board-owned "Agent" entity (an earlier version of this feature invented
  one in the board's own `agents.json`; it was removed because it was a
  layer of indirection over data that already exists as real files). A
  parameter with `type: 'agent'` means its `default` is an agent *name* from
  the project's own `adws/adw_sssf_config/sssf.config.yaml` roster — this is
  exactly SSSF's own `--agent` CLI-flag convention (see e.g. a real
  `adw_prompt.py`'s `agent` parameter, `default: 'builder'`), not a
  board-only concept. Picking `type: 'agent'` in a parameter row swaps its
  plain-text "default" input for a name-and-purpose picker sourced from that
  project's roster (`createAgentDefaultPicker`, mirroring the model picker's
  UX, backed by `agentsDraft` — loaded eagerly on `open()`, not lazily like
  the workspace-wide model list, since it's one small file scoped to the
  project already being opened).
  The "agent roles" section at the top of the project view reads and writes
  `sssf.config.yaml` directly via `GET`/`PUT /api/v1/projects/:id/sssf-config`
  (`server/index.ts`). Because that file is heavily hand-commented, the PUT
  handler edits it through the `yaml` npm package's `Document` API — mutating
  only the specific agent nodes/fields that changed — rather than a naive
  parse-then-restringify round trip, which would silently discard every
  comment. Editable fields are `model`/`thinking`/`color`/`purpose`;
  `tools`/`writes`/`harness_engineering` render read-only. Every id an
  agent-typed parameter references gets cross-checked against the roster:
  present → a full editable card; absent → a "referenced, not in roster" row
  with a one-click "+ add to roster" that stages (not yet saves) a new entry.
  All roster edits — including add/remove — are staged in a local
  `agentsDraft` array and only reach disk via an explicit **save agent
  roster** button (its own save banner, independent of `#pv-save-banner`/
  `#pv-save-btn` — the roster is a different backend resource than the
  project, and `update_project` has no field for it), mirroring how the ADW
  list itself stages edits before its own "save changes". Adding a new agent
  server-side also scaffolds its `prompt_engineering.system`/`.user` files
  (under `{defaults.data_dir}/prompt_engineering/{name}/`) if they don't
  exist yet, so the prompt editors below never 404 on a brand-new agent.
  Each agent's `system.md`/`user.md`, and each ADW's own script file (at
  `adw.path`), are edited by the same reusable `createFileEditor(getPath,
  label)` component: a collapsible toggle that lazily fetches content via
  `GET /api/v1/projects/:id/file?path=...` on first expand and saves it back
  via `PUT` on the same endpoint — a generic, project-root-confined text-file
  read/write, independent of both the roster PUT and `update_project`.
  `getPath` is a function, not a captured string, so an ADW's script editor
  always follows the *current* value of `adw.path` even if the user edits
  that field after the editor is already open.
- `workflow-diagram.js` (`window.WorkflowDiagram`) — a standalone, stateless
  renderer for a clickable UML-style box-and-line view of a project's `adws[]`
  (one box per workflow) and the agent ids their `type: 'agent'` parameters
  reference (one deduplicated box per unique id, since the same role can be
  shared across workflows). It never mutates data or opens anything itself —
  `render(el, project, opts)` takes `onSelectAdw`/`onSelectAgent`/
  `onAddWorkflow`/`onAddAgent` callbacks, and `project-view.js` owns what
  those do (switch to the list view and expand/flash the matching card, or
  add a new workflow/agent draft exactly like the equivalent "+" button).
  Positions are computed arithmetically from fixed constants rather than
  measured via `getBoundingClientRect`, so the layout is identical in a real
  browser and in jsdom tests. `project-view.js`'s list/diagram toggle always
  resets to "list" on open.
- `markdown-editor.js` (`window.MarkdownEditor`) — markdown syntax
  highlighting for the task description. A `<pre>` highlight layer sits
  behind a transparent-text `<textarea>`, so the field stays a real
  textarea whose `.value` is raw markdown. Two non-obvious constraints:
  headers are enlarged with `transform: scale()` rather than `font-size`
  (a font-size bump grows the line box and drifts the overlay out of
  alignment), and both layers use `white-space: pre` with soft wrap off,
  because a scaled header is an unbreakable `inline-block` and would
  otherwise wrap differently from the textarea. `app.js` assigns
  `.value` directly when opening the modal, which fires no `input` event —
  hence the explicit `MarkdownEditor.refresh()` call there. `.mde-wrap` uses
  `resize: both` (not just `vertical`): both the highlight `<pre>` and the
  real `<textarea>` are `position: absolute; inset: 0` children sized off the
  wrapper's own box, so a wider wrapper propagates to both layers with no
  extra JS. `.modal-body` carries `overflow-x: auto` so a widened box scrolls
  within the modal instead of being clipped by `.modal-card`'s
  `overflow: hidden` (which stays in place for its rounded-corner clipping).

Document upload lives in the task modal and posts `multipart/form-data` to
`POST /api/v1/projects/:id/documents`, which stores files under the
**project's** `documents/` directory — not the workspace. It must bypass
`apiCall()`, which would JSON-encode the body and destroy the multipart
boundary.

`server/index.ts` also exposes a generic `GET`/`PUT /api/v1/projects/:id/file?path=...`
(project-root-confined text file read/write — workflow scripts, SSSF prompt
files) and a structured `GET`/`PUT /api/v1/projects/:id/sssf-config`
(comment-preserving edits to `adws/adw_sssf_config/sssf.config.yaml` via the
`yaml` package's `Document` API). Both share `resolveProjectPath`/a
`resolveConfinedFilePath` prefix-check with the document-upload route — never
trust a client-supplied relative path without resolving + prefix-checking it
against the project root first.

### Testing
`server/tests/*.test.ts` (vitest): `engine.test.ts` (core command handlers),
`validator.test.ts` (schema validation), `server.test.ts`/`web.test.ts` (HTTP
routes), `sse.test.ts` (event stream), `cli.test.ts` (CLI-as-HTTP-client
behavior), `project-files.test.ts` (generic file editor + sssf-config
comment-preservation). `npm test` builds first (`tsc`) because some tests may
exercise the compiled output; use `npx vitest run <file>` directly during
iteration to skip the rebuild.

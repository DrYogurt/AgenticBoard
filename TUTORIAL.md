# AgenticBoard Tutorial: Project → Tasks → ADWs

This walks through the full loop: register a project, stamp IndyDevDan's
[Super Simple Software Factory](./super-simple-software-factory) (SSSF) into
it, add a task, and kick off a real AI Developer Workflow (ADW) against it —
watching it plan, build, and commit live from the board.

We'll build one running example throughout: a project called `hello-adw`.

---

## 0. Before you start

**The server runs on your host, not in a container.** It shells out to `uv`,
`pi`, and `git`, and needs to see your project directories on disk to run
ADWs — none of which a container has access to. `docker-compose.yml` only
dockerizes the **website** (a static UI + nginx reverse proxy); it reaches the
host's server through `host.docker.internal`. So this tutorial runs the server
as a plain host process and treats the dockerized website as one of two
equally valid ways to open the UI — see step 1.

You need on your host:
- [`uv`](https://docs.astral.sh/uv/) and [`pi`](https://github.com/mariozechner/pi-coding-agent) on `PATH`
- `git`
- At least one model provider `pi` is authenticated for. Check with:
  ```bash
  pi --list-models          # shows every provider pi knows about
  pi auth check --provider anthropic
  pi auth check --provider openai-codex
  ```
  On this machine, `anthropic` and `openai-codex` are ready; `google-gemini-cli`
  needs its OAuth flow completed inside interactive `pi` first. Use whichever
  providers show `ready`.

---

## 1. Start the board server, and (optionally) the dockerized website

```bash
cd server
npm install
npm run build

mkdir -p ~/agenticboard-workspace
WORKSPACE_DIR=~/agenticboard-workspace npm start
```

Leave this running in its own terminal (or a tmux window) — it binds port
`3000` and serves both the API **and** its own copy of the website UI, so
`http://localhost:3000` alone is a complete board.

`WORKSPACE_DIR` is where the board's own `board.json` / `tasks/` / `projects.json`
live — separate from any project you manage on the board. Pick any empty
directory you like; `~/agenticboard-workspace` is just this tutorial's choice.

If you'd rather use the dockerized website (nginx serving the static UI,
proxying every `/api/...` call back to the host server above), bring it up
too — it's independent of, and talks to, the server you just started:

```bash
docker compose up -d website
```

`website/nginx.conf` proxies to `http://host.docker.internal:3000`, so as long
as the server above is running on its default port, both UIs work identically:

```
http://localhost:3000     # server's own built-in UI
http://localhost:8080     # dockerized UI, proxied to the same server
```

Everywhere below uses `:3000` directly; swap in `:8080` if you're using the
dockerized website instead — the API is the same either way.

---

## 2. Stamp SSSF into a project

Pick (or create) the repo you want the board to run ADWs against. This is a
real git repo on disk — SSSF plans/builds/commits inside it.

```bash
mkdir -p ~/projects/hello-adw
cd ~/projects/hello-adw
git init
git commit --allow-empty -m init      # SSSF's commit phase needs a repo with a commit

mkdir -p .claude/skills
cp -r ~/Documents/Habitats/AgenticBoard/super-simple-software-factory/.claude/skills/sssf .claude/skills/
uv run .claude/skills/sssf/scripts/install.py
```

This stamps `adws/` into `hello-adw/` — the ADW scripts, the agent roster
config, and a `.env.sample`.

### Point the roster at models you actually have

The stamped roster (`adws/adw_sssf_config/sssf.config.yaml`) defaults to
OpenRouter/Fireworks-style model names. Point it at whatever `pi --list-models`
showed as `ready` instead. On this machine that's `anthropic` and
`openai-codex`:

```bash
cd ~/projects/hello-adw
sed -i 's|model: fireworks/accounts/fireworks/models/kimi-k3|model: anthropic/claude-opus-4-5|' adws/adw_sssf_config/sssf.config.yaml
sed -i 's|model: google/gemini-3.6-flash|model: anthropic/claude-haiku-4-5|' adws/adw_sssf_config/sssf.config.yaml
sed -i 's|model: openai/gpt-5.6-terra|model: openai-codex/gpt-5.6-terra|' adws/adw_sssf_config/sssf.config.yaml
sed -i 's|model: openai/gpt-5.6-luna|model: openai-codex/gpt-5.6-luna|' adws/adw_sssf_config/sssf.config.yaml
```

### Set up `.env`

```bash
cp .env.sample .env
```

If your `pi` install's models file is named `models-store.json` rather than
`models.json` (check with `ls ~/.pi/agent/`), also add this line to `.env` —
otherwise the ADW crashes on startup with a `FileNotFoundError`:

```bash
echo 'PI_MODELS_PATH=/home/YOU/.pi/agent/models-store.json' >> .env
```

### Sanity check (optional but recommended)

```bash
uv run adws/adw_prompt.py "reply with a one-line summary of this repo" --agent scout
```

If this prints a green `✓ success` summary, SSSF is wired up correctly and
you're ready to register the project with the board.

---

## 3. Register the project with the board

The website's "register project" form (hamburger → **Projects**) only takes a
name/id/path — it doesn't yet have a field for the ADW list. So we register
the project with its real ADWs in one `curl` call instead:

```bash
curl -s -X POST http://localhost:3000/api/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "hello-adw",
    "name": "hello-adw",
    "path": "'"$HOME"'/projects/hello-adw",
    "adws": [
      { "id": "plan-build",       "path": "adws/adw_plan_build.py" },
      { "id": "plan-build-test",  "path": "adws/adw_plan_build_test.py" },
      { "id": "scout",            "path": "adws/adw_scout.py" }
    ]
  }'
```

- `id` is also the prefix new task IDs get (`hello-adw-001`, `hello-adw-002`, …).
- `path` must be the **absolute** path on the host where the server process runs.
- Each `adws[].path` is relative to `path` and must point at a real script that
  `uv run .../install.py` stamped in — mismatch it and the board's Start button
  will tell you exactly what's missing rather than failing silently.

Reload `http://localhost:3000` (or just wait a couple seconds — it's live via
SSE) and open hamburger → **Projects**: `hello-adw` should be listed with
`ADWs: plan-build, plan-build-test, scout`.

---

## 4. Add a task to the project

In the website:

1. Click the **+** floating button (bottom-right) or press `N`.
2. Fill in:
   - **name** — what you want done, e.g. "Add a CONTRIBUTING.md"
   - **project** — `hello-adw`
   - **workflow / ADW** — pick `plan-build` (plans, builds, commits — good default)
   - **description** — the actual instructions the planner/builder will read,
     e.g. "Write a short CONTRIBUTING.md explaining how to run the test suite."
3. **save**.

The task lands in `todo`. CLI equivalent, if you'd rather script it (run from
`server/`; use `--workflow` rather than `-w` and `FACTORY_SERVER_URL` rather
than `-s` — both short flags collide with the CLI's own global options):

```bash
FACTORY_SERVER_URL=http://localhost:3000 node cli/bin/factory.js task create \
  "Add a CONTRIBUTING.md" -p hello-adw --workflow plan-build \
  -d "Write a short CONTRIBUTING.md explaining how to run the test suite."
```

---

## 5. Kick off the ADW

Click the task card to reopen it. Below the description there's now a
**workflow run** section with a **▶ start** button.

Click it. Watch what happens:

- The card jumps to the `in-progress` column.
- The panel starts polling every 2s and fills in as phases complete:
  `request → plan (planner) → build (builder) → commit (git)`, each with a
  colored status dot.
- Token count and running cost show up at the top of the panel.

When it finishes, the phase list turns green (or red, with the failing phase
called out) and the **■ stop** button reverts to **▶ start**. The commit
really landed in `~/projects/hello-adw` — check `git log` there.

The task **stays in `in-progress`** when the ADW finishes; moving it to `done`
is your call, same as dragging any other card.

**Stopping a run:** click **■ stop** to `SIGTERM` a workflow that's running
long or went sideways. Cheap to retry — starting the same task again resumes
its existing ADW session rather than starting cold, so context isn't lost.

**API equivalent**, if you're scripting this instead of clicking:
```bash
curl -s -X POST http://localhost:3000/api/v1/tasks/hello-adw-001/start
curl -s http://localhost:3000/api/v1/tasks/hello-adw-001/trace
curl -s -X POST http://localhost:3000/api/v1/tasks/hello-adw-001/stop
```

---

## 6. Watch everything at once

Hamburger menu → **Workflow Preview** opens a drawer listing every ADW
currently running across *all* projects and tasks, each with its own live
phase list, polling every 3s. Handy when you've queued up several tasks and
want a single glance at what's cooking. Close it with the `×` or `Esc`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ADW script not found at '.../adws/adw_plan_build.py'` | SSSF wasn't stamped into that project, or the `adws[].path` in step 3 doesn't match a real file | Re-run `uv run .claude/skills/sssf/scripts/install.py` in the project, or fix the path via `curl -X POST /api/v1/command -d '{"type":"update_project","payload":{"id":"hello-adw","adws":[...]}}'` |
| `SSSF roster config not found` | `adws/adw_sssf_config/sssf.config.yaml` missing | Same as above — SSSF isn't stamped in |
| ADW starts, then fails fast with a model error | The roster names a provider/model `pi` doesn't have `ready` | Re-check `pi --list-models` / `pi auth check --provider X`, edit `sssf.config.yaml` |
| `FileNotFoundError: .../models.json` in the run log (`GET /api/v1/tasks/:id/run-log`) | Your `pi` names its catalog file `models-store.json`, not `models.json` | Set `PI_MODELS_PATH` in the project's `.env` (step 2) |
| `:8080` shows the UI but every action fails / spins forever | The dockerized website can't reach the host server | Confirm the server from step 1 is actually running on `:3000`; if you're on Docker Desktop for Mac/Windows `host.docker.internal` resolves automatically, on Linux it needs the `extra_hosts: host-gateway` entry already in `docker-compose.yml` (Docker Engine 20.10+) |
| Board UI doesn't update after starting a task | SSE dropped | Refresh — `fetchBoardState()` re-syncs on load/focus regardless |

---

## Quick reference

```bash
# Board server (host, not Docker — needed for real ADW execution)
cd server && WORKSPACE_DIR=~/agenticboard-workspace npm start

# Dockerized website (optional second way to view the same board)
docker compose up -d website   # -> http://localhost:8080, proxies to :3000 on the host

# Stamp SSSF into a project
cd ~/projects/<name> && git init && git commit --allow-empty -m init
mkdir -p .claude/skills && cp -r ~/Documents/Habitats/AgenticBoard/super-simple-software-factory/.claude/skills/sssf .claude/skills/
uv run .claude/skills/sssf/scripts/install.py

# Register with the board (with real ADWs)
curl -X POST http://localhost:3000/api/v1/projects -H 'Content-Type: application/json' -d '{...}'

# Create a task
curl -X POST http://localhost:3000/api/v1/tasks -H 'Content-Type: application/json' \
  -d '{"name":"...","description":"...","project":"<id>","adw":"<adw-id>"}'

# Start / watch / stop
curl -X POST  http://localhost:3000/api/v1/tasks/<id>/start
curl          http://localhost:3000/api/v1/tasks/<id>/trace
curl -X POST  http://localhost:3000/api/v1/tasks/<id>/stop
```

# AgenticBoard — Browser Verification Guide

How an agent with browser automation should visually verify the AgenticBoard
web UI. Every check here has a matching deterministic test, so a failure in one
should show up in the other:

| Layer | Location | Runs with |
| --- | --- | --- |
| DOM / module behaviour | `website/tests/ui.test.ts`, `website/tests/agent-diagram.test.ts` | `cd website && npm test` |
| API endpoints + persistence | `server/tests/features.test.ts`, `server/tests/project-files.test.ts` | `cd server && npx vitest run tests/features.test.ts tests/project-files.test.ts` |

Check IDs (`EX-1`, `WF-3`, …) are shared between this document and the test
names. When you change a feature, update both sides.

### What the code suite cannot cover

These checks only exist here, so a browser pass is the only thing that
verifies them. Don't read a green test run as covering them:

| Check | Why it needs a browser |
| --- | --- |
| `EX-5` | Real HTML5 drag-and-drop sequencing and reload persistence. |
| `MD-5` | jsdom has no layout engine, so real caret/pixel alignment (including on a *wrapped* line) can't be measured. The suite substitutes a structural proxy instead. |
| `DU-5` | Synthesizing a genuine file drop. |
| `WF-11`, `WF-13` | Covered structurally, but the real degraded/conflict UX is worth seeing. |
| `AG-4` | Deletion goes through a native `confirm()` dialog, which browser automation must never trigger (see the rules below) — the suite stubs `window.confirm`, a browser pass has to actually see the prompt. |
| `RZ-1`, `RZ-2` | jsdom has no layout engine, so a `resize: both` handle can't actually be dragged. The suite only asserts the CSS declaration exists. |

`DU-8` and `DU-9` are deliberately server-side checks — the dedup and
path-sanitizing logic lives in the upload handler, so they're asserted in
`server/tests/features.test.ts`, not the DOM suite. The actual
`sssf.config.yaml` comment-preservation guarantee (`AG-3`'s save) is likewise
asserted server-side in `server/tests/project-files.test.ts` — the DOM suite
only checks that the right PUT payload gets sent, not that the file on disk
keeps its comments.

---

## 0. Setup

The server hosts the website itself, so one process is enough.

```bash
cd server
npm install
WORKSPACE_DIR=/tmp/ab-verify PORT=3200 npx tsx index.ts
```

Then open `http://localhost:3200`.

Register a project to test against (the board needs at least one, and document
upload writes into the project's own directory):

```bash
mkdir -p /tmp/ab-verify-proj
curl -X POST localhost:3200/api/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{"id":"demo","name":"demo project","path":"/tmp/ab-verify-proj"}'
```

**Never point `WORKSPACE_DIR` or a project path at the real repo** — these tests
create and delete tasks and write files.

### Rules for the automating agent

- Call `tabs_context_mcp` first, then open a **new** tab; don't reuse a tab.
- **Never trigger a native dialog** (`alert`/`confirm`/`prompt`). A dialog blocks
  the extension and kills the session. For XSS checks, assert on DOM structure
  with `javascript_tool` instead of letting a payload execute.
- Read `read_console_messages` after each section; any uncaught error is a
  failure even if the page looks right.
- The board is SSE-driven and refetches on focus, so state may update under you.
  Prefer asserting on a settled DOM.

---

## 1. Existing features (regression baseline)

Run these before touching the new features — they catch collateral damage.

### EX-1 — Board loads and renders columns
Open the page. The header shows `all projects`; the hero clock is drawn and its
hands move. Click `btn-collapse-board` / the FAB to reach the board.
**Pass:** `#kanban-canvas` contains one `.kanban-column` per configured column,
each with its display name. Footer counters show task/project/extension counts.

### EX-2 — Live status indicator
**Pass:** `#live-status .status-dot` is present and the SSE stream is connected
(no console errors about `/api/v1/events`).

### EX-3 — Create a task
Press `N` (or the FAB). Fill `#task-title-input` with `verify task`, pick the
`demo` project, submit.
**Pass:** the modal closes and a card titled `verify task` appears in the
default column.

### EX-4 — Edit a task
Click the new card. **Pass:** the modal title reads `edit task — <id>`, fields
are prefilled, and `#btn-delete-task` is visible.

### EX-5 — Drag a card between columns
Drag the card to another column.
**Pass:** the card renders in the target column and survives a page reload
(the move was persisted, not just visual).

### EX-6 — Search tasks
Press `/`. Type part of the task name into `#search-input`.
**Pass:** matching cards remain visible / are highlighted; `Esc` closes the
overlay.

### EX-7 — Column management
Hamburger → *Add Column*, create id `verify-col`, name `Verify Col`.
**Pass:** a new column appears; deleting it removes it.

### EX-8 — Extensions drawer
Hamburger → *Extensions*. **Pass:** the modal lists extensions (or an empty
state) and the register form is present.

### EX-9 — Workflow preview drawer
Hamburger → *Workflow Preview*. **Pass:** `#workflow-preview-panel` slides in
and shows active workflows or `no active workflows`.

### EX-10 — Escape closes modals
With any modal open, press `Esc`. **Pass:** it closes; no modal backdrop is
left blocking the board.

---

## 2. Workflow editor (new)

Hamburger → *Projects* to reach `#modal-projects`.

### WF-1 — Project search bar exists
**Pass:** `#project-search-input` is visible above the project list with
placeholder text about name/prefix/path.

### WF-2 — Search filters the list
Type `demo`. **Pass:** only matching rows remain in `#projects-container`.
Type a string matching nothing (`zzzz`) → a `No projects match "zzzz".` message
appears. Clearing the box restores all rows. Filtering must match against
**name, id/prefix, and path**, case-insensitively.

### WF-3 — Project rows are clickable
**Pass:** rows carry `.project-row` and show a pointer cursor / hover
highlight.

### WF-4 — Clicking a project opens the project view
Click the `demo` row.
**Pass:** `#modal-project-view` becomes visible. `#pv-modal-title` names the
project; `#pv-meta` shows its id/prefix, path, and agent files;
`#pv-adw-list` lists the project's ADWs (or an empty state).
Screenshot this.

### WF-5 — ADW fields are editable
Expand an ADW (add one via `#pv-add-adw-btn` if the project has none).
**Pass:** editable inputs exist for **id, name, path, model, and
parameters**. Typing changes their values without console errors. There is
**no separate "agents" field** — agent selection lives inside `parameters[]`
(see WF-6).

### WF-6 — An `agent`-typed parameter swaps in an agent-name picker
Add a parameter, set its type to `agent`.
**Pass:** the "default" field switches from plain text to a searchable
picker (`.pv-agent-name-picker`) sourced from the project's own
`sssf.config.yaml` roster (see section 5), showing each candidate's name and
purpose. Switching the type back to `string`/`number`/`boolean` reverts it to
plain text without losing the other fields (name, flag, label). This is the
same mechanism SSSF's own `--agent` CLI flag already uses — e.g. a real
`adw_prompt.py` ADW's `agent` parameter.

### WF-7 — Add and remove a parameter
Add a parameter with name `branch`, flag `--branch`, type `string`.
**Pass:** all parameter subfields are editable and removal works. `type` is
constrained to `string | number | boolean | agent`.

### WF-8 — Model picker lists provider *and* model
Open the model picker for an ADW.
**Pass:** each row shows the **provider and the model name, both visible** —
this is a hard requirement. The list is populated from `GET /api/v1/models`.
Screenshot this.

### WF-9 — Model picker is searchable
Type `opus`. **Pass:** the list narrows to matching entries. Typing a provider
(`google`) also filters — search covers both fields. Because the catalog has
hundreds of entries, the list is capped with a "keep typing" style hint rather
than rendering everything.

### WF-10 — Selecting a model sets it
Pick a model. **Pass:** the ADW's model field shows the selection
(`provider/model`), and it can be cleared back to unset.

### WF-11 — Model list degrades gracefully
Simulate failure — stop the server, or point the page at a build where `pi` is
absent, and reopen the picker.
**Pass:** a "model list unavailable" style note appears, manual model entry
still works, and **the page does not throw**. `GET /api/v1/models` must answer
HTTP 200 with an empty array, never 500.

### WF-12 — Saving persists to the server
Click `#pv-save-btn`.
**Pass:** `#pv-save-banner` reports success. Reload the page, reopen the
project view, and the edited name/model/agents/parameters are still there.
Confirm server-side:
```bash
curl -s localhost:3200/api/v1/projects/demo | python3 -m json.tool
```

### WF-13 — Save conflicts surface readably
Writes carry an `expected_revision`, so a stale board can conflict. Force one
(mutate the board in another tab, then save an old view).
**Pass:** a readable error is shown — not a silent failure and not a raw stack
trace.

### WF-14 — Renaming an ADW id is deliberate
Renaming an ADW id can orphan tasks that reference it.
**Pass:** the UI makes a rename explicit rather than incidental.

### WF-15 — Project view closes cleanly
Close via the `×`, and again via `Esc`.
**Pass:** both work. This matters because `app.js` binds its `data-close`
handlers at startup, before this modal exists, so the module binds its own.

---

## 3. Document upload (new)

Open the task modal (`N`).

### DU-1 — Upload box exists below the description
**Pass:** `#task-documents-group` sits **below** `#task-desc-input`, labelled
`upload documents`, containing `#doc-upload-box` and `#doc-upload-input`.

### DU-2 — Upload target is shown
**Pass:** `#doc-upload-target` names the destination, e.g.
`→ demo/documents`, and follows `#task-project-input` when you change project.

### DU-3 — Upload a file
Create `/tmp/ab-verify-upload.md` containing `# hello`, and upload it via
`#doc-upload-input` (use the `file_upload` tool).
**Pass:** `#doc-upload-status` reports success (green) and `#doc-list` lists the
filename with a human-readable size.
Confirm on disk — the file must land in the **project** directory, not the
workspace:
```bash
ls /tmp/ab-verify-proj/documents/
```

### DU-4 — Multiple files at once
Upload two files in one go. **Pass:** both are listed and both land on disk.

### DU-5 — Drag-and-drop
Drag a file onto `#doc-upload-box`.
**Pass:** the box shows the `.dragover` state while hovering, and dropping
uploads the file. (If your automation can't synthesize a real file drop, assert
the `dragover` class toggles on `dragenter`/`dragleave` and note the drop
itself as untested.)

### DU-6 — Existing documents are listed on open
Reopen the task modal. **Pass:** `#doc-list` shows previously uploaded files,
fetched via `GET /api/v1/projects/:id/documents`.

### DU-7 — No project selected
**Pass:** attempting an upload with no project shows
`select a project first` in red rather than failing silently.

### DU-8 — Duplicate names don't clobber
Upload the same filename twice.
**Pass:** the second is stored with a numeric suffix (`x.md` → `x-1.md`); the
original content is unchanged.

### DU-9 — Filenames can't escape the directory
This is a security check; drive it via the API since a browser won't send a
traversal filename:
```bash
curl -F 'files=@/tmp/ab-verify-upload.md;filename=../../evil.md' \
  localhost:3200/api/v1/projects/demo/documents
ls /tmp/ab-verify-proj/documents/   # evil.md lives HERE
ls /tmp/evil.md                     # must NOT exist
```
**Pass:** nothing is written outside `<project>/documents/`.

---

## 4. Markdown highlighting (new)

In the task modal's `#task-desc-input`.

### MD-1 — Editor is wrapped in a highlight overlay
**Pass:** the textarea is inside `.mde-wrap` with a `.mde-highlight` layer
behind it. The textarea keeps its own `id` and stays a real `<textarea>` — not
a `contenteditable` — because the save path reads `.value`.

### MD-2 — Headers are visually distinct
Type:
```
# Heading one
## Heading two
body text
```
**Pass:** header lines render larger/bolder and coloured versus body text
(`.mde-h1`, `.mde-h2`, `.mde-header-mark`). Screenshot this.

### MD-3 — Lists are coloured
Type `- alpha`, `* beta`, `1. gamma`.
**Pass:** the markers are coloured distinctly from the item text
(`.mde-list-marker`).

### MD-4 — Other constructs highlight
Exercise `` `inline code` ``, a fenced ``` block, `**bold**`, `_italic_`,
`> quote`, `[text](https://example.com)`, and `---`.
**Pass:** each is styled; link text and URL are distinguishable
(`.mde-link-text` / `.mde-link-url`).

### MD-5 — Overlay stays aligned  *(most important check)*
Type a long line that wraps, plus a mix of headers and body text. Click into
the middle of the text.
**Pass:** the caret lands exactly where the highlighted glyphs are. Any
vertical or horizontal drift between the highlight layer and the real text is a
failure. Verify with a screenshot, and check that headers do **not** shift
following lines out of alignment.

### MD-6 — Scrolling stays synced
Enter enough lines to overflow, then scroll.
**Pass:** the highlight layer scrolls with the textarea, staying aligned.

### MD-7 — Highlighting refreshes on programmatic value changes
Open an existing task whose description contains markdown.
**Pass:** highlighting is already applied on open. `app.js` assigns `.value`
directly, which fires no `input` event, so this only works because
`MarkdownEditor.refresh()` is called — a regression here shows as plain
unhighlighted text.

### MD-8 — The raw value is preserved
Type markdown, save the task, reopen it.
**Pass:** the description round-trips as **raw markdown**, with no injected
markup. Confirm via the API:
```bash
curl -s localhost:3200/api/v1/tasks/<task-id> | python3 -m json.tool
```

### MD-9 — Markdown source is not executed  *(security)*
Set the description to:
```
<img src=x onerror=alert(1)>
<script>alert(1)</script>
[x](javascript:alert(1))
```
**Pass:** the text renders **literally**. Assert with `javascript_tool` that
`.mde-highlight` contains **no** `img` or `script` element:
```js
const h = document.querySelector('.mde-highlight');
[h.querySelectorAll('img').length, h.querySelectorAll('script').length];
// expected: [0, 0]
```
Do **not** let an `alert()` actually fire.

---

## 5. Agent roles (new)

There is deliberately **no board-owned "Agent" entity**. A project's real
agent roster lives in its own `adws/adw_sssf_config/sssf.config.yaml` — the
project view reads and writes that actual file (`GET`/`PUT
/api/v1/projects/:id/sssf-config`), preserving its hand-written comments on
every edit (via the `yaml` npm package's Document API, not a naive
parse-and-restringify round trip). An ADW references an agent role via a
`parameters[]` entry with `type: 'agent'`, whose `default` is the agent's
`name` in that roster — the same convention SSSF's own `--agent` CLI flag
already uses.

The `demo` project from section 0 has no SSSF roster, which is itself worth
checking (AG-1) — but to exercise the rest of this section, stamp a minimal
one into it first:
```bash
mkdir -p /tmp/ab-verify-proj/adws/adw_sssf_config
cat > /tmp/ab-verify-proj/adws/adw_sssf_config/sssf.config.yaml <<'EOF'
# sssf.config.yaml — minimal fixture for browser verification.
defaults:
  model: google/gemini-3.7-flash   # inline comment — must survive every save
  thinking: medium
agents:
  - name: planner
    purpose: Turn a request into a plan.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user: adws/adw_data/prompt_engineering/planner/user.md
EOF
mkdir -p /tmp/ab-verify-proj/adws/adw_data/prompt_engineering/planner
echo "# Planner system prompt" > /tmp/ab-verify-proj/adws/adw_data/prompt_engineering/planner/system.md
echo "# Planner user prompt" > /tmp/ab-verify-proj/adws/adw_data/prompt_engineering/planner/user.md
```
Reopen the `demo` project view (close and reopen, or reload) after creating
this so the section picks it up.

### AG-1 — Agent Roles section exists above the workflow list; degrades gracefully
Open the project view. **Pass:** `#pv-agents-section` (header "agent roles
(sssf.config.yaml)") renders before the "workflows (adws)" header in DOM
order. **Before** stamping the fixture above, `#pv-agent-roles-list` shows a
message that SSSF hasn't been set up, and `#pv-add-agent-btn` / the
save-roster row are hidden — there's nothing to write into. **After**
stamping it, the `planner` roster entry renders as an editable card.

### AG-2 — Editing an agent's model/thinking/color/purpose
Expand the `planner` card.
**Pass:** editable fields exist for **model** (searchable picker, same UX as
an ADW's), **thinking** (`off/minimal/low/medium/high/xhigh/max`, plus a
"(default: …)" option meaning "inherit `defaults.thinking`"), **color**
(hex text input with a live swatch preview), and **purpose**. `tools`,
`writes`, and `harness_engineering` render as a read-only badge list with a
note that they're not editable here.

### AG-3 — Saving the roster preserves the file's comments
Change `planner`'s model, click **save agent roster**.
**Pass:** `#pv-agents-save-banner` reports success, independently of
`#pv-save-banner`/`#pv-save-btn` (the roster is a different backend resource
— `update_project` has no field for it). Confirm on disk that the edit
landed **and every comment survived**:
```bash
grep -c '#' <project-path>/adws/adw_sssf_config/sssf.config.yaml
grep 'model:' <project-path>/adws/adw_sssf_config/sssf.config.yaml | head -3
```

### AG-4 — Removing a roster agent
Click a card's delete (`✕`) button.
**Pass:** a `confirm()` dialog appears — **let it appear, don't dismiss it via
automation** (native dialogs block the extension; see the rules above). If you
must verify this check unattended, stub it first:
```js
window.confirm = () => true;
```
Confirming removes the card immediately (staged locally); if that agent's
`name` is still referenced by an ADW's `type: agent` parameter, it
immediately reappears as a "referenced, not in roster" row instead of
vanishing. Nothing is written to disk until **save agent roster** is clicked.

### AG-5 — An ADW-referenced agent absent from the roster is surfaced, with a one-click add
Add an ADW `type: agent` parameter (per WF-6) whose default names an agent
not in the roster (e.g. `coder`).
**Pass:** a dashed row (`.pv-agent-unregistered-row`) reading "referenced,
not in roster" appears above the roster cards, with a **+ add to roster**
button. Clicking it stages a real, editable card locally (name pre-filled) —
still requires **save agent roster** to persist.

### AG-6 — "+ new agent role" stages a standalone agent
Click `#pv-add-agent-btn`, type a name, click **Add to Roster**.
**Pass:** it appears as a real card even though nothing references it yet.
Save, then confirm two new files were created:
```bash
ls <project-path>/adws/adw_data/prompt_engineering/<name>/
```

---

## 6. Editing prompt files and workflow scripts (new)

Every agent card's system/user prompt, and every ADW card's own script file,
are edited the same way: a collapsible **show <label>** toggle that lazily
fetches the real file's content (`GET /api/v1/projects/:id/file?path=...`)
and a **save <label>** button that writes it back (`PUT`, same endpoint) —
both confined to the project's own directory.

### FE-1 — Agent prompt files (system.md / user.md)
On the `planner` card (per section 5's fixture), click **show system prompt**.
**Pass:** the real content of
`adws/adw_data/prompt_engineering/planner/system.md` loads into a
`resize: both` textarea. Edit it, click **save system prompt** — status
cycles to `saved`. Confirm on disk:
```bash
cat <project-path>/adws/adw_data/prompt_engineering/planner/system.md
```
Do the same for **user prompt**; both toggles are independent (collapsing
one doesn't discard unsaved edits in the other).

### FE-2 — Workflow script
On any ADW card (e.g. `implement-feature`), click **show script**.
**Pass:** the real content of the file at that ADW's `path` (e.g.
`adws/adw_prompt.py`) loads. Edit and save it; confirm the change landed on
disk at that exact path, not anywhere else in the project.

### FE-3 — A brand-new agent's prompt files don't 404 before they exist
Immediately after AG-6 (before saving anything into them), click **show
system prompt** on the newly-created card.
**Pass:** it loads an empty (but real, on-disk) file rather than erroring —
the roster save that created the card already scaffolded both `system.md`
and `user.md` with a one-line placeholder header.

---

## 7. Workflow diagram (new)

Still in the project view, next to the "workflows (adws)" header.

### DG-1 — List/diagram toggle exists and switches views
**Pass:** a pill toggle (`#pv-adw-view-toggle`, "list" / "diagram") sits next
to `#pv-add-adw-btn`. Clicking "diagram" hides `#pv-adw-list` and shows
`#pv-adw-diagram`; the active button is visually distinct. Reopening the
project view (even a different project) always starts back on "list".

### DG-2 — The diagram shows one box per workflow and per referenced agent id
**Pass:** a clickable UML-style box-and-line diagram renders: one box per ADW
(left column) connected by a line to a box per unique agent id its
`type: 'agent'` parameters reference (right column, deduplicated — an agent
used by two workflows is still one box with two incoming lines). Screenshot
this.

### DG-3 — Clicking a workflow node jumps to and expands its list-view card
Click a workflow's box in the diagram.
**Pass:** the view switches back to "list", the matching `.pv-adw-card`
expands, scrolls into view, and briefly highlights (`.pv-flash`).

### DG-4 — Clicking an agent-role node jumps to its Agent Roles card
Click an agent-role's box.
**Pass:** the page scrolls to and briefly highlights the matching card in
`#pv-agent-roles-list` (view stays wherever it was — the Agent Roles section
isn't view-toggled).

### DG-5 — "+ new workflow" / "+ new agent role" nodes work from the diagram
Click the dashed "+" node in each column (or, for a project with zero
workflows, the diagram's own empty-state add button).
**Pass:** behaves identically to the equivalent list-view button — a new
workflow lands you on an expanded, editable card; a new agent role opens an
inline draft card in the Agent Roles section.

### DG-6 — Large graphs stay usable
Add 8+ ADWs with a mix of shared and unique agent names.
**Pass:** the diagram scrolls (both axes) inside its own container rather than
overflowing the modal or the page; no console errors.

---

## 8. Long-text resize (new)

### RZ-1 — Task description can be resized horizontally, not just vertically
Open the task modal, drag the description box's resize handle (bottom-right
corner) sideways past the modal's current edge.
**Pass:** the box widens, and the markdown highlight overlay (`.mde-surface`)
tracks the new width exactly — no visible seam or misalignment between the
`<textarea>` and its `.mde-highlight` layer at the new size. **The whole
modal card grows to follow it** (`bindResizeGrowsModal`, a `ResizeObserver`)
rather than the box spilling past the modal's edge — no internal horizontal
scrollbar should appear inside `.modal-body` while doing this.

### RZ-2 — Agent system-prompt / workflow-script boxes resize the same way
On a configured agent card (AG-3), drag its system-prompt textarea's resize
handle both vertically and horizontally; then do the same for an ADW's
"show script" editor (section 6).
**Pass:** both directions work on both editors, and both grow the
project-view modal itself the same way RZ-1 does — check this doesn't
regress even though the script editor has a highlight overlay of its own
(section 10) sitting on top of the plain textarea case.

### RZ-3 — Long lines soft-wrap instead of requiring horizontal scroll
Type a paragraph of plain body text long enough to wrap in the task
description, without manually resizing the box.
**Pass:** it wraps at the box's current width, matching normal textarea
behavior — no horizontal scrollbar needed just to read it. This applies to
every large text field (description, agent prompts, workflow script).

---

## 10. Detail-view width, Python highlighting (new)

### DV-1 — Task and project-view modals are as wide as the waterfall view
Open the task modal and the project view (a project's row in the Projects
list) side by side (one after another).
**Pass:** both use the same `.modal-xl` sizing as the ADW trace/waterfall
modal (section on trace, not in this doc) — noticeably wider than a
`.modal-lg` list modal like Projects/Extensions.

### PY-1 — Workflow scripts are Python-syntax-highlighted; prompts are not
On an ADW card, click "show script" (a real `.py` file). Separately, click
"show system prompt" on an agent card.
**Pass:** the script editor colors keywords (`def`, `import`, `return`, …),
strings, comments, decorators, and numbers — check a triple-quoted docstring
spanning multiple lines highlights correctly start-to-finish. The click and
type into the middle of a highlighted line: **the caret lands exactly where
it visually should** (color-only highlighting shouldn't need the header
overlay's synthetic-caret workaround at all). The prompt editor (`.md`
file) shows **no** color highlighting — plain text only.

---

## 11. Archive (new)

Hamburger → *Archived Tasks* to reach the drawer described below.

### ARC-1 — A column's trash-can button archives, it doesn't delete the column
Create a column with at least one task in it, click its trash-can icon.
**Pass:** a `confirm()` dialog appears (see the rules above — let it show,
don't dismiss it via automation) naming how many tasks will move. Confirm
it. **Pass:** the column itself is still there, now empty; its task(s) are
gone from the board.

### ARC-2 — Declining the dialog changes nothing
Click a column's trash-can icon again, dismiss/cancel the dialog.
**Pass:** the column and its tasks are unchanged; no request was sent
(check `read_network_requests`).

### ARC-3 — Archived tasks are visible in their own drawer, not on the board
Open *Archived Tasks* from the hamburger menu.
**Pass:** the task(s) archived in ARC-1 appear here, each with a column
picker and a **restore** button. They do **not** appear as a column on the
main kanban board, and "Archived" never appears as an option in a task's
own status dropdown.

### ARC-4 — Restoring a task returns it to a real column
Pick a target column in the drawer's dropdown for an archived task, click
**restore**.
**Pass:** the task disappears from the drawer and reappears on the board in
the chosen column.

---

## 12. Wrap-up

1. Re-check `read_console_messages` for the whole session — zero uncaught
   errors.
2. Delete the tasks and project you created, or just drop the scratch dirs:
   ```bash
   rm -rf /tmp/ab-verify /tmp/ab-verify-proj /tmp/ab-verify-upload.md
   ```
3. Stop the server and close your tab.
4. Report per check ID: pass, fail, or untestable — and say which were
   untestable rather than implying full coverage.

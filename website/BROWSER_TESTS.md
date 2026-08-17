# AgenticBoard — Browser Verification Guide

How an agent with browser automation should visually verify the AgenticBoard
web UI. Every check here has a matching deterministic test, so a failure in one
should show up in the other:

| Layer | Location | Runs with |
| --- | --- | --- |
| DOM / module behaviour | `website/tests/ui.test.ts` | `cd website && npm test` |
| API endpoints + persistence | `server/tests/features.test.ts` | `cd server && npx vitest run tests/features.test.ts` |

Check IDs (`EX-1`, `WF-3`, …) are shared between this document and the test
names. When you change a feature, update both sides.

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
**Pass:** editable inputs exist for **id, name, path, model, agents, and
parameters**. Typing changes their values without console errors.

### WF-6 — Add and remove an agent
Add agent `planner`, then `coder`; remove `planner`.
**Pass:** the agent list reflects each change; removal takes out only the
targeted entry.

### WF-7 — Add and remove a parameter
Add a parameter with name `branch`, flag `--branch`, type `string`.
**Pass:** all parameter subfields are editable and removal works. `type` is
constrained to `string | number | boolean`.

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

## 5. Wrap-up

1. Re-check `read_console_messages` for the whole session — zero uncaught
   errors.
2. Delete the tasks and project you created, or just drop the scratch dirs:
   ```bash
   rm -rf /tmp/ab-verify /tmp/ab-verify-proj /tmp/ab-verify-upload.md
   ```
3. Stop the server and close your tab.
4. Report per check ID: pass, fail, or untestable — and say which were
   untestable rather than implying full coverage.

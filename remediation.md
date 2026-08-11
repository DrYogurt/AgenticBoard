---
description: Align AgenticBoard Phase 1 and Phase 2 with the deterministic AI Software Factory architecture
argument-hint: "[repository-path]"
---

# AgenticBoard Phase 1–2 Architecture Remediation

## Purpose

Refactor AgenticBoard so Phase 1 and Phase 2 conform to the AI Software Factory design. Preserve useful existing functionality, but correct the domain model, mutation boundary, consistency guarantees, client behavior, and Web UI contract.

Do not implement agent-runtime execution in this task. Establish the deterministic foundation that Phase 3 will consume.

## Desired Architecture

```text
               Web UI       TUI       CLI       Agents
                  \          |         |          /
                   \         |         |         /
                    v        v         v        v
                 +--------------------------------+
                 |      Deterministic Server      |
                 |                                |
                 | Commands | Validation | Events |
                 | Atomic state transitions       |
                 +---------------+----------------+
                                 |
                                 v
                         JSON Workspace
                    board / projects / tasks
                                 |
                                 v
                         Project -> ADW
                                 |
                                 v
                     Runtime adapter (Phase 3)
```

Required domain relationship:

```text
Task
 |- belongs to exactly one Project
 `- selects exactly one ADW supported by that Project

Task -> ADW -> Agent runtime
```

Tasks must not directly depend on Claude Code, Codex, Pi, a model, or a concrete agent implementation. Every client must use the same deterministic server operations; clients must never mutate workspace JSON through a private copy of the engine.

## Target Data Contracts

### Project

```json
{
  "id": "kanban-app",
  "name": "AI Kanban",
  "path": "/projects/kanban-app",
  "agent_files": ["AGENTS.md", "CLAUDE.md"],
  "adws": [
    { "id": "implement-feature", "path": "./workflows/implement-feature" },
    { "id": "fix-bug", "path": "./workflows/fix-bug" }
  ],
  "integrations": [],
  "metadata": {}
}
```

### Task

```json
{
  "id": "task-001",
  "name": "Add authentication",
  "description": "Implement login and sessions.",
  "project": "kanban-app",
  "adw": "implement-feature",
  "status": "todo"
}
```

If retaining `title` instead of `name` for compatibility, document the decision and provide a deterministic migration. Do not retain task-level `agent` as the execution selector.

## Phase 1 Errors to Correct

### 1. Missing ADW model

- `Project` does not declare ADWs.
- `Task` has no `adw` field.
- There is no `list_project_adws` operation.
- Task creation cannot validate that an ADW belongs to the selected project.

### 2. Direct task-to-agent coupling

- Tasks currently contain `agent`.
- CLI and Web UI expose concrete agent selection.
- Replace this with the `Task -> ADW -> runtime` abstraction.

### 3. Clients bypass the deterministic server

- CLI silently falls back to a local `DeterministicEngine` when HTTP fails.
- TUI instantiates a local engine and carries duplicate core code and schemas.
- Make CLI and TUI strict server clients. Connection or command failures must be explicit; they must not trigger hidden local mutations.
- Keep workspace initialization and server startup as clearly separated administrative commands.

### 4. Operations are not transactionally atomic

- Task create, move, and delete update task JSON and `board.json` separately.
- Reads occur before per-file locks, permitting lost updates.
- Lock acquisition failure silently proceeds without a lock.
- Protect the complete read-validate-modify-write operation with one workspace mutation lock or equivalent transaction mechanism.
- Commit all affected files as one recoverable logical transition. Do not emit events until the transition succeeds completely.

### 5. Task ID generation races

- IDs use an unlocked `max + 1` scan.
- Generate stable unique IDs inside the mutation transaction, or use a collision-safe deterministic allocation strategy.

### 6. Missing referential integrity

Reject operations when:

- a task references a nonexistent project;
- a task selects an ADW not declared by its project;
- a task references a nonexistent board column;
- deleting a project would orphan tasks;
- deleting a column would orphan tasks.

Do not auto-create a column because a task supplied an unknown status. Require an explicit `create_column` command.

Add a workspace-level validator for relationships spanning multiple JSON files. Validate state on read/startup as well as before writes. Malformed JSON must produce an explicit error; do not silently skip corrupt task files.

### 7. Incorrect event semantics

- The engine currently emits events for reads such as `get_board`.
- The browser responds by fetching the board, causing another event and a potential SSE feedback loop.
- Emit change events only for successfully committed mutations.
- Give events stable IDs, mutation type, affected resource IDs, timestamp, and resulting workspace revision.
- Reads must never generate change events.

### 8. Incomplete project operations

- Support project name, path, agent files, ADWs, optional metadata, and project-level integrations.
- Support deterministic create, read, update, list, and safe delete behavior.
- Treat integrations as informational project connections, not workflow execution mechanisms.

### 9. Required deterministic operations

Phase 1 must expose and test at least:

```text
get_board
get_task
list_tasks
create_task
update_task
delete_task
move_task

create_project
get_project
list_projects
update_project
delete_project
list_project_adws

create_column
rename_column
delete_column
reorder_columns
```

Reserve clear interfaces for `start_task` and `stop_task`, but do not implement runtime adapters in Phase 1–2.

## Phase 2 Errors to Correct

### 1. Wrong task form contract

The Web UI currently collects a column, optional project, and free-text agent. Replace it with:

```text
Name or title
Description
Project (required)
Workflow / ADW (required)
Initial status
```

The ADW selector must be populated only from the selected project's configured ADWs. Changing the project must refresh the ADW options and invalidate an incompatible selection.

### 2. Missing workflow presentation

- Show the selected ADW on every task card and in the task editor.
- Do not show a concrete agent assignment.
- Provide a disabled or clearly marked future execution area if needed, but do not fake Phase 3 execution state.

### 3. Task edit/move mismatch

- The task editor submits `status`, but the update handler ignores it.
- Either route status changes through the deterministic `move_task` operation or remove status from generic update payloads.
- Drag-and-drop and form-based movement must use the same server transition and validation rules.

### 4. Live synchronization loop

- Fix SSE so one committed mutation causes at most one client refresh.
- Reconnect safely after interruption.
- Do not overwrite an open editor with incoming state; detect conflicts using a workspace or resource revision.

### 5. TUI contract is incomplete

- TUI task creation currently accepts only a title.
- Add description, required project, and project-dependent ADW selection.
- Support viewing and editing those values through server APIs.
- Remove the copied engine, storage, types, validator, and schemas from the TUI project.

### 6. CLI contract is incomplete

Support an interface equivalent to:

```bash
factory task create \
  --project kanban-app \
  --name "Add authentication" \
  --description "Implement login and sessions" \
  --workflow implement-feature

factory project adws kanban-app
factory task move task-001 working
```

Remove `--agent` from task creation. Server failures must be returned to the user rather than silently falling back to local state.

## Implementation Workflow

1. Inspect the current schemas, types, engine, storage, server routes, CLI, TUI, Web UI, persisted sample state, and tests.
2. Write a concise migration plan mapping current records to the target contracts.
3. Add or update schemas and types for ADWs, project relationships, and task relationships.
4. Implement workspace-level validation and safe migration of existing JSON.
5. Refactor mutations into atomic workspace transactions and correct event emission.
6. Add project/ADW operations and update task commands.
7. Convert CLI and TUI into strict server clients.
8. Update the Web UI task form, cards, drag-and-drop, and synchronization behavior.
9. Add tests before removing compatibility paths.
10. Run builds and tests for server, CLI, TUI, and Web UI; report exact results.

## Acceptance Criteria

- A user can deterministically create a task with name/title, description, project, and an ADW supported by that project.
- Invalid project, ADW, or status references are rejected without modifying any file.
- Every mutation passes through one server and commits all affected JSON consistently.
- Concurrent task creation cannot generate duplicate IDs or lose updates.
- CLI, TUI, Web UI, and future agents use the same server operations.
- No task stores a concrete agent runtime as its workflow selector.
- Read commands emit no change events; one mutation does not cause an SSE request loop.
- Column and project deletion cannot orphan tasks.
- Existing valid data is migrated deterministically, with a backup and documented mapping.
- Automated tests cover schemas, cross-file invariants, concurrency, transaction failure, REST commands, SSE semantics, CLI behavior, TUI client behavior, and Web UI task creation/editing.
- All Phase 1 and Phase 2 tests and builds pass.

## Non-Goals

Do not add the following in this task:

- Claude Code, Codex, or Pi runtime adapters
- actual `start_task` or `stop_task` execution
- autonomous workflow generation
- multi-agent orchestration
- dependency scheduling
- a database or plugin framework
- complex permissions

## Report

Return:

1. Architecture changes made.
2. Data migration performed.
3. Files changed.
4. New deterministic invariants.
5. Tests added and exact test/build results.
6. Remaining Phase 3 extension points and any unresolved risks.

import { describe, it, expect } from 'vitest';
import { SchemaValidator } from '../core/validator';
import { Board, Project, Task } from '../core/types';

describe('SchemaValidator', () => {
  const validator = new SchemaValidator();

  it('validates a valid board JSON structure', () => {
    const validBoard: Board = {
      title: 'Test Board',
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'done', name: 'Done' }
      ],
      task_order: {
        todo: ['task-001'],
        done: []
      }
    };
    const res = validator.validate('board', validBoard);
    expect(res.valid).toBe(true);
  });

  it('rejects an invalid board JSON structure missing required fields', () => {
    const invalidBoard = {
      title: 'Test Board'
    };
    const res = validator.validate('board', invalidBoard);
    expect(res.valid).toBe(false);
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('validates a valid task JSON structure', () => {
    const validTask: Task = {
      id: 'task-001',
      name: 'Fix bug',
      title: 'Fix bug',
      project: 'kanban-app',
      adw: 'fix-bug',
      status: 'todo',
      description: 'Some detail'
    };
    const res = validator.validate('task', validTask);
    expect(res.valid).toBe(true);
  });

  it('validates a valid project structure with ADWs', () => {
    const validProject: Project = {
      id: 'my-project',
      name: 'My Project',
      path: '/path/to/proj',
      agent_files: ['AGENTS.md'],
      adws: [{ id: 'fix-bug', path: './workflows/fix-bug' }],
      integrations: [],
      metadata: {}
    };
    const res = validator.validate('project', validProject);
    expect(res.valid).toBe(true);
  });

  it('validates referential integrity across board, projects, and tasks', () => {
    const board: Board = {
      title: 'Test Board',
      columns: [{ id: 'todo', name: 'To Do' }],
      task_order: { todo: ['task-001'] }
    };
    const projects: Project[] = [
      {
        id: 'proj-1',
        path: '/proj-1',
        adws: [{ id: 'implement-feature', path: './workflows/implement-feature' }]
      }
    ];

    // Valid task
    const validTasks: Task[] = [
      {
        id: 'task-001',
        name: 'Auth Task',
        project: 'proj-1',
        adw: 'implement-feature',
        status: 'todo'
      }
    ];
    const validCheck = validator.validateReferentialIntegrity(board, projects, validTasks);
    expect(validCheck.valid).toBe(true);

    // Task with nonexistent project
    const invalidProjTask: Task[] = [
      ...validTasks,
      {
        id: 'task-002',
        name: 'Bad Proj Task',
        project: 'nonexistent-proj',
        adw: 'implement-feature',
        status: 'todo'
      }
    ];
    const invalidProjBoard = {
      ...board,
      task_order: { todo: ['task-001', 'task-002'] }
    };
    const invalidProjCheck = validator.validateReferentialIntegrity(invalidProjBoard, projects, invalidProjTask);
    expect(invalidProjCheck.valid).toBe(false);
    expect(invalidProjCheck.errors.some(e => e.includes("references nonexistent project 'nonexistent-proj'"))).toBe(true);

    // Task with undeclared ADW
    const invalidAdwTask: Task[] = [
      ...validTasks,
      {
        id: 'task-003',
        name: 'Bad ADW Task',
        project: 'proj-1',
        adw: 'undeclared-adw',
        status: 'todo'
      }
    ];
    const invalidAdwBoard = {
      ...board,
      task_order: { todo: ['task-001', 'task-003'] }
    };
    const invalidAdwCheck = validator.validateReferentialIntegrity(invalidAdwBoard, projects, invalidAdwTask);
    expect(invalidAdwCheck.valid).toBe(false);
    expect(invalidAdwCheck.errors.some(e => e.includes("selects ADW 'undeclared-adw' which is not declared"))).toBe(true);
  });
});

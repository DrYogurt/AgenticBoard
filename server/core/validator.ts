import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs';
import path from 'path';
import { Board, Project, Task } from './types';

export class SchemaValidator {
  private ajv: Ajv;
  private validators: Map<string, ValidateFunction> = new Map();

  constructor(schemasDir?: string) {
    this.ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
    addFormats(this.ajv);

    const possibleSchemaDirs = [
      path.join(__dirname, 'schemas'),
      path.join(__dirname, '../../../server/core/schemas'),
      path.join(__dirname, '../../server/core/schemas'),
      path.join(process.cwd(), 'server/core/schemas'),
      path.join(process.cwd(), 'core/schemas'),
      path.join(process.cwd(), 'schemas'),
      path.join(__dirname, '../schemas'),
      path.join(__dirname, '../../schemas')
    ];
    const dir = schemasDir || possibleSchemaDirs.find((d) => fs.existsSync(d)) || possibleSchemaDirs[0];
    this.loadSchemasFromDir(dir);
  }

  private loadSchemasFromDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (file.endsWith('.schema.json')) {
        const fullPath = path.join(dirPath, file);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const schema = JSON.parse(content);
          const name = file.replace('.schema.json', '');
          const validate = this.ajv.compile(schema);
          this.validators.set(name, validate);
        } catch (err) {
          console.error(`Failed to load schema ${file}:`, err);
        }
      }
    }
  }

  public validate(schemaName: string, data: any): { valid: boolean; errors?: string[] } {
    const validator = this.validators.get(schemaName);
    if (!validator) {
      return { valid: false, errors: [`Schema '${schemaName}' not found.`] };
    }
    const valid = validator(data);
    if (!valid && validator.errors) {
      const errors = validator.errors.map(
        (e) => `${e.instancePath || '/'} ${e.message}`
      );
      return { valid: false, errors };
    }
    return { valid: true };
  }

  public validateReferentialIntegrity(board: Board, projects: Project[], tasks: Task[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Check for duplicate column IDs
    const colIds = new Set<string>();
    for (const c of board.columns) {
      if (colIds.has(c.id)) {
        errors.push(`Duplicate column ID '${c.id}' found.`);
      }
      colIds.add(c.id);
    }

    // Check for duplicate project IDs and ADW IDs within projects
    const projMap = new Map<string, Project>();
    for (const p of projects) {
      if (projMap.has(p.id)) {
        errors.push(`Duplicate project ID '${p.id}' found.`);
      }
      projMap.set(p.id, p);
      
      const adwIds = new Set<string>();
      if (p.adws) {
        for (const adw of p.adws) {
          if (adwIds.has(adw.id)) {
            errors.push(`Duplicate ADW ID '${adw.id}' found in project '${p.id}'.`);
          }
          adwIds.add(adw.id);
        }
      }
    }

    // Check for duplicate task IDs
    const taskMap = new Map<string, Task>();
    for (const t of tasks) {
      if (taskMap.has(t.id)) {
        errors.push(`Duplicate task ID '${t.id}' found.`);
      }
      taskMap.set(t.id, t);
    }

    // Track task occurrences in task_order
    const taskOccurrences = new Map<string, number>();
    for (const t of tasks) {
      taskOccurrences.set(t.id, 0);
    }

    // Validate task_order
    for (const [colId, taskIds] of Object.entries(board.task_order)) {
      if (!colIds.has(colId)) {
        errors.push(`task_order references nonexistent column '${colId}'.`);
        continue;
      }
      
      for (const taskId of taskIds) {
        const task = taskMap.get(taskId);
        if (!task) {
          errors.push(`task_order in column '${colId}' references nonexistent task '${taskId}'.`);
        } else {
          taskOccurrences.set(taskId, (taskOccurrences.get(taskId) || 0) + 1);
          if (task.status !== colId) {
            errors.push(`Task '${taskId}' is in column '${colId}' but its status is '${task.status}'.`);
          }
        }
      }
    }

    // Check if every task appears exactly once in task_order
    for (const [taskId, count] of taskOccurrences.entries()) {
      if (count === 0) {
        errors.push(`Task '${taskId}' does not appear in any column's task_order.`);
      } else if (count > 1) {
        errors.push(`Task '${taskId}' appears in task_order ${count} times.`);
      }
    }

    for (const t of tasks) {
      if (!t.project) {
        errors.push(`Task '${t.id}' has no project specified.`);
        continue;
      }
      const proj = projMap.get(t.project);
      if (!proj) {
        errors.push(`Task '${t.id}' references nonexistent project '${t.project}'.`);
        continue;
      }
      if (!t.adw) {
        errors.push(`Task '${t.id}' has no ADW specified.`);
      } else {
        const projectAdws = proj.adws || [];
        if (!projectAdws.some((a) => a.id === t.adw)) {
          errors.push(`Task '${t.id}' selects ADW '${t.adw}' which is not declared by project '${t.project}'.`);
        }
      }
      if (!t.status || !colIds.has(t.status)) {
        errors.push(`Task '${t.id}' references nonexistent board column '${t.status}'.`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}


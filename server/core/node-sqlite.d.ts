// @types/node in this project predates node:sqlite (added in Node 22.5, stable by
// the Node 26 runtime this server targets). Minimal ambient surface for the
// read-only trace queries in core/trace.ts — not a full module declaration.
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): StatementResultingChanges;
  }

  export interface DatabaseSyncOptions {
    readOnly?: boolean;
    open?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}

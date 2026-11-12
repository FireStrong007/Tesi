import type { InitInfo, WorkerRequest } from "./db.worker";
import type { SchemaRepair } from "./migrate";
import type { Row, SqlExecutor, SqlParam, Statement } from "./sql";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
// Distributive Omit so each union member keeps its own fields
type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

/** Promise-based client for the SQLite worker. */
export class DbClient implements SqlExecutor {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  info: InitInfo | null = null;

  constructor() {
    this.worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
  }

  private call<T>(req: RequestBody, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  async init(): Promise<InitInfo> {
    this.info = await this.call<InitInfo>({ op: "init" });
    return this.info;
  }

  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return this.call<T[]>({ op: "all", sql, params });
  }

  run(sql: string, params?: SqlParam[]) {
    return this.call<{ changes: number; lastInsertRowid: number }>({ op: "run", sql, params });
  }

  batch(statements: Statement[]): Promise<void> {
    return this.call<void>({ op: "batch", statements });
  }

  /** A separate in-memory database in the same worker (lost on reload), for derived computations. */
  scratch(): SqlExecutor {
    return {
      all: <T = Row>(sql: string, params?: SqlParam[]) => this.call<T[]>({ op: "all", sql, params, scratch: true }),
      run: (sql: string, params?: SqlParam[]) => this.call<{ changes: number; lastInsertRowid: number }>({ op: "run", sql, params, scratch: true }),
      batch: (statements: Statement[]) => this.call<void>({ op: "batch", statements, scratch: true }),
    };
  }

  exportDb(): Promise<Uint8Array> {
    return this.call<Uint8Array>({ op: "export" });
  }

  /** Replaces the database; returns what the schema check had to repair in the imported file. */
  importDb(bytes: Uint8Array): Promise<SchemaRepair[]> {
    const copy = bytes.slice();
    return this.call<SchemaRepair[]>({ op: "import", bytes: copy }, [copy.buffer]);
  }

  wipe(): Promise<void> {
    return this.call<void>({ op: "wipe" });
  }
}

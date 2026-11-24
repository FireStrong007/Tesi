import type { InitInfo, WorkerRequest } from "./db.worker";
import type { Row, SqlExecutor, SqlParam, Statement } from "@bridge/core/db/sql";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
// Distributive Omit so each union member keeps its own fields
type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

/** Promise-based client for the SQLite worker (the browser's copy of the participant's data). */
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

  private call<T>(req: RequestBody): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id });
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

  bulk(sql: string, rows: SqlParam[][], before?: Statement[]): Promise<void> {
    return this.call<void>({ op: "bulk", sql, rows, before });
  }

  /** an empty copy (another person logged in) */
  async wipe(): Promise<void> {
    this.info = await this.call<InitInfo>({ op: "wipe" });
  }

  /** logout: the copy and its OPFS directory are removed, the worker stops */
  async erase(): Promise<void> {
    try {
      await this.call<void>({ op: "erase" });
    } finally {
      this.worker.terminate();
    }
  }

  /** stops the worker without touching the copy */
  close() {
    this.worker.terminate();
  }
}

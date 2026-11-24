/**
 * Thin SQL abstraction so the same repository/import code runs against
 * the browser worker (OPFS) and against an in-memory database in tests.
 */
export type SqlParam = number | string | null | Uint8Array | bigint | boolean;
export type Row = Record<string, unknown>;

export interface Statement {
  sql: string;
  params?: SqlParam[];
}

export interface SqlExecutor {
  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number; lastInsertRowid: number }>;
  /** runs all statements in one transaction */
  batch(statements: Statement[]): Promise<void>;
  /**
   * Optional: runs `before` then one prepared statement once per row, in one transaction (fast bulk
   * inserts; callers fall back to batch when it is missing).
   */
  bulk?(sql: string, rows: SqlParam[][], before?: Statement[]): Promise<void>;
}

export async function one<T = Row>(db: SqlExecutor, sql: string, params?: SqlParam[]): Promise<T | undefined> {
  const rows = await db.all<T>(sql, params);
  return rows[0];
}

/* ------------------------------------------------------------------------ */
/* Implementation on top of the sqlite-wasm "oo1" API (worker + node tests) */
/* ------------------------------------------------------------------------ */

// Minimal structural types for the parts of sqlite-wasm oo1 we use.
export interface Oo1Db {
  exec(opts: {
    sql: string;
    bind?: SqlParam[];
    rowMode?: "object" | "array";
    returnValue?: "resultRows";
  }): unknown;
  changes(): number;
  selectValue(sql: string): unknown;
  transaction<T>(fn: (db: Oo1Db) => T): T;
  prepare(sql: string): Oo1Stmt;
}

export interface Oo1Stmt {
  bind(params: SqlParam[]): Oo1Stmt;
  stepReset(): Oo1Stmt;
  finalize(): unknown;
}

const normalize = (params?: SqlParam[]) => params?.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));

export function oo1All(db: Oo1Db, sql: string, params?: SqlParam[]): Row[] {
  return db.exec({ sql, bind: normalize(params), rowMode: "object", returnValue: "resultRows" }) as Row[];
}

export function oo1Run(db: Oo1Db, sql: string, params?: SqlParam[]) {
  db.exec({ sql, bind: normalize(params) });
  return { changes: db.changes(), lastInsertRowid: Number(db.selectValue("SELECT last_insert_rowid()")) };
}

export function oo1Batch(db: Oo1Db, statements: Statement[]) {
  db.transaction((tx) => {
    for (const s of statements) tx.exec({ sql: s.sql, bind: normalize(s.params) });
  });
}

export function oo1Bulk(db: Oo1Db, sql: string, rows: SqlParam[][], before: Statement[] = []) {
  db.transaction((tx) => {
    for (const s of before) tx.exec({ sql: s.sql, bind: normalize(s.params) });
    const st = tx.prepare(sql);
    try {
      for (const r of rows) st.bind(normalize(r)!).stepReset();
    } finally {
      st.finalize();
    }
  });
}

export function oo1Executor(db: Oo1Db): SqlExecutor {
  return {
    all: async <T>(sql: string, params?: SqlParam[]) => oo1All(db, sql, params) as T[],
    run: async (sql, params) => oo1Run(db, sql, params),
    batch: async (st) => oo1Batch(db, st),
    bulk: async (sql, rows, before) => oo1Bulk(db, sql, rows, before),
  };
}

import { MIGRATIONS, SCHEMA_VERSION } from "./schema";
import { oo1All, type Oo1Db } from "./sql";

/** Applies pending migrations using PRAGMA user_version. */
export function migrate(db: Oo1Db) {
  db.exec({ sql: "PRAGMA foreign_keys = ON;" });
  const current = Number(db.selectValue("PRAGMA user_version")) || 0;
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction((tx) => {
      tx.exec({ sql: MIGRATIONS[v] });
      tx.exec({ sql: `PRAGMA user_version = ${v + 1}` });
    });
  }
}

export interface SchemaRepair {
  /** what was found and done, in Italian (shown in the Log page) */
  message: string;
  ok: boolean;
}

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/**
 * Compares the database with the schema the migrations produce (built in `fresh`, an empty
 * in-memory database) and recreates what is missing: whole tables and indexes from their CREATE
 * statement, single columns with ALTER TABLE. A database can reach the current version without
 * some object, e.g. when the same address served another copy of the app with a different
 * migration of the same number. Returns what was done (empty = the schema is complete).
 */
export function checkSchema(db: Oo1Db, fresh: Oo1Db): SchemaRepair[] {
  migrate(fresh);
  const objects = (d: Oo1Db) =>
    oo1All(d, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'") as unknown as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string;
    }[];
  const have = new Set(objects(db).map((o) => o.name));
  const out: SchemaRepair[] = [];
  const attempt = (message: string, sql: string) => {
    try {
      db.exec({ sql });
      out.push({ message, ok: true });
    } catch (e) {
      out.push({ message: `${message}: non riuscito (${(e as Error).message})`, ok: false });
    }
  };
  const expected = objects(fresh);
  // tables first, then their indexes
  for (const o of [...expected.filter((x) => x.type === "table"), ...expected.filter((x) => x.type === "index")]) {
    if (have.has(o.name)) continue;
    attempt(o.type === "table" ? `Tabella mancante «${o.name}»: ricreata` : `Indice mancante «${o.name}»: ricreato`, o.sql);
    have.add(o.name);
  }
  for (const t of expected.filter((x) => x.type === "table")) {
    const cols = (d: Oo1Db) => oo1All(d, `PRAGMA table_info(${t.name})`) as unknown as Col[];
    const present = new Set(cols(db).map((c) => c.name));
    for (const c of cols(fresh)) {
      if (present.has(c.name)) continue;
      // SQLite can add a NOT NULL column only with a default value
      if (c.notnull && c.dflt_value == null) {
        out.push({ message: `Colonna mancante «${t.name}.${c.name}»: non si può aggiungere (obbligatoria senza valore predefinito)`, ok: false });
        continue;
      }
      const def = `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`;
      attempt(`Colonna mancante «${t.name}.${c.name}»: aggiunta`, `ALTER TABLE ${t.name} ADD COLUMN ${def}`);
    }
  }
  return out;
}

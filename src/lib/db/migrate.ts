import { MIGRATIONS, SCHEMA_VERSION } from "./schema";
import type { Oo1Db } from "./sql";

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

/**
 * From a research server database (or the browser's copy of one participant's rows) to the app's
 * tables (activity_sample, sleep_session, stress_sample, …), on which loadDay, loadRange and the
 * comparison run unchanged. One adapter per app, chosen here: the same function in the browser,
 * on the server and in the tests.
 */
import type { AppId } from "./datasets";
import type { SqlExecutor } from "./db/sql";
import { createLocalViews } from "./server/views";

export interface AdapterOptions {
  /** TEMP tables with an index (a snapshot, fast to query) instead of TEMP views */
  materialize?: boolean;
}

export async function createAppTables(db: SqlExecutor, app: AppId, opts: AdapterOptions = {}) {
  switch (app) {
    case "vitabridge":
      return createLocalViews(db, opts);
    case "heartbridge":
      throw new Error("L'adattatore dei dati Gima arriva con la Fase 5");
  }
}

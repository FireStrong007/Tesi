/**
 * From a research server database (or the browser's copy of one participant's rows) to the app's
 * tables (activity_sample, sleep_session, stress_sample, …), on which loadDay, loadRange and the
 * comparison run unchanged. One adapter per app, chosen here: the same function in the browser,
 * on the server and in the tests.
 */
import type { AppId } from "./datasets";
import type { SqlExecutor } from "./db/sql";
import { GIMA_VIEWS } from "./gima/views";
import { LOCAL_VIEWS, createViews, updateTables } from "./server/views";

/** each app's views: Gadgetbridge's Garmin tables, or the Gima tables */
export const VIEWS_OF: Record<AppId, typeof LOCAL_VIEWS> = { vitabridge: LOCAL_VIEWS, heartbridge: GIMA_VIEWS };

export interface AdapterOptions {
  /** TEMP tables with an index (a snapshot, fast to query) instead of TEMP views */
  materialize?: boolean;
}

export async function createAppTables(db: SqlExecutor, app: AppId, opts: AdapterOptions = {}) {
  return createViews(db, VIEWS_OF[app], opts);
}

/**
 * The app's tables of the browser's copy, kept as persistent tables: rebuilt from `from` (a day
 * start of the study's zone) on, or entirely with null.
 */
export async function updateAppTables(db: SqlExecutor, app: AppId, opts: { from: number | null }) {
  return updateTables(db, VIEWS_OF[app], opts);
}

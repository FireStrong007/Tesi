/**
 * The logged-in participant's data: the copy in the browser (lib/db: SQLite on OPFS), kept in line
 * with the server (core/sync) at start, every hour while the app is open and with «Sincronizza»;
 * the app's tables are rebuilt from it by core's adapter after each sync. The copy belongs to one
 * person (core/sync/local-db): another login wipes it, the logout erases it from the device.
 * Pages read everything through useApp().
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { updateAppTables } from "@bridge/core/adapters";
import { DEFAULT_GOALS, type Goals } from "@bridge/core/goals";
import { clearDirty, dirtyFrom, getMeta, ownerOf, prepareLocalDb, setMeta } from "@bridge/core/sync/local-db";
import { syncCopy, type SyncApi, type SyncProgress, type SyncReport } from "@bridge/core/sync/sync";
import { startOfDay } from "@bridge/core/time-zone";
import { onLogout, useMe } from "@/auth";
import { ApiError, apiGet, apiPost, errorMessage } from "@/lib/api";
import { DbClient } from "@/lib/db/client";
import { AVAILABILITY_SQL } from "@/lib/empty-states";

/** the app's view of the person: their participant id (USER_ID of their rows), name and goals */
export type Person = Goals & { id: number; name: string };

export interface DeviceInfo {
  id: number;
  name: string | null;
  manufacturer: string | null;
  type_name: string | null;
  model: string | null;
  firmware_version: string | null;
  last_measurement_at: number | null;
  last_successful_upload_at: number | null;
  /** latest BATTERY_LEVEL of the device (Garmin), with its time (ms) */
  battery: number | null;
  battery_at: number | null;
}

export interface SyncStatus {
  /** when the copy was last brought in line with the server (ms), null before the first time */
  lastSyncAt: number | null;
  /** when the server's data copy was taken (ms) */
  dataTakenAt: number | null;
  syncing: boolean;
  progress: SyncProgress | null;
  /** the last sync failed (offline, server down): the copy stays as it was */
  error: string | null;
  /** nothing downloaded yet */
  empty: boolean;
}

interface AppValue {
  db: DbClient;
  user: Person;
  devices: DeviceInfo[];
  /** per section (lib/empty-states.ts): has the band ever recorded that kind of data? */
  available: Record<string, boolean>;
  status: SyncStatus;
  /** changes after every sync: pages reload their data */
  dataVersion: number;
  persistent: boolean;
  /** «Sincronizza»: asks the server for fresh data (at most every few minutes), then syncs */
  sync(): Promise<void>;
  saveGoals(patch: Partial<Goals>): Promise<void>;
  /** «Riscarica tutto»: empties the copy and downloads everything again */
  redownload(): Promise<void>;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

/** automatic sync while the app is open */
export const SYNC_EVERY_MS = 60 * 60_000;

const syncApi: SyncApi = {
  tables: () => apiGet("data/tables"),
  counts: () => apiGet("data/counts"),
  devices: () => apiGet("data/devices"),
  page: (t, p) =>
    apiGet(`data/table/${encodeURIComponent(t)}?device=${p.device}&limit=${p.limit ?? 5000}${p.since != null ? `&since=${p.since}` : ""}${p.after ? `&after=${encodeURIComponent(p.after)}` : ""}`),
};

/** measured with performance.measure, readable in the browser's tools (and by the tests) */
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    performance.measure(`bridge:${name}`, { start, end: performance.now() });
  }
}

async function loadDevices(db: DbClient): Promise<DeviceInfo[]> {
  const rows = await db.all<Omit<DeviceInfo, "battery" | "battery_at">>("SELECT * FROM device_info ORDER BY id");
  const battery = await db
    .all<{ device: number; level: number; at: number }>(
      // BATTERY_LEVEL is in seconds; only Garmin has it
      `SELECT b.DEVICE_ID AS device, b.LEVEL AS level, b.TIMESTAMP * 1000 AS at FROM BATTERY_LEVEL b
       JOIN (SELECT DEVICE_ID, max(TIMESTAMP) AS t FROM BATTERY_LEVEL GROUP BY DEVICE_ID) m ON m.DEVICE_ID = b.DEVICE_ID AND m.t = b.TIMESTAMP`,
    )
    .catch(() => []);
  return rows.map((d) => {
    const b = battery.find((x) => x.device === d.id);
    return { ...d, battery: b?.level ?? null, battery_at: b?.at ?? null };
  });
}

/** what the screen before the data shows: opening, the first download, or why it failed */
export interface StartState {
  error: Error | null;
  progress: SyncProgress | null;
  syncError: string | null;
  retry: () => void;
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (s: StartState) => ReactNode }) {
  const me = useMe();
  const app = me.app.id;
  const participantId = me.account.participantId!;
  const [db] = useState(() => new DbClient());
  const [opened, setOpened] = useState<{ persistent: boolean } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [dataVersion, setDataVersion] = useState(0);
  const [status, setStatus] = useState<SyncStatus>({ lastSyncAt: null, dataTakenAt: null, syncing: false, progress: null, error: null, empty: true });
  const running = useRef<Promise<void> | null>(null);

  /**
   * The app's tables from the copy (core's adapter), kept in the copy between visits: rebuilt only
   * from the first day a sync touched (or entirely the first time), then the pages reload.
   */
  const rebuild = useCallback(async () => {
    const dirty = await dirtyFrom(db);
    const exists = (await db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_sample'")).length > 0;
    if (dirty !== null || !exists) {
      await timed("rebuild", () => updateAppTables(db, app, { from: dirty === null || dirty === "all" ? null : startOfDay(dirty) }));
      await clearDirty(db);
    }
    setDevices(await loadDevices(db));
    const found: Record<string, boolean> = {};
    for (const [k, sql] of Object.entries(AVAILABILITY_SQL)) found[k] = (await db.all(sql).catch(() => [])).length > 0;
    found.activity = found.steps || found.hr;
    setAvailable(found);
    const [lastSync, takenAt] = await Promise.all([getMeta(db, "last_sync_at"), getMeta(db, "data_taken_at")]);
    setStatus((s) => ({ ...s, lastSyncAt: lastSync ? Number(lastSync) : null, dataTakenAt: takenAt ? Number(takenAt) : null }));
    setDataVersion((v) => v + 1);
  }, [db, app]);

  const runSync = useCallback(
    (refresh: boolean) => {
      // one sync at a time; asking again while one runs waits for it
      running.current ??= (async () => {
        setStatus((s) => ({ ...s, syncing: true, error: null, progress: null }));
        try {
          if (refresh) await apiPost("data/refresh").catch(() => undefined);
          const report: SyncReport = await timed("sync", () => syncCopy(db, syncApi, { onProgress: (p) => setStatus((s) => ({ ...s, progress: p })) }));
          if (report.recounted.length) console.info("Sincronizzazione: riscaricati per conteggi diversi", report.recounted);
          await rebuild();
          setStatus((s) => ({ ...s, syncing: false, progress: null, empty: false }));
        } catch (e) {
          // a 401 sends the app back to the login screen (lib/api); otherwise the copy stays as it was
          const message = e instanceof ApiError && e.status === 0 ? "Sei offline: vedi gli ultimi dati scaricati." : errorMessage(e);
          setStatus((s) => ({ ...s, syncing: false, progress: null, error: message }));
        } finally {
          running.current = null;
        }
      })();
      return running.current;
    },
    [db, rebuild],
  );

  // open the copy: wipe it if it is someone else's, show what it has, then sync
  useEffect(() => {
    let cancelled = false;
    const owner = ownerOf(app, me.account.username);
    void (async () => {
      try {
        const info = await timed("open", () => db.init());
        if (!(await prepareLocalDb(db, app, owner))) {
          await db.wipe();
          await prepareLocalDb(db, app, owner);
        }
        const hasData = !!(await getMeta(db, "last_sync_at"));
        const cached = await getMeta(db, "goals");
        if (cached) setGoals({ ...DEFAULT_GOALS, ...JSON.parse(cached) });
        if (hasData) {
          await rebuild();
          if (cancelled) return;
          setStatus((s) => ({ ...s, empty: false }));
        }
        setOpened({ persistent: info.persistent });
        apiGet<{ goals: Goals }>("me/settings")
          .then(async (r) => {
            setGoals(r.goals);
            await setMeta(db, "goals", JSON.stringify(r.goals));
          })
          .catch(() => undefined);
        void runSync(false);
      } catch (e) {
        if (!cancelled) setError(e as Error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, app, me.account.username, rebuild, runSync]);

  // every hour while the app is open, and when it comes back to the foreground after an hour
  useEffect(() => {
    const due = () => {
      const last = Number(status.lastSyncAt ?? 0);
      if (Date.now() - last >= SYNC_EVERY_MS) void runSync(false);
    };
    const timer = setInterval(due, 5 * 60_000);
    const onVisible = () => document.visibilityState === "visible" && due();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runSync, status.lastSyncAt]);

  // logout: the copy is erased from the device before the session ends
  useEffect(() => onLogout(() => db.erase()), [db]);

  const value = useMemo<AppValue | null>(() => {
    if (!opened) return null;
    return {
      db,
      user: { ...goals, id: participantId, name: me.account.username },
      devices,
      available,
      status,
      dataVersion,
      persistent: opened.persistent,
      sync: () => runSync(true),
      saveGoals: async (patch) => {
        const r = await apiPost<{ goals: Goals }>("me/settings", { goals: patch });
        setGoals(r.goals);
        await setMeta(db, "goals", JSON.stringify(r.goals));
      },
      redownload: async () => {
        await db.wipe();
        await prepareLocalDb(db, app, ownerOf(app, me.account.username));
        setStatus((s) => ({ ...s, empty: true, lastSyncAt: null }));
        await runSync(false);
      },
    };
  }, [opened, db, goals, participantId, me.account.username, devices, available, status, dataVersion, runSync, app]);

  if (!value || value.status.empty) return <>{fallback({ error, progress: status.progress, syncError: status.syncing ? null : status.error, retry: () => void runSync(false) })}</>;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { DbClient } from "@/lib/db/client";
import type { InitInfo } from "@/lib/db/db.worker";
import type { SchemaRepair } from "@/lib/db/migrate";
import { activeUser, ensureDefaultUser, listDevices, setActiveUser, type Device, type User } from "@/lib/db/repo";
import { DeviceManager, type LiveState } from "@/lib/device-manager";
import { log } from "@/lib/log";
import { toast } from "@/components/ui/sonner";

interface AppValue {
  db: DbClient;
  dbInfo: InitInfo;
  /** the profile on screen: the real user, or the demo profile while the demo is open */
  user: User;
  refreshUser: () => Promise<void>;
  /** opens the demo profile (creating the demo band the first time) */
  openDemo: () => Promise<void>;
  /** back to the real user's data */
  leaveDemo: () => Promise<void>;
  /** devices of the profile on screen */
  devices: Device[];
  refreshDevices: () => Promise<void>;
  manager: DeviceManager;
  /** increases after every sync/import so views reload their data */
  dataVersion: number;
  bumpData: () => void;
}

const Ctx = createContext<AppValue | null>(null);
/**
 * Live connection state changes about once a second while a band streams realtime
 * values; it has its own context so that only the views that show it re-render.
 */
const LiveCtx = createContext<Map<number, LiveState>>(new Map());

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp fuori da AppProvider");
  return v;
}

/** Connection state, sync progress and realtime values of every device. */
export function useLive(): Map<number, LiveState> {
  return useContext(LiveCtx);
}

let singleton: { db: DbClient; ready: Promise<InitInfo> } | null = null;
function getDb() {
  if (!singleton) {
    const db = new DbClient();
    singleton = { db, ready: db.init() };
  }
  return singleton;
}

/**
 * After the database is opened (at startup or after restoring a backup): say in the Log what the
 * schema check repaired, import again the files that had failed because of it, and run a one-time
 * recomputation asked by a migration.
 */
export async function afterSchemaCheck(repairs: SchemaRepair[], manager: DeviceManager) {
  const L = log("db");
  for (const r of repairs) (r.ok ? L.warn : L.error)(`Controllo dello schema: ${r.message}`);
  // files that failed for a missing table can be waiting also when the repair was done by a migration
  const res = await manager.reprocessSchemaFailures();
  for (const r of res.filter((x) => !x.ok)) L.error(`File ${r.fileId} (${r.source}) ancora non importabile: ${r.error}`);
  // once after an update that changes how data is computed (migration flag)
  if (await manager.runPendingReprocess())
    toast.success("Dati ricalcolati", { description: "I dati del bracciale sono stati ricalcolati dai file salvati con le regole aggiornate." });
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (error: Error | null) => ReactNode }) {
  const { db, ready } = getDb();
  const [dbInfo, setDbInfo] = useState<InitInfo | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [userRef] = useState(() => ({ id: 0 }));
  const manager = useMemo(() => new DeviceManager(db, () => userRef.id), [db, userRef]);

  const refreshUser = useCallback(async () => {
    const u = await activeUser(db);
    userRef.id = u.id;
    setUser(u);
  }, [db, userRef]);
  const refreshDevices = useCallback(async () => setDevices(await listDevices(db, userRef.id || undefined)), [db, userRef]);
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);
  const switchTo = useCallback(
    async (id: number) => {
      await setActiveUser(db, id);
      await refreshUser();
      await refreshDevices();
      bumpData();
    },
    [db, refreshUser, refreshDevices, bumpData],
  );
  const openDemo = useCallback(async () => {
    const id = await manager.openDemo();
    await switchTo(id);
  }, [manager, switchTo]);
  const leaveDemo = useCallback(async () => switchTo((await ensureDefaultUser(db)).id), [db, switchTo]);

  useEffect(() => {
    ready
      .then(async (info) => {
        setDbInfo(info);
        await refreshUser();
        await refreshDevices();
        await afterSchemaCheck(info.repairs, manager);
      })
      .catch((e) => setError(e));
  }, [ready, refreshUser, refreshDevices, manager]);

  useEffect(() => {
    manager.onDataChanged = () => {
      bumpData();
      void refreshDevices();
    };
    return () => {
      manager.onDataChanged = null;
    };
  }, [manager, bumpData, refreshDevices]);

  const live = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const value = useMemo(
    () => (dbInfo && user ? { db, dbInfo, user, refreshUser, openDemo, leaveDemo, devices, refreshDevices, manager, dataVersion, bumpData } : null),
    [db, dbInfo, user, refreshUser, openDemo, leaveDemo, devices, refreshDevices, manager, dataVersion, bumpData],
  );

  if (error || !value) return <>{fallback(error)}</>;
  return (
    <Ctx.Provider value={value}>
      <LiveCtx.Provider value={live}>{children}</LiveCtx.Provider>
    </Ctx.Provider>
  );
}

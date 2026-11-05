import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { DbClient } from "@/lib/db/client";
import type { InitInfo } from "@/lib/db/db.worker";
import { ensureDefaultUser, listDevices, type Device, type User } from "@/lib/db/repo";
import { DeviceManager, type LiveState } from "@/lib/device-manager";

interface AppValue {
  db: DbClient;
  dbInfo: InitInfo;
  user: User;
  refreshUser: () => Promise<void>;
  devices: Device[];
  refreshDevices: () => Promise<void>;
  manager: DeviceManager;
  live: Map<number, LiveState>;
  /** increases after every sync/import so views reload their data */
  dataVersion: number;
  bumpData: () => void;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp fuori da AppProvider");
  return v;
}

let singleton: { db: DbClient; ready: Promise<InitInfo> } | null = null;
function getDb() {
  if (!singleton) {
    const db = new DbClient();
    singleton = { db, ready: db.init() };
  }
  return singleton;
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
    const u = await ensureDefaultUser(db);
    userRef.id = u.id;
    setUser(u);
  }, [db, userRef]);
  const refreshDevices = useCallback(async () => setDevices(await listDevices(db)), [db]);
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  useEffect(() => {
    ready
      .then(async (info) => {
        setDbInfo(info);
        await refreshUser();
        await refreshDevices();
      })
      .catch((e) => setError(e));
  }, [ready, refreshUser, refreshDevices]);

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

  if (error || !dbInfo || !user) return <>{fallback(error)}</>;
  return (
    <Ctx.Provider value={{ db, dbInfo, user, refreshUser, devices, refreshDevices, manager, live, dataVersion, bumpData }}>
      {children}
    </Ctx.Provider>
  );
}

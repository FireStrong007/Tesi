/**
 * Who is logged in, from GET /api/auth/me. The server decides everything (role, participant):
 * the app only chooses which screens to show.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setValidDayHours } from "@bridge/core/metrics";
import { ApiError, apiGet, apiPost, setCsrfToken, setUnauthenticatedHandler } from "@/lib/api";

export interface Me {
  account: {
    username: string;
    role: "participant" | "admin";
    mustChangePassword: boolean;
    /** participants: the participant the account names, by id and code */
    participantId?: number;
    participantCode?: string | null;
    /** participants: ok, «da verificare» or «da ricreare» (no data) */
    link?: "ok" | "review" | "recreate";
  };
  csrfToken: string;
  app: { id: "vitabridge" | "heartbridge"; label: string };
  /** the rules the server computes with: the app follows the same ones */
  study: { timeZone: string; validDayHours: number };
  /** the server's data source (a fingerprint): the device's copy belongs to it */
  source: string;
}

/** run at logout before anything else (the participant's copy is erased from the device) */
const logoutHooks = new Set<() => Promise<void>>();
export function onLogout(fn: () => Promise<void>) {
  logoutHooks.add(fn);
  return () => void logoutHooks.delete(fn);
}

type State = { status: "loading" } | { status: "anonymous"; reason?: "expired" } | { status: "offline"; message: string } | { status: "ready"; me: Me };

interface AuthApi {
  state: State;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

/**
 * Who the participant was at the last login (name, role, app: no token, no health data), so that
 * without connection the app can still open their copy. Removed at logout.
 */
const CACHE_KEY = "bridge.me";
const cacheMe = (me: Me | null) => {
  try {
    if (me && me.account.role === "participant" && me.account.link === "ok") localStorage.setItem(CACHE_KEY, JSON.stringify({ account: me.account, app: me.app, study: me.study, source: me.source }));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage not available: no offline start */
  }
};
const cachedMe = (): Me | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const me = raw ? ({ ...JSON.parse(raw), csrfToken: "" } as Me) : null;
    // saved by an older version (without the data source): no offline start
    return me?.source && me.account.participantCode ? me : null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const ready = useCallback((me: Me) => {
    setCsrfToken(me.csrfToken);
    cacheMe(me);
    // one definition of a valid day: the server's
    setValidDayHours(me.study.validDayHours);
    setState({ status: "ready", me });
  }, []);

  const reload = useCallback(async () => {
    try {
      const me = await apiGet<Me | { account: null }>("auth/me");
      if (me.account) ready(me as Me);
      else {
        setCsrfToken(null);
        cacheMe(null);
        setState({ status: "anonymous" });
      }
    } catch (e) {
      setCsrfToken(null);
      if (e instanceof ApiError && e.status === 401) setState({ status: "anonymous" });
      else {
        // no connection: a participant who was logged in here sees their copy (read only, with a notice)
        const cached = e instanceof ApiError && e.status === 0 ? cachedMe() : null;
        if (cached) {
          setValidDayHours(cached.study.validDayHours);
          setState({ status: "ready", me: cached });
        } else setState({ status: "offline", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [ready]);

  useEffect(() => {
    // a session that ends while the app is open (inactivity, password reset, account disabled)
    setUnauthenticatedHandler(() => {
      setCsrfToken(null);
      setState({ status: "anonymous", reason: "expired" });
    });
    void reload();
    return () => setUnauthenticatedHandler(null);
  }, [reload]);

  const api = useMemo<AuthApi>(
    () => ({
      state,
      reload,
      login: async (username, password) => ready(await apiPost<Me>("auth/login", { username, password })),
      changePassword: async (currentPassword, newPassword) => ready(await apiPost<Me>("auth/password", { currentPassword, newPassword })),
      logout: async () => {
        try {
          // first the data on the device, even if the server cannot be reached
          for (const fn of [...logoutHooks]) await fn().catch((e) => console.error("Cancellazione dei dati locali non riuscita", e));
          await apiPost("auth/logout");
        } finally {
          setCsrfToken(null);
          cacheMe(null);
          setState({ status: "anonymous" });
        }
      },
    }),
    [state, reload, ready],
  );
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** the logged-in account (only inside the screens shown after login) */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "ready") throw new Error("useMe without a session");
  return state.me;
}

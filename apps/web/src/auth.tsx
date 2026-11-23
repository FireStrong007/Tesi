/**
 * Who is logged in, from GET /api/auth/me. The server decides everything (role, participant):
 * the app only chooses which screens to show.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPost, setCsrfToken, setUnauthenticatedHandler } from "@/lib/api";

export interface Me {
  account: { username: string; role: "participant" | "admin"; mustChangePassword: boolean };
  csrfToken: string;
  app: { id: "vitabridge" | "heartbridge"; label: string };
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const ready = useCallback((me: Me) => {
    setCsrfToken(me.csrfToken);
    setState({ status: "ready", me });
  }, []);

  const reload = useCallback(async () => {
    try {
      const me = await apiGet<Me | { account: null }>("auth/me");
      if (me.account) ready(me as Me);
      else {
        setCsrfToken(null);
        setState({ status: "anonymous" });
      }
    } catch (e) {
      setCsrfToken(null);
      if (e instanceof ApiError && e.status === 401) setState({ status: "anonymous" });
      else setState({ status: "offline", message: e instanceof Error ? e.message : String(e) });
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
          await apiPost("auth/logout");
        } finally {
          setCsrfToken(null);
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

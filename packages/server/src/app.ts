/**
 * The HTTP API (Hono). Rules that hold for every route:
 *  - the participant is always the one of the session: no route takes a participant id from a
 *    participant (only administrators name a participant, to create their account);
 *  - administrators never get health data, participants never get the administration;
 *  - requests that change something need the same Origin as PUBLIC_ORIGIN and, once logged in,
 *    the session's CSRF token in X-CSRF-Token;
 *  - error answers are short Italian messages: never a password, token, cookie or stack trace.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DATASETS } from "@bridge/core/datasets";
import { COMPARE_METRICS, type CompareMetric } from "@bridge/core/comparison/types";
import { checkGoals } from "@bridge/core/goals";
import { STUDY_TIME_ZONE } from "@bridge/core/time-zone";
import type { Config } from "./config";
import { NoDataError, type DataSource } from "./data-source";
import type { LoginLimiter } from "./auth/limiter";
import { dummyHash, hashPassword, passwordProblem, temporaryPassword, verifyPassword } from "./auth/passwords";
import { USERNAME_RE, normalizeUsername, sameToken, type Account, type AuthStore, type Role, type Session } from "./auth/store";
import type { ComparisonService } from "./comparison/service";
import type { Logger } from "./log";
import { BadRequest, countsOf, devicesOf, participantCode, participantExists, participantsOverview, readRows, tableInfos } from "./participant-data";

export interface AppDeps {
  config: Config;
  auth: AuthStore;
  data: DataSource;
  limiter: LoginLimiter;
  log: Logger;
  /** the comparison with the other participants (absent: the endpoints answer 503) */
  comparison?: ComparisonService;
  now?: () => number;
}

type Env = { Variables: { session: Session | null } };
type C = Context<Env>;

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

// participantId: the participant's own id, which their rows carry in USER_ID (never taken back from the client)
const publicAccount = (a: Account) => ({ username: a.username, role: a.role, mustChangePassword: a.mustChangePassword, ...(a.role === "participant" ? { participantId: a.participantId } : {}) });

/** the administrator's view of an account */
const adminAccount = (a: Account) => ({
  id: a.id,
  username: a.username,
  role: a.role,
  participantId: a.participantId,
  disabled: a.disabled,
  mustChangePassword: a.mustChangePassword,
  createdAt: a.createdAt,
  lastLoginAt: a.lastLoginAt,
});

/** a username from a participant code: lower case, invalid characters as "-" */
export function usernameFromCode(code: string) {
  const u = normalizeUsername(code).replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return u.length >= 3 ? u : `p-${u}`.slice(0, 40);
}

export function createApp(deps: AppDeps) {
  const { config, auth, data, limiter, log } = deps;
  const now = deps.now ?? Date.now;
  const ds = DATASETS[config.app];
  const cookieName = config.secureCookies ? "__Host-bridge_session" : "bridge_session";
  const app = new Hono<Env>();

  const setSessionCookie = (c: C, token: string, role: Role) =>
    setCookie(c, cookieName, token, { httpOnly: true, secure: config.secureCookies, sameSite: "Strict", path: "/", maxAge: Math.floor(config.sessionIdleMs[role] / 1000) });

  const clientIp = (c: C) => {
    if (config.trustProxy) {
      // the proxy appends the address it saw: the last entry is the one we can trust
      const fwd = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
      if (fwd?.length) return fwd[fwd.length - 1];
    }
    try {
      return getConnInfo(c).remote.address ?? "sconosciuto";
    } catch {
      return "sconosciuto";
    }
  };

  const body = async <T>(c: C): Promise<Partial<T>> => {
    try {
      const v = await c.req.json();
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Partial<T>;
    } catch {
      throw new HttpError(400, "Richiesta non valida.");
    }
  };

  const snapshot = () => {
    try {
      return data.current();
    } catch (e) {
      if (e instanceof NoDataError) throw new HttpError(503, "I dati non sono ancora disponibili. Riprova tra qualche minuto.", "no_data");
      throw e;
    }
  };

  // ------------------------------------------------------------ middleware

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });

  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Richiesta troppo grande." }, 413) }));

  // the session, renewed on use (inactivity limit per role): the cookie's lifetime is extended
  // with it, unless the route already set or removed the cookie (login, logout, password change)
  app.use("/api/*", async (c, next) => {
    const token = getCookie(c, cookieName);
    const session = auth.session(token);
    c.set("session", session);
    await next();
    const renewed = session && session.lastSeenAt >= now() - 1000;
    const touched = (c.res.headers.get("set-cookie") ?? "").includes(`${cookieName}=`);
    if (renewed && !touched && auth.session(token)) setSessionCookie(c, token!, session.account.role);
  });

  // requests that change something: same origin, and the session's CSRF token once logged in
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if (origin !== config.publicOrigin || (site && site !== "same-origin")) {
      log.warn("Richiesta rifiutata: origine non consentita", { path: c.req.path, origin: origin ?? null, ip: clientIp(c) });
      throw new HttpError(403, "Richiesta non consentita.", "origin");
    }
    if (c.req.path !== "/api/auth/login") {
      const s = c.get("session");
      if (!s) throw new HttpError(401, "Accesso richiesto.", "unauthenticated");
      if (!sameToken(c.req.header("x-csrf-token"), s.csrfToken)) throw new HttpError(403, "Richiesta non consentita: ricarica la pagina.", "csrf");
    }
    return next();
  });

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const s = c.get("session");
    if (!s) throw new HttpError(401, "Accesso richiesto.", "unauthenticated");
    return next();
  };
  const requireRole =
    (role: Role): MiddlewareHandler<Env> =>
    async (c, next) => {
      const s = c.get("session");
      if (!s) throw new HttpError(401, "Accesso richiesto.", "unauthenticated");
      if (s.account.mustChangePassword) throw new HttpError(403, "Devi prima cambiare la password.", "password_change_required");
      if (s.account.role !== role) throw new HttpError(403, "Non hai accesso a questa sezione.", "forbidden");
      return next();
    };
  const session = (c: C) => c.get("session")!;

  // ------------------------------------------------------------ authentication

  // what the app needs to compute like the server: the study's time zone and the valid day rule
  const study = { timeZone: STUDY_TIME_ZONE, validDayHours: config.validDayHours };
  const me = (c: C, s: { account: Account; csrfToken: string }) => c.json({ account: publicAccount(s.account), csrfToken: s.csrfToken, app: { id: ds.app, label: ds.label }, study });

  app.post("/api/auth/login", async (c) => {
    const b = await body<{ username: string; password: string }>(c);
    const username = typeof b.username === "string" ? normalizeUsername(b.username) : "";
    const password = typeof b.password === "string" ? b.password : "";
    const ip = clientIp(c);
    const keys = [`u:${username}`, `ip:${ip}`];
    const wait = limiter.retryAfter(keys);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      throw new HttpError(429, `Troppi tentativi. Riprova tra ${Math.ceil(wait / 60_000)} minuti.`, "rate_limited");
    }
    const row = username && password.length <= 200 ? auth.credentials(username) : undefined;
    // the same work whether the username exists or not
    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
    if (!row || !ok) {
      limiter.fail(keys);
      log.info("Accesso non riuscito", { username: username.slice(0, 40), ip });
      throw new HttpError(401, "Nome utente o password non corretti.", "bad_credentials");
    }
    if (row.disabled) {
      log.info("Accesso a un account disattivato", { username, ip });
      throw new HttpError(403, "Questo account è disattivato. Rivolgiti al responsabile dello studio.", "disabled");
    }
    limiter.succeed(keys[0]);
    const old = c.get("session");
    if (old) auth.endSession(old.tokenHash);
    const account = auth.get(row.id)!;
    const { token, csrfToken } = auth.startSession(account);
    auth.recordLogin(account.id);
    auth.purgeExpired();
    setSessionCookie(c, token, account.role);
    log.info("Accesso", { username: account.username, role: account.role, ip });
    return me(c, { account, csrfToken });
  });

  app.post("/api/auth/logout", requireSession, (c) => {
    const s = session(c);
    auth.endSession(s.tokenHash);
    deleteCookie(c, cookieName, { path: "/", secure: config.secureCookies });
    return c.json({ ok: true });
  });

  // not logged in is an ordinary answer here (the login screen asks it at every start)
  app.get("/api/auth/me", (c) => {
    const s = c.get("session");
    return s ? me(c, s) : c.json({ account: null, csrfToken: null, app: { id: ds.app, label: ds.label }, study });
  });

  app.post("/api/auth/password", requireSession, async (c) => {
    const s = session(c);
    const b = await body<{ currentPassword: string; newPassword: string }>(c);
    const current = typeof b.currentPassword === "string" ? b.currentPassword : "";
    const next = typeof b.newPassword === "string" ? b.newPassword : "";
    const row = auth.credentials(s.account.username);
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new HttpError(400, "La password attuale non è corretta.", "bad_password");
    const problem = passwordProblem(next, s.account.username);
    if (problem) throw new HttpError(400, problem, "weak_password");
    if (next === current) throw new HttpError(400, "La nuova password deve essere diversa da quella attuale.", "same_password");
    auth.setPassword(s.account.id, await hashPassword(next), false);
    // every other device is logged out; this one gets a new session
    auth.endSessionsOf(s.account.id);
    const account = auth.get(s.account.id)!;
    const { token, csrfToken } = auth.startSession(account);
    setSessionCookie(c, token, account.role);
    log.info("Password cambiata", { username: account.username });
    return me(c, { account, csrfToken });
  });

  // ------------------------------------------------------------ participant: own data only

  const participant = requireRole("participant");
  const pid = (c: C) => session(c).account.participantId!;

  app.get("/api/data/tables", participant, (c) => {
    const infos = tableInfos(snapshot().db, ds);
    return c.json({ tables: [...infos.values()].map(({ name, time, unit, columns, key, blobs }) => ({ name, time, unit, columns, key, blobs })) });
  });

  app.get("/api/data/devices", participant, (c) => {
    const snap = snapshot();
    return c.json({ devices: devicesOf(snap.db, ds, pid(c)), dataTakenAt: snap.takenAt });
  });

  app.get("/api/data/table/:table", participant, compress(), (c) => {
    const snap = snapshot();
    const info = tableInfos(snap.db, ds).get(c.req.param("table"));
    if (!info) throw new HttpError(404, "Tabella non disponibile.", "no_table");
    const since = c.req.query("since");
    const limit = c.req.query("limit");
    const device = c.req.query("device");
    const page = readRows(snap.db, info, pid(c), {
      device: device == null ? undefined : Number(device),
      since: since == null ? undefined : Number(since),
      after: c.req.query("after") || undefined,
      limit: limit == null ? undefined : Number(limit),
    });
    return c.json({ ...page, dataVersion: snap.version, dataTakenAt: snap.takenAt });
  });

  // rows per table and device, to check the browser's copy
  app.get("/api/data/counts", participant, (c) => {
    const snap = snapshot();
    return c.json({ counts: countsOf(snap.db, ds, pid(c)), dataVersion: snap.version, dataTakenAt: snap.takenAt });
  });

  // ------------------------------------------------------------ participant: comparison with the others

  const MAX_COMPARE_DAYS = 400;
  /** metric and period of a comparison request; the period in whole seconds, at most MAX_COMPARE_DAYS */
  const compareQuery = (c: C) => {
    const metric = c.req.query("metric") as CompareMetric;
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!COMPARE_METRICS.includes(metric)) throw new HttpError(400, "Metrica non valida.");
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > MAX_COMPARE_DAYS * 86_400) throw new HttpError(400, "Periodo non valido.");
    return { metric, from, to };
  };
  /** the cache (the previous one while a new one is built); the asking participant by their id */
  const compareSource = async (c: C) => {
    const src = deps.comparison ? await deps.comparison.source() : null;
    if (!src) throw new HttpError(503, "Il confronto non è ancora disponibile. Riprova tra qualche minuto.", "no_comparison");
    const me = pid(c);
    // never among the others; a participant not yet in the cache is not in it anyway
    const key = src.people.find((p) => p.id === me)?.key ?? `#${me}`;
    const st = deps.comparison!.status();
    c.header("Cache-Control", "no-store");
    return { src, key, meta: { minParticipants: src.minUsers, dataTakenAt: st.dataTakenAt } };
  };

  app.get("/api/compare/daily", participant, async (c) => {
    const { metric, from, to } = compareQuery(c);
    const { src, key, meta } = await compareSource(c);
    return c.json({ ...meta, days: await src.dailyDistribution(metric, from, to, { excludeUserId: key }) });
  });

  app.get("/api/compare/weekly", participant, async (c) => {
    const { metric, from, to } = compareQuery(c);
    const { src, key, meta } = await compareSource(c);
    return c.json({ ...meta, weeks: await src.weeklyDistribution(metric, from, to, { excludeUserId: key }) });
  });

  // the asking participant's period value is computed here from the same data as the others'
  app.get("/api/compare/standing", participant, async (c) => {
    const { metric, from, to } = compareQuery(c);
    const { src, key, meta } = await compareSource(c);
    return c.json({ ...meta, standing: await src.standingOf(metric, from, to, key) });
  });

  // ------------------------------------------------------------ participant: goals

  app.get("/api/me/settings", participant, (c) => c.json({ goals: auth.goals(session(c).account.id) }));

  app.post("/api/me/settings", participant, async (c) => {
    const b = await body<{ goals: unknown }>(c);
    const account = session(c).account;
    const checked = checkGoals(b.goals, auth.goals(account.id));
    if ("error" in checked) throw new HttpError(400, checked.error, "bad_goals");
    auth.setGoals(account.id, checked.goals);
    return c.json({ goals: checked.goals });
  });

  // «Sincronizza»: a newer copy only if the one in use is older than SYNC_REFRESH_MIN_AGE_MIN
  app.post("/api/data/refresh", participant, async (c) => {
    const r = await data.refresh(config.data.mode === "backup" ? { ifOlderThanMs: config.data.minAgeMin * 60_000 } : {});
    const st = data.status();
    return c.json({ updated: r.updated, dataTakenAt: st.takenAt, ...(r.error ? { warning: "Non è stato possibile scaricare dati più recenti: sono mostrati gli ultimi disponibili." } : {}) });
  });

  // ------------------------------------------------------------ administration (no health data)

  const admin = requireRole("admin");

  app.get("/api/admin/participants", admin, (c) => {
    const people = participantsOverview(snapshot().db, ds);
    const accounts = auth.list().filter((a) => a.role === "participant");
    const byParticipant = new Map(accounts.map((a) => [a.participantId!, a]));
    const known = new Set(people.map((p) => p.id));
    return c.json({
      participants: people.map((p) => {
        const a = byParticipant.get(p.id);
        return { ...p, suggestedUsername: usernameFromCode(p.code), account: a ? adminAccount(a) : null };
      }),
      // accounts whose participant is no longer in the data
      orphanAccounts: accounts.filter((a) => !known.has(a.participantId!)).map(adminAccount),
    });
  });

  app.post("/api/admin/accounts", admin, async (c) => {
    const b = await body<{ participantId: number; username: string }>(c);
    const participantId = b.participantId;
    if (typeof participantId !== "number" || !Number.isInteger(participantId)) throw new HttpError(400, "Partecipante non valido.");
    const db = snapshot().db;
    if (!participantExists(db, participantId)) throw new HttpError(404, "Partecipante non trovato.", "no_participant");
    const username = normalizeUsername(typeof b.username === "string" && b.username.trim() ? b.username : usernameFromCode(participantCode(db, participantId) ?? ""));
    if (!USERNAME_RE.test(username)) throw new HttpError(400, "Il nome utente deve avere 3–40 caratteri: lettere minuscole, cifre, punto, trattino o trattino basso.", "bad_username");
    if (auth.list().some((a) => a.participantId === participantId)) throw new HttpError(409, "Questo partecipante ha già un account.", "exists");
    if (auth.credentials(username)) throw new HttpError(409, "Questo nome utente è già usato.", "username_taken");
    const temp = temporaryPassword();
    const account = auth.create({ username, passwordHash: await hashPassword(temp), role: "participant", participantId, mustChangePassword: true });
    auth.audit(session(c).account, "account_created", account);
    log.info("Account creato", { by: session(c).account.username, username });
    // the only time the temporary password leaves the server
    return c.json({ account: adminAccount(account), temporaryPassword: temp }, 201);
  });

  const targetAccount = (c: C) => {
    const id = Number(c.req.param("id"));
    const a = Number.isInteger(id) ? auth.get(id) : undefined;
    if (!a) throw new HttpError(404, "Account non trovato.", "no_account");
    if (a.role !== "participant") throw new HttpError(403, "Gli account amministratore non si gestiscono da qui.", "forbidden");
    return a;
  };

  app.post("/api/admin/accounts/:id/reset-password", admin, async (c) => {
    const a = targetAccount(c);
    const temp = temporaryPassword();
    auth.setPassword(a.id, await hashPassword(temp), true);
    auth.endSessionsOf(a.id);
    auth.audit(session(c).account, "password_reset", a);
    log.info("Password reimpostata", { by: session(c).account.username, username: a.username });
    return c.json({ account: adminAccount(auth.get(a.id)!), temporaryPassword: temp });
  });

  for (const [path, disabled, action] of [
    ["disable", true, "account_disabled"],
    ["enable", false, "account_enabled"],
  ] as const) {
    app.post(`/api/admin/accounts/:id/${path}`, admin, (c) => {
      const a = targetAccount(c);
      auth.setDisabled(a.id, disabled);
      auth.audit(session(c).account, action, a);
      log.info(disabled ? "Account disattivato" : "Account riattivato", { by: session(c).account.username, username: a.username });
      return c.json({ account: adminAccount(auth.get(a.id)!) });
    });
  }

  app.get("/api/admin/audit", admin, (c) => c.json({ entries: auth.auditLog(200) }));

  app.get("/api/admin/status", admin, (c) => {
    const accounts = auth.list();
    return c.json({
      app: { id: ds.app, label: ds.label },
      data: data.status(),
      comparison: deps.comparison?.status() ?? null,
      accounts: { participants: accounts.filter((a) => a.role === "participant").length, admins: accounts.filter((a) => a.role === "admin").length },
    });
  });

  // ------------------------------------------------------------ errors

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Risorsa non trovata." }, 404) : c.text("Non trovato", 404)));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    log.error("Errore interno", { method: c.req.method, path: c.req.path, error: err });
    return c.json({ error: "Errore interno del server." }, 500);
  });

  return app;
}

/** Creates the first administrator from ADMIN_USERNAME / ADMIN_PASSWORD when there is none. */
export async function ensureFirstAdmin(auth: AuthStore, config: Config, log: Logger) {
  if (auth.countAdmins() > 0) return;
  if (!config.admin) {
    log.warn("Nessun amministratore: imposta ADMIN_USERNAME e ADMIN_PASSWORD e riavvia il server");
    return;
  }
  const username = normalizeUsername(config.admin.username);
  if (!USERNAME_RE.test(username)) throw new Error("ADMIN_USERNAME: 3–40 caratteri tra lettere minuscole, cifre, punto, trattino e trattino basso");
  const problem = passwordProblem(config.admin.password, username);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  // chosen by whoever configures the server: no forced change
  auth.create({ username, passwordHash: await hashPassword(config.admin.password), role: "admin", participantId: null, mustChangePassword: false });
  log.info("Primo amministratore creato", { username });
}

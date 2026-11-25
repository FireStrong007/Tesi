import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { DATASETS, type AppId } from "@bridge/core/datasets";
import { cohortParticipants, defaultGarminParticipants, writeGarminDb } from "@bridge/synth/garmin-db";
import { writeGimaDb } from "@bridge/synth/gima-db";
import { createApp, ensureFirstAdmin } from "../src/app";
import { ComparisonService, inlineBuilder, type Builder } from "../src/comparison/service";
import { LoginLimiter } from "../src/auth/limiter";
import { AuthStore } from "../src/auth/store";
import { loadConfig, configSecrets, type Config } from "../src/config";
import { createDataSource, type DataSource } from "../src/data-source";
import { createLogger } from "../src/log";

export const ORIGIN = "https://studio.example.org";
export const ADMIN = { username: "admin", password: "Amministratore-2026!" };
export const NOW = new Date("2026-11-20T12:00:00");

/** a temporary folder removed after the test file */
export function tempDir(prefix = "bridge-server-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows: a file still open somewhere; the system's temporary folder is cleaned anyway
    }
  });
  return dir;
}

const dbCache = new Map<string, string>();
/** a synthetic research database for the app (default participants, a few days), written once per file */
export function syntheticDb(app: AppId, dir: string, days = 3, cohort = 0) {
  const key = `${app}:${dir}:${days}:${cohort}`;
  let path = dbCache.get(key);
  if (!path) {
    path = join(dir, `${app}-data${cohort ? `-c${cohort}` : ""}.db`);
    if (app === "vitabridge") writeGarminDb(path, { now: NOW, participants: [...defaultGarminParticipants(), ...cohortParticipants(cohort)] });
    else writeGimaDb(path, { now: NOW });
    dbCache.set(key, path);
  }
  return path;
}

export interface TestServer {
  app: ReturnType<typeof createApp>;
  auth: AuthStore;
  data: DataSource;
  config: Config;
  comparison: ComparisonService;
  logs: string[];
  clock: { t: number };
  client(opts?: { origin?: string | null; ip?: string }): Client;
}

export async function testServer(opts: { app?: AppId; dir: string; dataFile?: string; env?: Record<string, string>; data?: DataSource; builder?: Builder; authDb?: string }): Promise<TestServer> {
  const appId = opts.app ?? "vitabridge";
  const config = loadConfig(
    {
      APP: appId,
      PUBLIC_ORIGIN: ORIGIN,
      DATA_MODE: "file",
      DATA_FILE: opts.dataFile ?? syntheticDb(appId, opts.dir),
      AUTH_DB: opts.authDb ?? join(opts.dir, `auth-${Math.random().toString(36).slice(2)}.db`),
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD: ADMIN.password,
      ...opts.env,
    },
    opts.dir,
  );
  const logs: string[] = [];
  const log = createLogger({ secrets: configSecrets(config), sink: (line) => logs.push(line) });
  const clock = { t: NOW.getTime() };
  const now = () => clock.t;
  const auth = new AuthStore(config.authDb, config.sessionIdleMs, now);
  // like main.ts: the accounts belong to one data source (throws on another one)
  try {
    auth.bindSource(config.source);
  } catch (e) {
    auth.close();
    throw e;
  }
  const data = opts.data ?? createDataSource(config.data, DATASETS[appId], log);
  afterAll(() => {
    data.close();
    auth.close();
  });
  await ensureFirstAdmin(auth, config, log);
  if (!opts.data) await data.start();
  const limiter = new LoginLimiter(config.login.maxFailures, config.login.windowMs, now);
  // the comparison is built in the main thread here (vitest does not run the TypeScript worker)
  const comparison = new ComparisonService(data, appId, { minParticipants: config.compareMinParticipants, builder: opts.builder ?? inlineBuilder, log, now });
  const app = createApp({ config, auth, data, limiter, log, now, comparison });
  return { app, auth, data, config, comparison, logs, clock, client: (o = {}) => new Client(app, o.origin === undefined ? ORIGIN : o.origin, o.ip) };
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

/** A browser: keeps the session cookie and the CSRF token, sends Origin on requests that change data. */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  /** every response body seen (for the secrets check) */
  readonly seen: Res[] = [];

  constructor(
    private app: TestServer["app"],
    private origin: string | null,
    private ip?: string,
  ) {}

  async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookie) h.cookie = this.cookie;
    if (method !== "GET") {
      if (this.origin) h.origin ??= this.origin;
      if (this.csrf) h["x-csrf-token"] ??= this.csrf;
    }
    if (this.ip) h["x-forwarded-for"] = this.ip;
    const res = await this.app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      const [, value] = pair.split("=");
      this.cookie = value ? pair : null;
    }
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const out = { status: res.status, body: parsed as T, text, headers: res.headers };
    this.seen.push(out as Res);
    const csrf = (parsed as { csrfToken?: string }).csrfToken;
    if (csrf) this.csrf = csrf;
    return out;
  }

  get = <T = Record<string, unknown>>(path: string) => this.req<T>("GET", path);
  post = <T = Record<string, unknown>>(path: string, body: unknown = {}) => this.req<T>("POST", path, body);

  async login(username: string, password: string) {
    return this.post<{ account: { username: string; role: string; mustChangePassword: boolean }; csrfToken: string; error?: string }>("/api/auth/login", { username, password });
  }
}

export interface ParticipantRow {
  id: number;
  code: string;
  suggestedUsername: string;
  account: { id: number; username: string; disabled: boolean } | null;
}

/** logs in as the administrator, creates an account for each participant code and logs each one in with a new password */
export async function participantClients(s: TestServer, codes: string[]) {
  const admin = s.client();
  await admin.login(ADMIN.username, ADMIN.password);
  const { body } = await admin.get<{ participants: ParticipantRow[] }>("/api/admin/participants");
  const out = new Map<string, { client: Client; participantId: number; password: string }>();
  for (const code of codes) {
    const p = body.participants.find((x) => x.code === code)!;
    const created = await admin.post<{ temporaryPassword: string }>("/api/admin/accounts", { participantId: p.id, code: p.code });
    const client = s.client();
    await client.login(p.suggestedUsername, created.body.temporaryPassword);
    const password = `Nuova-password-${code}`;
    await client.post("/api/auth/password", { currentPassword: created.body.temporaryPassword, newPassword: password });
    out.set(code, { client, participantId: p.id, password });
  }
  return { admin, participants: out };
}

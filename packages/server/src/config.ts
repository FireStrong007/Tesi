/**
 * Server configuration from environment variables (documented in the README, Fase 6).
 * Secrets (backup and admin passwords) are kept here and registered with the logger, which hides
 * them; describeConfig gives a summary without them.
 */
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { DATASETS, isAppId, type AppId } from "@bridge/core/datasets";
import { MIN_USERS } from "@bridge/core/comparison/aggregate";
import { DEFAULT_VALID_DAY_HOURS } from "@bridge/core/metrics";

export type DataConfig =
  | { mode: "file"; file: string }
  | {
      mode: "backup";
      url: string;
      username: string;
      password: string;
      /** folder for the downloaded copies */
      dir: string;
      /** automatic refresh, minutes */
      intervalMin: number;
      /** «Sincronizza» downloads a new copy only when the current one is older than this, minutes */
      minAgeMin: number;
      /** download timeout, seconds */
      timeoutSec: number;
    };

/**
 * Which research data an accounts database belongs to: the app, the mode and the file path or the
 * backup URL. The accounts database keeps it (auth/store.ts) and the server refuses to start on
 * another source, so that accounts made for one database never read another one.
 */
export interface DataSourceId {
  /** SHA-256 of app, mode and location */
  fingerprint: string;
  /** for people: "file C:\…\synthetic-garmin.db" */
  description: string;
}

export interface Config {
  app: AppId;
  host: string;
  port: number;
  /** the address people open (scheme + host + port): the only Origin accepted on requests that change data */
  publicOrigin: string;
  /** behind a reverse proxy: the client's IP (login limit) comes from X-Forwarded-For */
  trustProxy: boolean;
  /** cookie with Secure and the __Host- prefix (default: when publicOrigin is https) */
  secureCookies: boolean;
  data: DataConfig;
  /** the data source this server reads (the accounts database is bound to it) */
  source: DataSourceId;
  authDb: string;
  /** first administrator, created at startup when there is none */
  admin: { username: string; password: string } | null;
  /** inactivity after which a session ends, per role (milliseconds) */
  sessionIdleMs: { participant: number; admin: number };
  login: { maxFailures: number; windowMs: number };
  /** hours with heart rate for a valid day: one value for the app, the comparison and the tests */
  validDayHours: number;
  /** fewest other participants with data for any comparison aggregate (at least 5) */
  compareMinParticipants: number;
}

export class ConfigError extends Error {}

const num = (env: NodeJS.ProcessEnv, key: string, def: number, min = 0) => {
  const raw = env[key];
  if (raw == null || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) throw new ConfigError(`${key} deve essere un numero ≥ ${min} (trovato «${raw}»)`);
  return v;
};
const bool = (env: NodeJS.ProcessEnv, key: string, def: boolean) => {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return def;
  if (["1", "true", "yes", "si", "sì", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${key} deve essere true o false (trovato «${env[key]}»)`);
};
const required = (env: NodeJS.ProcessEnv, key: string) => {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`Manca la variabile ${key}`);
  return v;
};

/** Reads the configuration; relative paths are resolved against `baseDir`. */
export function loadConfig(env: NodeJS.ProcessEnv, baseDir = process.cwd()): Config {
  const path = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const app = (env.APP ?? "vitabridge").trim();
  if (!isAppId(app)) throw new ConfigError(`APP deve essere vitabridge o heartbridge (trovato «${app}»)`);
  const production = env.NODE_ENV === "production";

  let publicOrigin = env.PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) {
    if (production) throw new ConfigError("Manca la variabile PUBLIC_ORIGIN (es. https://vitabridge.esempio.it)");
    publicOrigin = "http://localhost:5173"; // the Vite dev server, which forwards /api here
  }
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new ConfigError(`PUBLIC_ORIGIN non è un indirizzo valido: «${publicOrigin}»`);
  }
  if (origin.origin !== publicOrigin.replace(/\/$/, "")) throw new ConfigError(`PUBLIC_ORIGIN deve essere solo schema, host e porta, senza percorso: «${publicOrigin}»`);
  publicOrigin = origin.origin;

  const where = dataLocation(env, baseDir);
  let data: DataConfig;
  if (where.mode === "file") data = { mode: "file", file: where.location };
  else {
    data = {
      mode: "backup",
      url: where.location,
      username: required(env, "BACKUP_USERNAME"),
      password: required(env, "BACKUP_PASSWORD"),
      dir: path(env.BACKUP_DIR?.trim() || `backup/${app}`),
      intervalMin: num(env, "BACKUP_INTERVAL_MIN", 60, 1),
      minAgeMin: num(env, "SYNC_REFRESH_MIN_AGE_MIN", 5, 0),
      timeoutSec: num(env, "BACKUP_TIMEOUT_SEC", 300, 5),
    };
  }

  const adminUser = env.ADMIN_USERNAME?.trim();
  const adminPassword = env.ADMIN_PASSWORD;
  if (!!adminUser !== !!adminPassword) throw new ConfigError("ADMIN_USERNAME e ADMIN_PASSWORD vanno impostate insieme");

  return {
    host: env.HOST?.trim() || (production ? "0.0.0.0" : "127.0.0.1"),
    port: num(env, "PORT", 8787, 1),
    publicOrigin,
    trustProxy: bool(env, "TRUST_PROXY", false),
    secureCookies: bool(env, "SECURE_COOKIES", origin.protocol === "https:"),
    data,
    ...loadAuthConfig(env, baseDir),
    admin: adminUser && adminPassword ? { username: adminUser, password: adminPassword } : null,
    login: { maxFailures: num(env, "LOGIN_MAX_FAILURES", 5, 1), windowMs: num(env, "LOGIN_WINDOW_MIN", 15, 1) * 60_000 },
    validDayHours: validDayHours(env),
    compareMinParticipants: compareMin(env),
  };
}

const compareMin = (env: NodeJS.ProcessEnv) => {
  const n = num(env, "COMPARE_MIN_PARTICIPANTS", MIN_USERS, MIN_USERS);
  if (!Number.isInteger(n)) throw new ConfigError(`COMPARE_MIN_PARTICIPANTS deve essere un numero intero ≥ ${MIN_USERS}`);
  return n;
};

const validDayHours = (env: NodeJS.ProcessEnv) => {
  const h = num(env, "VALID_DAY_MIN_HOURS", DEFAULT_VALID_DAY_HOURS, 1);
  if (!Number.isInteger(h) || h > 24) throw new ConfigError(`VALID_DAY_MIN_HOURS deve essere un numero intero tra 1 e 24 (trovato «${env.VALID_DAY_MIN_HOURS}»)`);
  return h;
};

/** Where the research data are: the file (mode file) or the backup URL (mode backup), checked. */
function dataLocation(env: NodeJS.ProcessEnv, baseDir: string): { mode: "file" | "backup"; location: string } {
  const mode = (env.DATA_MODE ?? "file").trim();
  if (mode === "file") {
    const file = env.DATA_FILE?.trim();
    if (!file) throw new ConfigError("Manca la variabile DATA_FILE (per provare: npm run gen:synthetic e DATA_FILE=data/synthetic-garmin.db)");
    return { mode, location: isAbsolute(file) ? file : resolve(baseDir, file) };
  }
  if (mode === "backup") {
    const url = required(env, "BACKUP_URL");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ConfigError("BACKUP_URL non è un indirizzo valido");
    }
    if (u.username || u.password) throw new ConfigError("BACKUP_URL non deve contenere credenziali: usa BACKUP_USERNAME e BACKUP_PASSWORD");
    return { mode, location: url };
  }
  throw new ConfigError(`DATA_MODE deve essere file o backup (trovato «${mode}»)`);
}

/** The identity of a data source (DataSourceId): the same file or URL gives the same fingerprint. */
export function dataSourceId(app: AppId, mode: "file" | "backup", location: string): DataSourceId {
  // paths: absolute; on Windows the case does not matter
  const where = mode === "file" ? (process.platform === "win32" ? resolve(location).toLowerCase() : resolve(location)) : new URL(location).href;
  return {
    fingerprint: createHash("sha256").update([app, mode, where].join("|")).digest("hex"),
    description: `${DATASETS[app].label}, ${mode === "file" ? `file ${resolve(location)}` : `backup da ${new URL(location).href}`}`,
  };
}

/**
 * Only what the accounts database needs (also used by the administrator commands, src/admin-cli.ts).
 * Without AUTH_DB the file is named after the data: with DATA_FILE=data/synthetic-garmin.db it is
 * auth/vitabridge-synthetic-garmin-auth.db, so that synthetic and real data never share accounts.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv, baseDir = process.cwd()): Pick<Config, "app" | "authDb" | "sessionIdleMs" | "source"> {
  const app = (env.APP ?? "vitabridge").trim();
  if (!isAppId(app)) throw new ConfigError(`APP deve essere vitabridge o heartbridge (trovato «${app}»)`);
  const where = dataLocation(env, baseDir);
  const named = where.mode === "file" ? `${app}-${basename(where.location, extname(where.location)).replace(/[^\w.-]+/g, "-")}` : app;
  const authDb = env.AUTH_DB?.trim() || `auth/${named}-auth.db`;
  return {
    app,
    source: dataSourceId(app, where.mode, where.location),
    authDb: isAbsolute(authDb) ? authDb : resolve(baseDir, authDb),
    sessionIdleMs: {
      participant: num(env, "SESSION_IDLE_DAYS_PARTICIPANT", 30, 0.01) * 86_400_000,
      admin: num(env, "SESSION_IDLE_HOURS_ADMIN", 8, 0.01) * 3_600_000,
    },
  };
}

/** The secret values of a configuration (the logger hides them wherever they appear). */
export function configSecrets(c: Config): string[] {
  const out: string[] = [];
  if (c.data.mode === "backup") {
    out.push(c.data.password, Buffer.from(`${c.data.username}:${c.data.password}`).toString("base64"));
  }
  if (c.admin) out.push(c.admin.password);
  return out;
}

/** A summary to log at startup: no passwords, no credentials. */
export function describeConfig(c: Config) {
  return {
    app: `${DATASETS[c.app].label} (${c.app})`,
    address: `${c.host}:${c.port}`,
    publicOrigin: c.publicOrigin,
    trustProxy: c.trustProxy,
    secureCookies: c.secureCookies,
    data: c.data.mode === "file" ? { mode: "file", file: c.data.file } : { mode: "backup", url: c.data.url, dir: c.data.dir, intervalMin: c.data.intervalMin, minAgeMin: c.data.minAgeMin },
    authDb: c.authDb,
    source: c.source.description,
    validDayHours: c.validDayHours,
    compareMinParticipants: c.compareMinParticipants,
    sessionIdle: { participantDays: c.sessionIdleMs.participant / 86_400_000, adminHours: c.sessionIdleMs.admin / 3_600_000 },
  };
}

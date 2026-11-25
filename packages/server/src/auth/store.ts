/**
 * The authentication database, separate from the research data and written only by this server
 * (e.g. auth/vitabridge-synthetic-garmin-auth.db): accounts, sessions, the audit log and the data
 * source it belongs to (auth_meta). A participant's account names the participant twice, by
 * participant.id and by participant.name (the code, unique): auth/link.ts checks that the two
 * still go together in the data copy in use.
 * Schema changes: append to MIGRATIONS, never edit an old entry (PRAGMA user_version).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_GOALS, checkGoals, type Goals } from "@bridge/core/goals";

export type Role = "participant" | "admin";

/**
 * ok: id and code go together (as far as the last check knew); review: «da verificare», they did
 * not in the data copy (relinked only by an administrator); recreate: an account made before the
 * codes were kept, never valid again.
 */
export type LinkState = "ok" | "review" | "recreate";

export interface Account {
  id: number;
  username: string;
  role: Role;
  /** participant.id in the research database; null for administrators */
  participantId: number | null;
  /** participant.name (the participant's code); null for administrators and old accounts */
  participantCode: string | null;
  linkState: LinkState;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  participant_id: number | null;
  participant_code: string | null;
  link_state: LinkState;
  must_change_password: number;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export const AUDIT_ACTIONS = [
  "account_created",
  "password_reset",
  "account_disabled",
  "account_enabled",
  // id and code no longer together in the data copy: «da verificare»
  "account_flagged",
  // id and code together again: active again by itself
  "account_restored",
  // an administrator moved the account to the code's new id
  "account_relinked",
  // the accounts database accepted another data source (admin-cli accept-source)
  "source_accepted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: number;
  at: number;
  actorUsername: string;
  action: AuditAction;
  targetUsername: string | null;
  participantId: number | null;
  participantCode: string | null;
  detail: string | null;
}

export interface Session {
  tokenHash: string;
  csrfToken: string;
  account: Account;
  expiresAt: number;
  lastSeenAt: number;
}

export const MIGRATIONS = [
  `CREATE TABLE account (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('participant', 'admin')),
    participant_id INTEGER UNIQUE,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    CHECK ((role = 'admin') = (participant_id IS NULL))
  );
  CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX session_account ON session (account_id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_account_id INTEGER,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('account_created', 'password_reset', 'account_disabled', 'account_enabled')),
    target_account_id INTEGER,
    target_username TEXT,
    participant_id INTEGER
  );
  CREATE INDEX audit_log_at ON audit_log (at);`,
  // the participant's goals (JSON, core/goals.ts), kept here so that they survive the logout
  `CREATE TABLE account_settings (
    account_id INTEGER PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
    goals TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  // the participant's code next to the id, the link's state, the data source of this database and
  // the new audit actions. Accounts made before have no code: "recreate" (never valid again).
  // The tables are rebuilt (SQLite cannot change constraints) with foreign keys off (see the runner).
  `CREATE TABLE account_new (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('participant', 'admin')),
    participant_id INTEGER,
    participant_code TEXT UNIQUE,
    link_state TEXT NOT NULL DEFAULT 'ok' CHECK (link_state IN ('ok', 'review', 'recreate')),
    must_change_password INTEGER NOT NULL DEFAULT 1,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    CHECK ((role = 'admin') = (participant_id IS NULL)),
    CHECK (role = 'admin' OR participant_code IS NOT NULL OR link_state = 'recreate')
  );
  INSERT INTO account_new (id, username, password_hash, role, participant_id, participant_code, link_state, must_change_password, disabled, created_at, last_login_at)
    SELECT id, username, password_hash, role, participant_id, NULL, CASE role WHEN 'participant' THEN 'recreate' ELSE 'ok' END, must_change_password, disabled, created_at, last_login_at FROM account;
  DROP TABLE account;
  ALTER TABLE account_new RENAME TO account;
  CREATE INDEX account_participant ON account (participant_id);
  CREATE TABLE audit_log_new (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_account_id INTEGER,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('account_created', 'password_reset', 'account_disabled', 'account_enabled', 'account_flagged', 'account_restored', 'account_relinked', 'source_accepted')),
    target_account_id INTEGER,
    target_username TEXT,
    participant_id INTEGER,
    participant_code TEXT,
    detail TEXT
  );
  INSERT INTO audit_log_new (id, at, actor_account_id, actor_username, action, target_account_id, target_username, participant_id)
    SELECT id, at, actor_account_id, actor_username, action, target_account_id, target_username, participant_id FROM audit_log;
  DROP TABLE audit_log;
  ALTER TABLE audit_log_new RENAME TO audit_log;
  CREATE INDEX audit_log_at ON audit_log (at);
  CREATE TABLE auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

/** who does what the server does by itself (flagging and restoring accounts) in the audit log */
export const SYSTEM_ACTOR = { id: null, username: "sistema" } as const;

export class SourceMismatchError extends Error {}

/** lower case, no spaces around, Unicode NFC */
export const normalizeUsername = (u: string) => u.normalize("NFC").trim().toLowerCase();
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  username: r.username,
  role: r.role,
  participantId: r.participant_id,
  participantCode: r.participant_code,
  linkState: r.link_state,
  mustChangePassword: !!r.must_change_password,
  disabled: !!r.disabled,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

export class AuthStore {
  readonly db: DatabaseSync;

  constructor(
    path: string,
    private idleMs: Record<Role, number>,
    private now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // foreign keys off while tables are rebuilt (a DROP TABLE would otherwise delete the sessions and
    // settings that point to it), checked before they are turned on again
    this.db.exec("PRAGMA foreign_keys = OFF");
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Migrazione ${v + 1} del database degli account: riferimenti non validi`);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  // ---------------------------------------------------------------- data source

  /** the data source this accounts database belongs to, or null (never bound yet) */
  source(): { fingerprint: string; description: string } | null {
    const get = (k: string) => (this.db.prepare("SELECT value FROM auth_meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    const fingerprint = get("source_fingerprint");
    return fingerprint ? { fingerprint, description: get("source_description") ?? "" } : null;
  }

  private setSource(s: { fingerprint: string; description: string }) {
    const set = this.db.prepare("INSERT INTO auth_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    set.run("source_fingerprint", s.fingerprint);
    set.run("source_description", s.description);
  }

  /**
   * At startup: the accounts database is bound to the first data source it is used with and then
   * refuses any other one (SourceMismatchError), so that accounts made for one database never read
   * another. A source moved on purpose is accepted with acceptSource (npm run admin:accept-source).
   */
  bindSource(s: { fingerprint: string; description: string }) {
    const bound = this.source();
    if (!bound) return this.setSource(s);
    if (bound.fingerprint !== s.fingerprint)
      throw new SourceMismatchError(
        `Il database degli account è stato creato per un'altra sorgente dati (${bound.description}); ora la sorgente è ${s.description}. ` +
          "Usa un altro file degli account (togli AUTH_DB: il nome predefinito dipende dai dati) oppure, se i dati sono gli stessi spostati altrove, esegui sul server: npm run admin:accept-source",
      );
  }

  /** binds the database to a new source; the accounts are checked again against it at their next use */
  acceptSource(s: { fingerprint: string; description: string }, actor: { id: number | null; username: string }) {
    const before = this.source();
    this.setSource(s);
    this.audit(actor, "source_accepted", null, `${before?.description ?? "nessuna"} → ${s.description}`);
    return before;
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- accounts

  /** the row with its password hash: only for checking a password */
  credentials(username: string) {
    return this.db.prepare("SELECT * FROM account WHERE username = ?").get(normalizeUsername(username)) as AccountRow | undefined;
  }

  get(id: number): Account | undefined {
    const r = this.db.prepare("SELECT * FROM account WHERE id = ?").get(id) as AccountRow | undefined;
    return r && toAccount(r);
  }

  list(): Account[] {
    return (this.db.prepare("SELECT * FROM account ORDER BY role, username").all() as unknown as AccountRow[]).map(toAccount);
  }

  countAdmins() {
    return (this.db.prepare("SELECT count(*) AS n FROM account WHERE role = 'admin'").get() as { n: number }).n;
  }

  create(a: { username: string; passwordHash: string; role: Role; participant: { id: number; code: string } | null; mustChangePassword: boolean }): Account {
    const r = this.db
      .prepare("INSERT INTO account (username, password_hash, role, participant_id, participant_code, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(normalizeUsername(a.username), a.passwordHash, a.role, a.participant?.id ?? null, a.participant?.code ?? null, a.mustChangePassword ? 1 : 0, this.now());
    return this.get(Number(r.lastInsertRowid))!;
  }

  byCode(code: string): Account | undefined {
    const r = this.db.prepare("SELECT * FROM account WHERE participant_code = ?").get(code) as AccountRow | undefined;
    return r && toAccount(r);
  }

  /** the link's state, and the participant's id when an administrator relinks the account */
  setLink(id: number, state: LinkState, participantId?: number) {
    if (participantId === undefined) this.db.prepare("UPDATE account SET link_state = ? WHERE id = ?").run(state, id);
    else this.db.prepare("UPDATE account SET link_state = ?, participant_id = ? WHERE id = ?").run(state, participantId, id);
  }

  setPassword(id: number, passwordHash: string, mustChange: boolean) {
    this.db.prepare("UPDATE account SET password_hash = ?, must_change_password = ? WHERE id = ?").run(passwordHash, mustChange ? 1 : 0, id);
  }

  setDisabled(id: number, disabled: boolean) {
    this.db.prepare("UPDATE account SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
    if (disabled) this.endSessionsOf(id);
  }

  recordLogin(id: number) {
    this.db.prepare("UPDATE account SET last_login_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** the account's goals: the saved ones over the defaults */
  goals(accountId: number): Goals {
    const r = this.db.prepare("SELECT goals FROM account_settings WHERE account_id = ?").get(accountId) as { goals: string } | undefined;
    if (!r) return { ...DEFAULT_GOALS };
    const checked = checkGoals(JSON.parse(r.goals));
    return "goals" in checked ? checked.goals : { ...DEFAULT_GOALS };
  }

  setGoals(accountId: number, goals: Goals) {
    this.db
      .prepare("INSERT INTO account_settings (account_id, goals, updated_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET goals = excluded.goals, updated_at = excluded.updated_at")
      .run(accountId, JSON.stringify(goals), this.now());
  }

  // ---------------------------------------------------------------- sessions

  /** a new session: the token goes only in the cookie, the database keeps its SHA-256 */
  startSession(account: Account) {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const t = this.now();
    const expiresAt = t + this.idleMs[account.role];
    this.db.prepare("INSERT INTO session (token_hash, account_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(token), account.id, csrfToken, t, t, expiresAt);
    return { token, csrfToken, expiresAt };
  }

  /**
   * The valid session of a cookie token, renewed (inactivity limit of the account's role).
   * Expired sessions and sessions of disabled accounts are removed and give null.
   */
  session(token: string | undefined): Session | null {
    if (!token || token.length > 200) return null;
    const hash = sha256(token);
    const row = this.db.prepare("SELECT s.token_hash, s.csrf_token, s.last_seen_at, s.expires_at, a.* FROM session s JOIN account a ON a.id = s.account_id WHERE s.token_hash = ?").get(hash) as
      | (AccountRow & { token_hash: string; csrf_token: string; last_seen_at: number; expires_at: number })
      | undefined;
    if (!row) return null;
    const t = this.now();
    if (row.expires_at <= t || row.disabled) {
      this.endSession(hash);
      return null;
    }
    const account = toAccount(row);
    let { last_seen_at: lastSeenAt, expires_at: expiresAt } = row;
    // renew at most once a minute (fewer writes)
    if (t - lastSeenAt > 60_000) {
      lastSeenAt = t;
      expiresAt = t + this.idleMs[account.role];
      this.db.prepare("UPDATE session SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(lastSeenAt, expiresAt, hash);
    }
    return { tokenHash: hash, csrfToken: row.csrf_token, account, expiresAt, lastSeenAt };
  }

  endSession(tokenHash: string) {
    this.db.prepare("DELETE FROM session WHERE token_hash = ?").run(tokenHash);
  }

  endSessionsOf(accountId: number, except?: string) {
    this.db.prepare("DELETE FROM session WHERE account_id = ? AND token_hash <> ?").run(accountId, except ?? "");
  }

  purgeExpired() {
    this.db.prepare("DELETE FROM session WHERE expires_at <= ?").run(this.now());
  }

  // ---------------------------------------------------------------- audit log

  /**
   * `actor`: an administrator's account, a command run on the server (id null, see admin-cli.ts) or
   * the server itself (SYSTEM_ACTOR); `detail`: what changed, in words (no secrets, no health data)
   */
  audit(actor: { id: number | null; username: string }, action: AuditAction, target: Account | null, detail: string | null = null) {
    this.db
      .prepare(
        "INSERT INTO audit_log (at, actor_account_id, actor_username, action, target_account_id, target_username, participant_id, participant_code, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), actor.id, actor.username, action, target?.id ?? null, target?.username ?? null, target?.participantId ?? null, target?.participantCode ?? null, detail);
  }

  auditLog(limit = 200): AuditEntry[] {
    return (
      this.db.prepare("SELECT id, at, actor_username, action, target_username, participant_id, participant_code, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT ?").all(limit) as {
        id: number;
        at: number;
        actor_username: string;
        action: AuditAction;
        target_username: string | null;
        participant_id: number | null;
        participant_code: string | null;
        detail: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      at: r.at,
      actorUsername: r.actor_username,
      action: r.action,
      targetUsername: r.target_username,
      participantId: r.participant_id,
      participantCode: r.participant_code,
      detail: r.detail,
    }));
  }
}

/** compares two CSRF tokens in constant time */
export function sameToken(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

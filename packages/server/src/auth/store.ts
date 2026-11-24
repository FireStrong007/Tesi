/**
 * The authentication database, separate from the research data and written only by this server
 * (e.g. auth/vitabridge-auth.db): accounts, sessions and the administrators' audit log.
 * Schema changes: append to MIGRATIONS, never edit an old entry (PRAGMA user_version).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "participant" | "admin";

export interface Account {
  id: number;
  username: string;
  role: Role;
  /** participant.id in the research database; null for administrators */
  participantId: number | null;
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
  must_change_password: number;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export type AuditAction = "account_created" | "password_reset" | "account_disabled" | "account_enabled";

export interface AuditEntry {
  id: number;
  at: number;
  actorUsername: string;
  action: AuditAction;
  targetUsername: string | null;
  participantId: number | null;
}

export interface Session {
  tokenHash: string;
  csrfToken: string;
  account: Account;
  expiresAt: number;
  lastSeenAt: number;
}

const MIGRATIONS = [
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
];

/** lower case, no spaces around, Unicode NFC */
export const normalizeUsername = (u: string) => u.normalize("NFC").trim().toLowerCase();
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  username: r.username,
  role: r.role,
  participantId: r.participant_id,
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
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      this.db.exec(MIGRATIONS[v]);
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
      this.db.exec("COMMIT");
    }
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

  create(a: { username: string; passwordHash: string; role: Role; participantId: number | null; mustChangePassword: boolean }): Account {
    const r = this.db
      .prepare("INSERT INTO account (username, password_hash, role, participant_id, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(normalizeUsername(a.username), a.passwordHash, a.role, a.participantId, a.mustChangePassword ? 1 : 0, this.now());
    return this.get(Number(r.lastInsertRowid))!;
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

  /** `actor`: an administrator's account, or a command run on the server (id null, see admin-cli.ts) */
  audit(actor: { id: number | null; username: string }, action: AuditAction, target: Account) {
    this.db
      .prepare("INSERT INTO audit_log (at, actor_account_id, actor_username, action, target_account_id, target_username, participant_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.now(), actor.id, actor.username, action, target.id, target.username, target.participantId);
  }

  auditLog(limit = 200): AuditEntry[] {
    return (
      this.db.prepare("SELECT id, at, actor_username, action, target_username, participant_id FROM audit_log ORDER BY at DESC, id DESC LIMIT ?").all(limit) as {
        id: number;
        at: number;
        actor_username: string;
        action: AuditAction;
        target_username: string | null;
        participant_id: number | null;
      }[]
    ).map((r) => ({ id: r.id, at: r.at, actorUsername: r.actor_username, action: r.action, targetUsername: r.target_username, participantId: r.participant_id }));
  }
}

/** compares two CSRF tokens in constant time */
export function sameToken(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

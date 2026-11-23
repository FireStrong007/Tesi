/**
 * Where the research server's data comes from. Two modes, same contract:
 *  - file: a local copy opened read-only (development with data/*.db); reopened when the file changes;
 *  - backup: every N minutes a consistent copy is downloaded from the existing server's
 *    GET /admin/backup (HTTP Basic, administrator credentials), checked (quick_check,
 *    user_version = 1, expected tables and columns), given its final name with an atomic rename
 *    and only then used. If a download fails the last valid copy stays in use. One download at a
 *    time for everyone: whoever asks while one is running waits for that one.
 * Why backup and not the live file: a SQLite database in WAL mode written by another process
 * cannot be read reliably from a read-only mount (readers need the -shm file and write locks).
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Dataset } from "@bridge/core/datasets";
import type { DataConfig } from "./config";
import type { Logger } from "./log";
import { checkDataDb, openDataFile } from "./sqlite";

export interface DataSnapshot {
  db: DatabaseSync;
  /** changes with every new copy (caches compare it) */
  version: number;
  /** when this copy was taken (ms) */
  takenAt: number;
}

export interface DataStatus {
  mode: "file" | "backup";
  /** when the copy in use was taken, null if there is none yet */
  takenAt: number | null;
  version: number;
  lastAttemptAt: number | null;
  /** the last failure, kept until a later success */
  lastError: string | null;
  refreshing: boolean;
}

export interface RefreshResult {
  /** a new copy is in use */
  updated: boolean;
  error?: string;
}

export interface DataSource {
  /** the copy in use; throws NoDataError when there is none yet */
  current(): DataSnapshot;
  /** gets a newer copy; with ifOlderThanMs only when the one in use is older than that */
  refresh(opts?: { ifOlderThanMs?: number }): Promise<RefreshResult>;
  status(): DataStatus;
  start(): Promise<void>;
  close(): void;
}

export class NoDataError extends Error {
  constructor() {
    super("I dati non sono ancora disponibili");
  }
}

let versions = 0;

abstract class BaseSource implements DataSource {
  protected snapshot: DataSnapshot | null = null;
  protected lastAttemptAt: number | null = null;
  protected lastError: string | null = null;
  private inflight: Promise<RefreshResult> | null = null;
  private retired = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    protected ds: Dataset,
    protected log: Logger,
    protected now: () => number,
  ) {}

  abstract readonly mode: "file" | "backup";
  protected abstract fetchNewer(): Promise<RefreshResult>;
  abstract start(): Promise<void>;

  current() {
    if (!this.snapshot) throw new NoDataError();
    return this.snapshot;
  }

  refresh(opts: { ifOlderThanMs?: number } = {}): Promise<RefreshResult> {
    if (this.inflight) return this.inflight;
    if (opts.ifOlderThanMs != null && this.snapshot && this.now() - this.snapshot.takenAt < opts.ifOlderThanMs) return Promise.resolve({ updated: false });
    this.inflight = this.fetchNewer().finally(() => (this.inflight = null));
    return this.inflight;
  }

  status(): DataStatus {
    return { mode: this.mode, takenAt: this.snapshot?.takenAt ?? null, version: this.snapshot?.version ?? 0, lastAttemptAt: this.lastAttemptAt, lastError: this.lastError, refreshing: !!this.inflight };
  }

  /** opens and checks a copy; throws DataFileError */
  protected openChecked(path: string) {
    const db = openDataFile(path);
    try {
      checkDataDb(db, this.ds);
    } catch (e) {
      db.close();
      throw e;
    }
    return db;
  }

  /** puts a new copy in use; the old connection is closed a minute later (requests still reading it) */
  protected use(db: DatabaseSync, takenAt: number) {
    const old = this.snapshot;
    this.snapshot = { db, version: ++versions, takenAt };
    if (old) {
      const t = setTimeout(() => {
        this.retired.delete(t);
        old.db.close();
      }, 60_000);
      t.unref?.();
      this.retired.add(t);
    }
  }

  protected failed(e: unknown): RefreshResult {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.log.warn("Aggiornamento dei dati non riuscito: resta in uso la copia precedente", { error: this.lastError });
    return { updated: false, error: this.lastError };
  }

  close() {
    for (const t of this.retired) clearTimeout(t);
    this.retired.clear();
    try {
      this.snapshot?.db.close();
    } catch {
      /* already closed */
    }
    this.snapshot = null;
  }
}

/** A local file opened read-only; reopened when its size or modification time changes. */
export class FileDataSource extends BaseSource {
  readonly mode = "file" as const;
  private stamp = "";

  constructor(
    private file: string,
    ds: Dataset,
    log: Logger,
    now = Date.now,
  ) {
    super(ds, log, now);
  }

  async start() {
    const r = await this.refresh();
    if (r.error) throw new Error(r.error);
  }

  protected async fetchNewer(): Promise<RefreshResult> {
    this.lastAttemptAt = this.now();
    try {
      const st = statSync(this.file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (stamp === this.stamp && this.snapshot) return { updated: false };
      const db = this.openChecked(this.file);
      this.stamp = stamp;
      this.use(db, st.mtimeMs);
      this.lastError = null;
      this.log.info("Dati aperti in sola lettura", { file: this.file, version: this.snapshot!.version });
      return { updated: true };
    } catch (e) {
      return this.failed(e);
    }
  }
}

export interface BackupOptions {
  fetch?: typeof fetch;
}

/** Periodic consistent copies from the existing server's GET /admin/backup. */
export class BackupDataSource extends BaseSource {
  readonly mode = "backup" as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetchImpl: typeof fetch;
  private file: string | null = null;

  constructor(
    private cfg: Extract<DataConfig, { mode: "backup" }>,
    ds: Dataset,
    log: Logger,
    now = Date.now,
    opts: BackupOptions = {},
  ) {
    super(ds, log, now);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private copies() {
    return readdirSync(this.cfg.dir)
      .filter((f) => f.startsWith(`${this.ds.app}-`) && f.endsWith(".db"))
      .sort()
      .reverse();
  }

  /** Uses the newest valid copy already on disk, then refreshes now and every intervalMin minutes. */
  async start() {
    mkdirSync(this.cfg.dir, { recursive: true });
    for (const f of readdirSync(this.cfg.dir)) if (f.endsWith(".tmp")) rmSync(join(this.cfg.dir, f), { force: true });
    for (const f of this.copies()) {
      const path = join(this.cfg.dir, f);
      try {
        this.use(this.openChecked(path), statSync(path).mtimeMs);
        this.file = path;
        this.log.info("Copia dei dati ripresa dal disco", { file: f });
        break;
      } catch (e) {
        this.log.warn("Copia dei dati sul disco non valida, ignorata", { file: f, error: (e as Error).message });
      }
    }
    this.timer = setInterval(() => void this.refresh(), this.cfg.intervalMin * 60_000);
    this.timer.unref?.();
    void this.refresh({ ifOlderThanMs: this.cfg.intervalMin * 60_000 });
  }

  protected async fetchNewer(): Promise<RefreshResult> {
    const started = this.now();
    this.lastAttemptAt = started;
    const tmp = join(this.cfg.dir, `.download-${started}-${randomBytes(4).toString("hex")}.tmp`);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutSec * 1000);
    try {
      const auth = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
      const res = await this.fetchImpl(this.cfg.url, { headers: { authorization: `Basic ${auth}` }, signal: ctrl.signal, redirect: "error" });
      if (!res.ok || !res.body) throw new Error(`Il server dei dati ha risposto ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
      await gunzipIfNeeded(tmp);
      // check before using it: a bad copy never replaces a good one
      this.openChecked(tmp).close();
      const name = `${this.ds.app}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.db`;
      const path = join(this.cfg.dir, name);
      renameSync(tmp, path);
      this.use(this.openChecked(path), started);
      const previous = this.file;
      this.file = path;
      this.lastError = null;
      this.log.info("Nuova copia dei dati in uso", { file: name, version: this.snapshot!.version, seconds: (this.now() - started) / 1000 });
      this.cleanup(previous);
      return { updated: true };
    } catch (e) {
      rmSync(tmp, { force: true });
      return this.failed(ctrl.signal.aborted ? new Error(`Lo scaricamento ha superato ${this.cfg.timeoutSec} s`) : e);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** keeps the copy in use and the previous one, removes older copies */
  private cleanup(previous: string | null) {
    for (const f of this.copies()) {
      const path = join(this.cfg.dir, f);
      if (path === this.file || path === previous) continue;
      try {
        rmSync(path, { force: true });
      } catch {
        /* still open on Windows: removed next time */
      }
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    super.close();
  }
}

/** the backup may come gzip-compressed as a file (Content-Encoding is already handled by fetch) */
async function gunzipIfNeeded(path: string) {
  const fh = await open(path, "r");
  const head = Buffer.alloc(2);
  await fh.read(head, 0, 2, 0);
  await fh.close();
  if (head[0] !== 0x1f || head[1] !== 0x8b) return;
  const out = `${path}.gunzip`;
  await pipeline(createReadStream(path), createGunzip(), createWriteStream(out));
  renameSync(out, path);
}

export function createDataSource(cfg: DataConfig, ds: Dataset, log: Logger, opts: BackupOptions & { now?: () => number } = {}): DataSource {
  return cfg.mode === "file" ? new FileDataSource(cfg.file, ds, log, opts.now) : new BackupDataSource(cfg, ds, log, opts.now, opts);
}

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DATASETS } from "@bridge/core/datasets";
import type { DataConfig } from "../src/config";
import { BackupDataSource, FileDataSource } from "../src/data-source";
import { createLogger } from "../src/log";
import { executor } from "../src/sqlite";
import { syntheticDb, tempDir } from "./helpers";

const dir = tempDir();
const ds = DATASETS.vitabridge;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const quietLog = (lines: string[] = []) => createLogger({ sink: (l) => lines.push(l), secrets: ["segreta-del-backup"] });

describe("file mode", () => {
  it("opens the database read-only: writes are refused, the file and its folder are not touched", async () => {
    const file = join(dir, "file-mode.db");
    copyFileSync(syntheticDb("vitabridge", dir), file);
    const before = sha(file);
    const src = new FileDataSource(file, ds, quietLog());
    await src.start();
    const db = src.current().db;
    expect(() => db.exec("CREATE TABLE x (a)")).toThrow(/readonly/);
    expect(() => db.prepare("DELETE FROM participant").run()).toThrow(/readonly/);
    await expect(executor(db).run("UPDATE device SET name = 'x'")).rejects.toThrow(/readonly/);
    expect((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
    // a WAL database opened read-only would create -wal and -shm files: immutable=1 avoids it
    expect(readdirSync(dir).filter((f) => f.startsWith("file-mode.db"))).toEqual(["file-mode.db"]);
    src.close();
    expect(sha(file)).toBe(before);
  });

  it("reopens the file when it changes and refuses one with a non-empty -wal next to it", async () => {
    const file = join(dir, "file-mode-2.db");
    copyFileSync(syntheticDb("vitabridge", dir), file);
    const src = new FileDataSource(file, ds, quietLog());
    await src.start();
    const v1 = src.current().version;
    expect((await src.refresh()).updated).toBe(false);
    // a new copy put in place (here: a newer modification time; Windows cannot replace an open file)
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await src.refresh()).updated).toBe(true);
    expect(src.current().version).toBeGreaterThan(v1);
    src.close();

    writeFileSync(`${file}-wal`, "x");
    await expect(new FileDataSource(file, ds, quietLog()).start()).rejects.toThrow(/-wal non vuoto/);
  });
});

/** a fake GET /admin/backup: answers with whatever `serve` returns and counts the calls */
function fakeServer(serve: () => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return serve();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const backupCfg = (name: string): Extract<DataConfig, { mode: "backup" }> => ({
  mode: "backup",
  url: "https://server-studio.example.org/admin/backup",
  username: "amministratore",
  password: "segreta-del-backup",
  dir: join(dir, name),
  intervalMin: 60,
  minAgeMin: 5,
  timeoutSec: 30,
});

describe("backup mode", () => {
  const good = () => new Response(readFileSync(syntheticDb("vitabridge", dir)));

  it("downloads with HTTP Basic, checks the copy and uses it; one download at a time for everyone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const srv = fakeServer(async () => {
      await gate;
      return good();
    });
    const cfg = backupCfg("b1");
    const src = new BackupDataSource(cfg, ds, quietLog(), Date.now, { fetch: srv.fetchImpl });
    await src.start(); // nothing on disk yet: starts a download in the background
    const many = [src.refresh(), src.refresh(), src.refresh({ ifOlderThanMs: 0 })];
    expect(src.status().refreshing).toBe(true);
    release();
    await Promise.all(many);
    expect(srv.calls.length).toBe(1);
    expect(srv.calls[0].auth).toBe(`Basic ${Buffer.from("amministratore:segreta-del-backup").toString("base64")}`);
    expect(src.status()).toMatchObject({ mode: "backup", lastError: null, refreshing: false });
    expect(src.current().db.prepare("SELECT count(*) AS n FROM participant").get()).toEqual({ n: 8 });
    // «Sincronizza» within 5 minutes: no new download
    expect((await src.refresh({ ifOlderThanMs: cfg.minAgeMin * 60_000 })).updated).toBe(false);
    expect(srv.calls.length).toBe(1);
    expect(readdirSync(cfg.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    src.close();
  });

  it("keeps the last valid copy when a download fails or is not a valid database", async () => {
    let answer: () => Response = good;
    const lines: string[] = [];
    const srv = fakeServer(() => answer());
    const cfg = backupCfg("b2");
    const src = new BackupDataSource(cfg, ds, quietLog(lines), Date.now, { fetch: srv.fetchImpl });
    await src.start();
    await src.refresh();
    const v = src.current().version;

    const wrongVersion = join(dir, "wrong-version.db");
    copyFileSync(syntheticDb("vitabridge", dir), wrongVersion);
    const w = new DatabaseSync(wrongVersion);
    w.exec("PRAGMA user_version = 2");
    w.close();
    const missingTable = join(dir, "missing-table.db");
    copyFileSync(syntheticDb("vitabridge", dir), missingTable);
    const m = new DatabaseSync(missingTable);
    m.exec("DROP TABLE GARMIN_STRESS_SAMPLE");
    m.close();
    const truncated = readFileSync(syntheticDb("vitabridge", dir)).subarray(0, 50_000);

    const bad: [string, () => Response, RegExp][] = [
      ["server error", () => new Response("errore", { status: 500 }), /500/],
      ["not a database", () => new Response("<html>login</html>"), /./],
      ["truncated", () => new Response(truncated), /./],
      ["user_version 2", () => new Response(readFileSync(wrongVersion)), /Versione dello schema/],
      ["missing table", () => new Response(readFileSync(missingTable)), /GARMIN_STRESS_SAMPLE/],
    ];
    for (const [, serve, error] of bad) {
      answer = serve;
      const r = await src.refresh();
      expect(r.updated).toBe(false);
      expect(r.error).toMatch(error);
      expect(src.status().lastError).toMatch(error);
      expect(src.current().version).toBe(v);
      expect(src.current().db.prepare("SELECT count(*) AS n FROM participant").get()).toEqual({ n: 8 });
    }
    expect(readdirSync(cfg.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // the credentials never reach the log
    const all = lines.join("\n");
    expect(all).not.toContain("segreta-del-backup");
    expect(all).not.toContain(Buffer.from("amministratore:segreta-del-backup").toString("base64"));

    // a gzip-compressed backup is fine; afterwards only the copy in use and the previous one stay
    answer = () => new Response(gzipSync(readFileSync(syntheticDb("vitabridge", dir))));
    expect((await src.refresh()).updated).toBe(true);
    answer = good;
    await src.refresh();
    expect(src.status().lastError).toBeNull();
    expect(readdirSync(cfg.dir).filter((f) => f.endsWith(".db")).length).toBeLessThanOrEqual(3); // one may still be open on Windows
    src.close();
  });

  it("starts from the newest valid copy on disk when the server does not answer", async () => {
    const cfg = backupCfg("b3");
    const first = new BackupDataSource(cfg, ds, quietLog(), Date.now, { fetch: fakeServer(good).fetchImpl });
    await first.start();
    await first.refresh();
    first.close();
    const down = fakeServer(() => {
      throw new Error("connessione rifiutata");
    });
    const second = new BackupDataSource(cfg, ds, quietLog(), Date.now, { fetch: down.fetchImpl });
    await second.start();
    expect(second.current().db.prepare("SELECT count(*) AS n FROM participant").get()).toEqual({ n: 8 });
    const r = await second.refresh();
    expect(r.error).toMatch(/connessione rifiutata/);
    expect(second.current().db.prepare("SELECT count(*) AS n FROM participant").get()).toEqual({ n: 8 });
    second.close();
    expect(existsSync(cfg.dir)).toBe(true);
  });
});

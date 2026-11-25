/**
 * An account names its participant by id AND code (participant.name), and belongs to one data
 * source: accounts made on one database never read another one, an id that now belongs to someone
 * else gives no data, only an administrator relinks an account to its code's new id, and the old
 * accounts without a code must be recreated. Everything new is written in the accounts database:
 * the data copies are only read.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defaultGarminParticipants, writeGarminDb } from "@bridge/synth/garmin-db";
import { runAdminCommand } from "../src/admin-cli";
import { hashPassword } from "../src/auth/passwords";
import { MIGRATIONS } from "../src/auth/store";
import { loadAuthConfig } from "../src/config";
import { ADMIN, NOW, participantClients, syntheticDb, tempDir, testServer, type Client, type TestServer } from "./helpers";

const dir = tempDir();
const PASSWORD = "Nuova-password-SYN-G01"; // participantClients' password for SYN-G01

/** the default participants in reverse order: SYN-G01 gets the last id, id 1 is SYN-G08 */
const reordered = (() => {
  const path = join(dir, "reordered.db");
  writeGarminDb(path, { now: NOW, participants: defaultGarminParticipants(5).reverse() });
  return path;
})();
/** without SYN-G01: its id 1 is SYN-G02's, its code is gone */
const withoutG01 = (() => {
  const path = join(dir, "without-g01.db");
  writeGarminDb(path, { now: NOW, participants: defaultGarminParticipants(5).filter((p) => p.code !== "SYN-G01") });
  return path;
})();
const idOf = (file: string, code: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM participant WHERE name = ?").get(code) as { id: number }).id;
  } finally {
    db.close();
  }
};

/** npm run admin:accept-source for an accounts database and a data file */
async function acceptSource(authDb: string, dataFile: string) {
  const out: string[] = [];
  // the test server's clock, so that the audit log is in the order things happened
  const code = await runAdminCommand(["accept-source"], { AUTH_DB: authDb, DATA_FILE: dataFile }, dir, { out: (l) => out.push(l), err: (l) => out.push(l) }, () => NOW.getTime());
  return { code, out };
}

async function adminOf(s: TestServer) {
  const a = s.client();
  await a.login(ADMIN.username, ADMIN.password);
  return a;
}

type AdminAccount = { id: number; username: string; participantId: number; participantCode: string | null; linkState: string; problem: string | null; relinkTo?: number };
const listOf = (a: Client) => a.get<{ participants: { id: number; code: string; account: AdminAccount | null }[]; orphanAccounts: AdminAccount[] }>("/api/admin/participants");
const auditOf = async (a: Client) =>
  (await a.get<{ entries: { action: string; actorUsername: string; targetUsername: string | null; participantCode: string | null; detail: string | null }[] }>("/api/admin/audit")).body.entries;

/** every data route a participant uses, all refused */
async function expectNoData(c: Client, code: string) {
  for (const path of ["/api/data/tables", "/api/data/devices", "/api/data/counts", "/api/data/table/GARMIN_ACTIVITY_SAMPLE?device=1", `/api/compare/daily?metric=steps&from=${Math.floor(NOW.getTime() / 1000) - 86400 * 7}&to=${Math.floor(NOW.getTime() / 1000)}`]) {
    const r = await c.get(path);
    expect(r.status, path).toBe(403);
    expect(r.body, path).toMatchObject({ code });
    expect(r.text, path).not.toMatch(/rows|counts|USER_ID|median/);
  }
}

describe("accounts and data sources", () => {
  it("an account made on one database: another source is refused at startup; once accepted, no data until an administrator relinks the code", async () => {
    const authDb = join(dir, "auth-relink.db");
    const a = await testServer({ dir, dataFile: syntheticDb("vitabridge", dir), authDb });
    const { participants } = await participantClients(a, ["SYN-G01"]);
    expect(participants.get("SYN-G01")!.participantId).toBe(1);

    // the same accounts on other data: refused, with the way out
    await expect(testServer({ dir, dataFile: reordered, authDb })).rejects.toThrow(/creato per un'altra sorgente dati.*admin:accept-source/s);
    const accepted = await acceptSource(authDb, reordered);
    expect(accepted.code).toBe(0);
    const s = await testServer({ dir, dataFile: reordered, authDb });

    // id 1 is now SYN-G08: nothing of theirs, nothing at all
    const me = s.client();
    const login = await me.login("syn-g01", PASSWORD);
    expect(login.body.account).toMatchObject({ participantId: 1, participantCode: "SYN-G01", link: "review" });
    await expectNoData(me, "account_review");
    expect((await me.get("/api/data/counts")).body).toMatchObject({ error: expect.stringMatching(/da verificare/) });

    // the administrator sees it, with «ricollega a SYN-G01» (its new id), and the audit log says so once
    const admin = await adminOf(s);
    const newId = idOf(reordered, "SYN-G01");
    expect(newId).not.toBe(1);
    const row = (await listOf(admin)).body.participants.find((p) => p.code === "SYN-G01")!;
    expect(row.id).toBe(newId);
    expect(row.account).toMatchObject({ username: "syn-g01", participantId: 1, linkState: "review", problem: "relink", relinkTo: newId });
    expect((await listOf(admin)).body.participants.find((p) => p.id === 1)!.account).toBeNull(); // not shown next to SYN-G08
    expect((await admin.get<{ accounts: { review: number } }>("/api/admin/status")).body.accounts.review).toBe(1);
    const audit = await auditOf(admin);
    expect(audit.filter((e) => e.action === "account_flagged")).toHaveLength(1);
    expect(audit.find((e) => e.action === "account_flagged")!.detail).toMatch(new RegExp(`SYN-G01.*numero ${newId}`));
    expect(audit.find((e) => e.action === "source_accepted")).toMatchObject({ actorUsername: expect.stringMatching(/^cli:/), detail: expect.stringMatching(/vitabridge-data\.db → .*reordered\.db/) });

    // relinked by a click, only to the code's own new id
    const accountId = row.account!.id;
    expect((await admin.post(`/api/admin/accounts/${accountId}/relink`, { participantId: 1, code: "SYN-G08" })).status).toBe(409);
    expect((await admin.post(`/api/admin/accounts/${accountId}/relink`, { participantId: 1, code: "SYN-G01" })).status).toBe(409);
    const relinked = await admin.post<{ account: AdminAccount }>(`/api/admin/accounts/${accountId}/relink`, { participantId: newId, code: "SYN-G01" });
    expect(relinked.status).toBe(200);
    expect(relinked.body.account).toMatchObject({ participantId: newId, linkState: "ok", problem: null });
    expect((await auditOf(admin))[0]).toMatchObject({ action: "account_relinked", targetUsername: "syn-g01", participantCode: "SYN-G01", detail: `codice SYN-G01: numero 1 → ${newId}` });
    // the old session is over; a new one has SYN-G01's rows, only theirs
    expect((await me.get("/api/data/counts")).status).toBe(401);
    expect((await me.login("syn-g01", PASSWORD)).body.account).toMatchObject({ participantId: newId, link: "ok" });
    const rows = await me.get<{ rows: unknown[][]; columns: string[] }>("/api/data/table/GARMIN_ACTIVITY_SAMPLE?limit=50000");
    expect(rows.status).toBe(200);
    const u = rows.body.columns.indexOf("USER_ID");
    expect(rows.body.rows.length).toBeGreaterThan(100);
    expect(new Set(rows.body.rows.map((r) => r[u]))).toEqual(new Set([newId]));
  });

  it("same id, another code, and the code gone: blocked, and nothing to relink", async () => {
    const authDb = join(dir, "auth-missing.db");
    const a = await testServer({ dir, dataFile: syntheticDb("vitabridge", dir), authDb });
    await participantClients(a, ["SYN-G01"]);
    expect((await acceptSource(authDb, withoutG01)).code).toBe(0);
    const s = await testServer({ dir, dataFile: withoutG01, authDb });
    const me = s.client();
    expect((await me.login("syn-g01", PASSWORD)).body.account).toMatchObject({ participantId: 1, link: "review" });
    await expectNoData(me, "account_review");

    const admin = await adminOf(s);
    const list = (await listOf(admin)).body;
    // id 1 is SYN-G02 now, without an account; the blocked one is apart
    expect(list.participants.find((p) => p.id === 1)).toMatchObject({ code: "SYN-G02", account: null });
    const blocked = list.orphanAccounts.find((x) => x.username === "syn-g01")!;
    expect(blocked).toMatchObject({ problem: "missing", linkState: "review" });
    expect(blocked.relinkTo).toBeUndefined();
    const r = await admin.post(`/api/admin/accounts/${blocked.id}/relink`, { participantId: 1, code: "SYN-G02" });
    expect(r.status).toBe(409);
    expect((await auditOf(admin)).find((e) => e.action === "account_flagged")!.detail).toMatch(/non è più nei dati/);
  });

  it("the same data moved elsewhere: accepted, and the accounts whose id and code match are active again by themselves", async () => {
    const authDb = join(dir, "auth-moved.db");
    const original = syntheticDb("vitabridge", dir);
    const a = await testServer({ dir, dataFile: original, authDb });
    await participantClients(a, ["SYN-G01"]);
    // first on other data (flagged), then the original data in another folder
    await acceptSource(authDb, reordered);
    const other = await testServer({ dir, dataFile: reordered, authDb });
    expect((await other.client().login("syn-g01", PASSWORD)).body.account).toMatchObject({ link: "review" });
    const moved = join(dir, "moved-copy.db");
    copyFileSync(original, moved);
    await expect(testServer({ dir, dataFile: moved, authDb })).rejects.toThrow(/altra sorgente/);
    const accepted = await acceptSource(authDb, moved);
    expect(accepted.out.join("\n")).toMatch(/tornano attivi da soli/);
    const s = await testServer({ dir, dataFile: moved, authDb });
    const me = s.client();
    expect((await me.login("syn-g01", PASSWORD)).body.account).toMatchObject({ participantId: 1, link: "ok" });
    expect((await me.get("/api/data/counts")).status).toBe(200);
    const audit = await auditOf(await adminOf(s));
    // most recent first: restored by itself after the source was accepted, flagged on the other data
    expect(audit.map((e) => e.action).filter((x) => x !== "account_created")).toEqual(["account_restored", "source_accepted", "account_flagged", "source_accepted"]);
    // accepting the source in use again changes nothing
    expect((await acceptSource(authDb, moved)).out[0]).toMatch(/già legato/);
  });

  it("an account is created only for the id AND code the administrator saw", async () => {
    const s = await testServer({ dir });
    const admin = await adminOf(s);
    const people = (await listOf(admin)).body.participants;
    const g2 = people.find((p) => p.code === "SYN-G02")!;
    expect((await admin.post("/api/admin/accounts", { participantId: g2.id })).status).toBe(400);
    expect((await admin.post("/api/admin/accounts", { participantId: g2.id, code: "SYN-G03" })).body).toMatchObject({ code: "participant_changed" });
    expect((await admin.post("/api/admin/accounts", { participantId: 999, code: "SYN-G02" })).status).toBe(404);
    const ok = await admin.post<{ account: AdminAccount }>("/api/admin/accounts", { participantId: g2.id, code: "SYN-G02" });
    expect(ok.body.account).toMatchObject({ participantId: g2.id, participantCode: "SYN-G02", linkState: "ok" });
    // one account per code
    expect((await admin.post("/api/admin/accounts", { participantId: g2.id, code: "SYN-G02", username: "altro-nome" })).body).toMatchObject({ code: "exists" });
  });

  it("accounts made before the codes were kept are «da ricreare»: no data, never relinked; their sessions and settings survive the update", async () => {
    // an accounts database of the previous version, with a participant account (id only)
    const authDb = join(dir, "auth-old.db");
    const old = new DatabaseSync(authDb);
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.exec("PRAGMA user_version = 2");
    const hash = await hashPassword("Vecchia-password-1");
    old.prepare("INSERT INTO account (username, password_hash, role, participant_id, must_change_password, created_at) VALUES ('syn-g01', ?, 'participant', 1, 0, 1)").run(hash);
    old.prepare("INSERT INTO account_settings (account_id, goals, updated_at) VALUES (1, '{}', 1)").run();
    old.prepare("INSERT INTO session (token_hash, account_id, csrf_token, created_at, last_seen_at, expires_at) VALUES ('h', 1, 'c', 1, 1, 9999999999999)").run();
    old.prepare("INSERT INTO audit_log (at, actor_username, action, target_username, participant_id) VALUES (1, 'admin', 'account_created', 'syn-g01', 1)").run();
    old.close();

    const s = await testServer({ dir, dataFile: syntheticDb("vitabridge", dir), authDb });
    expect(s.auth.db.prepare("SELECT (SELECT count(*) FROM account_settings) AS settings, (SELECT count(*) FROM session) AS sessions, (SELECT count(*) FROM audit_log) AS audit").get()).toEqual({
      settings: 1,
      sessions: 1,
      audit: 1,
    });
    const me = s.client();
    const login = await me.login("syn-g01", "Vecchia-password-1");
    expect(login.body.account).toMatchObject({ participantId: 1, participantCode: null, link: "recreate" });
    await expectNoData(me, "account_recreate");
    expect((await me.get("/api/data/counts")).body).toMatchObject({ error: expect.stringMatching(/va ricreato/) });
    const admin = await adminOf(s);
    const list = (await listOf(admin)).body;
    expect(list.participants.find((p) => p.code === "SYN-G01")!.account).toBeNull();
    const stale = list.orphanAccounts.find((x) => x.username === "syn-g01")!;
    expect(stale).toMatchObject({ problem: "recreate", linkState: "recreate" });
    expect((await admin.post(`/api/admin/accounts/${stale.id}/relink`, { participantId: 1, code: "SYN-G01" })).status).toBe(409);
  });

  it("without AUTH_DB the accounts file is named after the data: synthetic and real data never share accounts", () => {
    const synth = loadAuthConfig({ DATA_FILE: "data/synthetic-garmin.db" }, "/srv");
    const real = loadAuthConfig({ DATA_FILE: "data/gadgetbridge.db" }, "/srv");
    expect(synth.authDb.replace(/\\/g, "/")).toMatch(/\/srv\/auth\/vitabridge-synthetic-garmin-auth\.db$/);
    expect(real.authDb.replace(/\\/g, "/")).toMatch(/\/srv\/auth\/vitabridge-gadgetbridge-auth\.db$/);
    expect(synth.source.fingerprint).not.toBe(real.source.fingerprint);
    // the same file: the same source, however it is written
    expect(loadAuthConfig({ DATA_FILE: "/srv/data/../data/synthetic-garmin.db" }, "/elsewhere").source.fingerprint).toBe(synth.source.fingerprint);
    expect(loadAuthConfig({ DATA_FILE: "data/x.db", AUTH_DB: "auth/scelto.db" }, "/srv").authDb.replace(/\\/g, "/")).toMatch(/\/srv\/auth\/scelto\.db$/);
    const backup = loadAuthConfig({ DATA_MODE: "backup", BACKUP_URL: "https://server.example.org/admin/backup" }, "/srv");
    expect(backup.authDb.replace(/\\/g, "/")).toMatch(/\/srv\/auth\/vitabridge-auth\.db$/);
  });
});

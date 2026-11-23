/**
 * A participant never gets another participant's rows, not even by mistake: every row of every
 * table and page has their USER_ID, and they get all of their rows and nothing else.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DATASETS, type AppId } from "@bridge/core/datasets";
import { participantClients, syntheticDb, tempDir, testServer, type Client } from "./helpers";

const dir = tempDir();

interface TableMeta {
  name: string;
  columns: string[];
  key: string[];
  blobs: string[];
}
interface Page {
  columns: string[];
  rows: unknown[][];
  next: string | null;
}

/** every row of a table, page after page (small pages: the cursor is exercised) */
async function download(c: Client, table: string, extra = "") {
  const rows: unknown[][] = [];
  let after: string | null = null;
  let columns: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const res: { status: number; body: Page } = await c.get<Page>(`/api/data/table/${table}?limit=700${after ? `&after=${after}` : ""}${extra}`);
    expect(res.status).toBe(200);
    columns = res.body.columns;
    rows.push(...res.body.rows);
    if (!res.body.next) return { columns, rows };
    after = res.body.next;
  }
  throw new Error("troppe pagine");
}

const CASES: { app: AppId; codes: string[] }[] = [
  { app: "vitabridge", codes: ["SYN-G01", "SYN-G04", "SYN-G06"] },
  { app: "heartbridge", codes: ["SYN-H01", "SYN-H02", "SYN-H05"] },
];

describe.each(CASES)("isolation between participants ($app)", ({ app, codes }) => {
  it("each participant downloads exactly their own rows of every table", async () => {
    const dataFile = syntheticDb(app, dir);
    const s = await testServer({ app, dir, dataFile });
    const { participants } = await participantClients(s, codes);
    const raw = new DatabaseSync(dataFile, { readOnly: true });
    const tables = (await participants.get(codes[0])!.client.get<{ tables: TableMeta[] }>("/api/data/tables")).body.tables;
    expect(tables.map((t) => t.name)).toEqual(DATASETS[app].dataTables.map((t) => t.name));
    let total = 0;
    for (const code of codes) {
      const { client, participantId } = participants.get(code)!;
      for (const t of tables) {
        const { columns, rows } = await download(client, t.name);
        const u = columns.indexOf("USER_ID");
        for (const r of rows) expect(r[u]).toBe(participantId);
        const inDb = (raw.prepare(`SELECT count(*) AS n FROM "${t.name}" WHERE USER_ID = ?`).get(participantId) as { n: number }).n;
        expect(rows.length).toBe(inDb);
        // no duplicates across pages
        const keys = new Set(rows.map((r) => JSON.stringify(t.key.map((k) => r[columns.indexOf(k)]))));
        expect(keys.size).toBe(rows.length);
        total += rows.length;
      }
      // only their own devices, and never the band's identifier
      const devices = (await client.get<{ devices: Record<string, unknown>[] }>("/api/data/devices")).body.devices;
      const own = raw.prepare("SELECT id FROM device WHERE participant_id = ? ORDER BY id").all(participantId) as { id: number }[];
      expect(devices.map((d) => d.id)).toEqual(own.map((d) => d.id));
      for (const d of devices) {
        expect(d).not.toHaveProperty("identifier");
        expect(d).not.toHaveProperty("hardware_id");
        expect(d).not.toHaveProperty("participant_id");
      }
    }
    expect(total).toBeGreaterThan(0);
    raw.close();
  });

  it("ignores any participant id in the request and refuses unknown tables", async () => {
    const s = await testServer({ app, dir, dataFile: syntheticDb(app, dir) });
    const { participants } = await participantClients(s, codes.slice(0, 2));
    const me = participants.get(codes[0])!;
    const other = participants.get(codes[1])!;
    const table = DATASETS[app].dataTables[1].name;
    const plain = await download(me.client, table);
    for (const param of ["user_id", "USER_ID", "participant_id", "participantId", "userId"]) {
      const forged = await download(me.client, table, `&${param}=${other.participantId}`);
      expect(forged.rows).toEqual(plain.rows);
    }
    // a forged header or body does not change who is asking either
    const viaHeader = await me.client.req<Page>("GET", `/api/data/table/${table}?limit=5`, undefined, { "x-user-id": String(other.participantId), "x-participant-id": String(other.participantId) });
    expect(viaHeader.body.rows).toEqual(plain.rows.slice(0, 5));
    const refresh = await me.client.post("/api/data/refresh", { participantId: other.participantId });
    expect(refresh.status).toBe(200);

    for (const bad of ["participant", "device", "collection_request", "upload_batch", "sqlite_master", `${table}%22%20OR%201%3D1`, "..%2Fadmin"]) {
      expect((await me.client.get(`/api/data/table/${bad}`)).status).toBe(404);
    }
    // a forged cursor is refused, it cannot reach another USER_ID
    expect((await me.client.get(`/api/data/table/${table}?after=${Buffer.from("[1]").toString("base64url")}`)).status).toBe(400);
    expect((await me.client.get(`/api/data/table/${table}?after=not-a-cursor`)).status).toBe(400);
    expect((await me.client.get(`/api/data/table/${table}?since=abc`)).status).toBe(400);
  });

  it("gives health data to participants only, and administration to administrators only", async () => {
    const s = await testServer({ app, dir, dataFile: syntheticDb(app, dir) });
    const { admin, participants } = await participantClients(s, codes.slice(0, 1));
    const p = participants.get(codes[0])!.client;
    const anon = s.client();
    const dataPaths = ["/api/data/tables", "/api/data/devices", `/api/data/table/${DATASETS[app].dataTables[0].name}`];
    for (const path of dataPaths) {
      expect((await admin.get(path)).status).toBe(403);
      expect((await anon.get(path)).status).toBe(401);
    }
    expect((await admin.post("/api/data/refresh")).status).toBe(403);
    for (const path of ["/api/admin/participants", "/api/admin/audit", "/api/admin/status"]) {
      expect((await p.get(path)).status).toBe(403);
      expect((await anon.get(path)).status).toBe(401);
    }
    expect((await p.post("/api/admin/accounts", { participantId: participants.get(codes[0])!.participantId })).status).toBe(403);
  });

  it("the administrator's list has codes, devices and dates, but no health data, keys or tokens", async () => {
    const dataFile = syntheticDb(app, dir);
    const s = await testServer({ app, dir, dataFile });
    const admin = s.client();
    await admin.login("admin", "Amministratore-2026!");
    const res = await admin.get<{ participants: { code: string; devices: Record<string, unknown>[]; lastUploadAt: number | null }[] }>("/api/admin/participants");
    const raw = new DatabaseSync(dataFile, { readOnly: true });
    const people = raw.prepare("SELECT name, api_key_hash FROM participant").all() as { name: string; api_key_hash: string }[];
    expect(res.body.participants.map((p) => p.code).sort()).toEqual(people.map((p) => p.name).sort());
    for (const p of people) expect(res.text).not.toContain(p.api_key_hash);
    for (const word of ["api_key_hash", "fcm_token", "birthday", "identifier", "hardware_id", "HEART_RATE", "STEPS", "ecg_data"]) expect(res.text).not.toContain(word);
    for (const p of res.body.participants) for (const d of p.devices) expect(Object.keys(d).sort()).toEqual([...DATASETS[app].deviceColumns].sort());
    raw.close();
  });
});

it("sends ECG traces as base64 of the same bytes", async () => {
  const dataFile = syntheticDb("heartbridge", dir);
  const s = await testServer({ app: "heartbridge", dir, dataFile });
  const { participants } = await participantClients(s, ["SYN-H01"]);
  const { client, participantId } = participants.get("SYN-H01")!;
  const res = await client.get<Page & { blobs: string[] }>("/api/data/table/ECG_MEASUREMENTS");
  expect(res.body.blobs).toEqual(["ecg_data"]);
  const raw = new DatabaseSync(dataFile, { readOnly: true });
  const first = raw.prepare("SELECT ecg_data FROM ECG_MEASUREMENTS WHERE USER_ID = ? ORDER BY DEVICE_ID, start_measure_ms LIMIT 1").get(participantId) as { ecg_data: Uint8Array };
  const i = res.body.columns.indexOf("ecg_data");
  expect(Buffer.from(res.body.rows[0][i] as string, "base64").equals(Buffer.from(first.ecg_data))).toBe(true);
  raw.close();
});

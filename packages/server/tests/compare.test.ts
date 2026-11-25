/**
 * The comparison with the other participants on the server: the same numbers as core's comparison
 * computed directly, the asking participant never among the others, nothing below the minimum,
 * only aggregates, the previous cache while a new one is built, the data copy never written.
 */
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DailyDistribution } from "@bridge/core/comparison/types";
import { DEFAULT_VALID_DAY_HOURS, setValidDayHours } from "@bridge/core/metrics";
import { ServerComparisonSource } from "@bridge/core/server/server-source";
import { addDays, startOfDay } from "@bridge/core/time-zone";
import { buildFacts, type BuildResult } from "../src/comparison/build";
import type { DataSource } from "../src/data-source";
import { executor } from "../src/sqlite";
import { ADMIN, NOW, participantClients, syntheticDb, tempDir, testServer, type Client } from "./helpers";

const dir = tempDir();
const today = startOfDay(NOW.getTime() / 1000);
const from = addDays(today, -14);
const to = addDays(today, 1);
const nowSec = () => Math.floor(NOW.getTime() / 1000);
// the 8 default participants (some without data) + 6 more: enough people on every recent day
const COHORT = 6;

/** core's comparison computed directly on a writable copy of the same database */
async function direct(file: string) {
  const copy = join(dir, `direct-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(file, copy);
  return ServerComparisonSource.open([executor(new DatabaseSync(copy))], nowSec);
}

const days = (c: Client, metric: string) => c.get<{ days: DailyDistribution[]; minParticipants: number }>(`/api/compare/daily?metric=${metric}&from=${from}&to=${to}`);

describe("comparison with the other participants", () => {
  let file: string;
  let me: Client;
  let pid: number;
  let admin: Client;
  let anon: Client;
  beforeAll(async () => {
    file = syntheticDb("vitabridge", dir, 3, COHORT);
    const s = await testServer({ dir, dataFile: file });
    const { admin: a, participants } = await participantClients(s, ["SYN-G01"]);
    me = participants.get("SYN-G01")!.client;
    pid = participants.get("SYN-G01")!.participantId;
    admin = a;
    anon = s.client();
  });
  afterEach(() => setValidDayHours(DEFAULT_VALID_DAY_HOURS));

  it("gives core's numbers, without the asking participant", async () => {
    const ref = await direct(file);
    for (const metric of ["steps", "sleep", "stress", "resting_hr"] as const) {
      const res = await days(me, metric);
      expect(res.status).toBe(200);
      expect(res.body.days).toEqual(await ref.dailyDistribution(metric, from, to, { excludeUserId: "SYN-G01" }));
      // with the asking participant the count is one more on the days they have data
      const all = await ref.dailyDistribution(metric, from, to);
      const mine = await ref.dailyDistribution(metric, from, to, { excludeUserId: "SYN-G01" });
      expect(all.some((d, i) => d.n === mine[i].n + 1)).toBe(true);
      expect(res.body.days.some((d) => d.median != null && d.mean != null)).toBe(true);
    }
    const weekly = await me.get<{ weeks: DailyDistribution[] }>(`/api/compare/weekly?metric=intensity&from=${from}&to=${to}`);
    expect(weekly.body.weeks).toEqual(await ref.weeklyDistribution("intensity", from, to, { excludeUserId: "SYN-G01" }));
    const standing = await me.get<{ standing: Awaited<ReturnType<typeof ref.standingOf>> }>(`/api/compare/standing?metric=steps&from=${from}&to=${to}`);
    expect(standing.body.standing).toEqual(await ref.standingOf("steps", from, to, "SYN-G01"));
    expect(standing.body.standing.mine.days).toBeGreaterThan(0);
  });

  it("only aggregates: no participant's values, codes or ids", async () => {
    for (const path of [`/api/compare/daily?metric=steps&from=${from}&to=${to}`, `/api/compare/weekly?metric=intensity&from=${from}&to=${to}`, `/api/compare/standing?metric=steps&from=${from}&to=${to}`]) {
      const res = await me.get(path);
      expect(res.text).not.toMatch(/SYN-|participant|USER_ID|"id"/);
    }
    const res = await days(me, "steps");
    for (const d of res.body.days) expect(Object.keys(d).sort()).toEqual(["day", "mean", "median", "n", "p25", "p75"]);
  });

  it("is for participants only, and checks what it is asked", async () => {
    expect((await days(admin, "steps")).status).toBe(403);
    expect((await days(anon, "steps")).status).toBe(401);
    expect((await days(me, "passwords")).status).toBe(400);
    expect((await me.get(`/api/compare/daily?metric=steps&from=${to}&to=${from}`)).status).toBe(400);
    expect((await me.get(`/api/compare/daily?metric=steps&from=${from}&to=${addDays(from, 500)}`)).status).toBe(400);
    expect((await me.get(`/api/compare/daily?metric=steps&from=abc&to=${to}`)).status).toBe(400);
    // participant id in the request: ignored (the asking participant comes from the session)
    const forged = await me.get<{ days: DailyDistribution[] }>(`/api/compare/daily?metric=steps&from=${from}&to=${to}&exclude=${pid + 1}&participantId=${pid + 1}`);
    expect(forged.body.days).toEqual((await days(me, "steps")).body.days);
  });

  it("the valid day rule (hours with heart rate) applies to the others too", async () => {
    // today at 12:00 has at most 12 hours with heart rate: a valid day with 12, not with 13
    const at12 = (await days(me, "steps")).body.days;
    setValidDayHours(13);
    const at13 = (await days(me, "steps")).body.days;
    const t = at12.length - 1; // today: the period [from, to) ends with it
    expect(at12[t].day).toBe(today);
    expect(at12[t].n).toBeGreaterThan(0);
    expect(at13[t].n).toBe(0);
    // a stricter rule never adds anyone, on any day
    at13.forEach((d, i) => expect(d.n).toBeLessThanOrEqual(at12[i].n));
    expect((await days(me, "sleep")).body.days.some((d) => d.median != null)).toBe(true); // sleep does not need it
  });

  it("nothing below COMPARE_MIN_PARTICIPANTS", async () => {
    const s = await testServer({ dir, dataFile: file, env: { COMPARE_MIN_PARTICIPANTS: "50" } });
    const { participants } = await participantClients(s, ["SYN-G02"]);
    const res = await days(participants.get("SYN-G02")!.client, "steps");
    expect(res.body.minParticipants).toBe(50);
    expect(res.body.days.every((d) => d.median == null && d.mean == null && d.p25 == null && d.n < 50)).toBe(true);
    await expect(testServer({ dir, dataFile: file, env: { COMPARE_MIN_PARTICIPANTS: "3" } })).rejects.toThrow(/COMPARE_MIN_PARTICIPANTS/);
  });
});

describe("the comparison cache", () => {
  it("answers from the previous cache while the new one is built, then swaps it", async () => {
    const file = syntheticDb("vitabridge", dir, 3, COHORT);
    let version = 1;
    const source: DataSource = {
      current: () => ({ db: new DatabaseSync(":memory:"), file, version, takenAt: NOW.getTime() }),
      refresh: async () => ({ updated: false }),
      status: () => ({ mode: "file", takenAt: NOW.getTime(), version, lastAttemptAt: null, lastError: null, refreshing: false }),
      start: async () => {},
      close: () => {},
    };
    // the second build waits for the test and gives everyone 0 steps... except the data it reads
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let builds = 0;
    const builder = async (f: string, app: "vitabridge" | "heartbridge", now: number): Promise<BuildResult> => {
      builds++;
      const r = await buildFacts(f, app, now);
      if (builds === 1) return r;
      await gate;
      return { ...r, people: r.people.map((p) => ({ ...p, facts: p.facts.map((x) => ({ ...x, steps: 1 })) })) };
    };
    const s = await testServer({ dir, data: source, builder });
    // the participants table of the data source is used by participantClients: give it the real copy
    const real = new DatabaseSync(file, { readOnly: true });
    source.current = () => ({ db: real, file, version, takenAt: NOW.getTime() });
    const { participants } = await participantClients(s, ["SYN-G01"]);
    const me = participants.get("SYN-G01")!.client;
    const first = (await days(me, "steps")).body.days;
    expect(first.some((d) => (d.median ?? 0) > 1)).toBe(true);

    version = 2; // a new copy of the data arrived
    const during = await days(me, "steps");
    expect(during.status).toBe(200);
    expect(during.body.days).toEqual(first); // the previous cache, not a wait nor an error
    expect(s.comparison.status()).toMatchObject({ version: 1, building: true });

    release();
    await s.comparison.ensure();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.comparison.status()).toMatchObject({ version: 2, building: false });
    const after = (await days(me, "steps")).body.days;
    expect(after.filter((d) => d.median != null).every((d) => d.median === 1)).toBe(true);
    real.close();
  });

  it("never writes the data copy: it is attached read-only and left byte for byte as it was", async () => {
    const file = join(dir, "untouched.db");
    copyFileSync(syntheticDb("vitabridge", dir, 3, COHORT), file);
    const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = sha();
    const r = await buildFacts(file, "vitabridge", nowSec());
    expect(r.stats.participants).toBe(8 + COHORT);
    expect(sha()).toBe(before);
    expect(readdirSync(dir).filter((f) => f.startsWith("untouched.db"))).toEqual(["untouched.db"]);
  });
});

it("an admin sees the cache's state, never its values", async () => {
  const s = await testServer({ dir, dataFile: syntheticDb("vitabridge", dir, 3, COHORT) });
  await s.comparison.ensure();
  const a = s.client();
  await a.login(ADMIN.username, ADMIN.password);
  const st = await a.get<{ comparison: { minParticipants: number; stats: { participants: number } } }>("/api/admin/status");
  expect(st.body.comparison).toMatchObject({ minParticipants: 5, stats: { participants: 8 + COHORT } });
  expect(st.text).not.toMatch(/median|SYN-/);
});

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
import { summarySentence, type ComparableStanding } from "@bridge/core/comparison/aggregate";
import { metricValue, weeksCovering } from "@bridge/core/comparison/daily-values";
import type { CompareMetric, DailyDistribution } from "@bridge/core/comparison/types";
import { DEFAULT_VALID_DAY_HOURS, setValidDayHours } from "@bridge/core/metrics";
import { ServerComparisonSource } from "@bridge/core/server/server-source";
import { addDays, startOfDay } from "@bridge/core/time-zone";
import { buildFacts, type BuildResult } from "../src/comparison/build";
import type { DataSource } from "../src/data-source";
import { executor } from "../src/sqlite";
import { writeGarminDb } from "@bridge/synth/garmin-db";
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

describe("which days can be compared", () => {
  const standingOf = (c: Client, metric: string, f: number, t: number) => c.get<{ standing: ComparableStanding }>(`/api/compare/standing?metric=${metric}&from=${f}&to=${t}`);

  it("with a cohort every day up to today has the comparison, sleep and SpO2 included; n = the others with data", async () => {
    const file = syntheticDb("vitabridge", dir, 3, COHORT);
    const s = await testServer({ dir, dataFile: file });
    const { participants } = await participantClients(s, ["SYN-G01"]);
    const me = participants.get("SYN-G01")!.client;
    const ref = await direct(file);
    const others = ref.people.filter((p) => p.key !== "SYN-G01");
    for (const metric of ["steps", "calories", "resting_hr", "stress", "body_battery", "respiration", "sleep", "spo2"] as const) {
      const res = (await days(me, metric)).body.days;
      res.forEach((d, i) => {
        // n is exactly the other participants with a value that day (valid day for day totals)
        const withValue = others.filter((p) => metricValue(metric, p.facts[p.days.indexOf(d.day)] ?? null) != null).length;
        expect(d.n, `${metric} ${i}`).toBe(withValue);
        expect(d.median, `${metric} ${i}`).not.toBeNull();
      });
    }
    // the cohort's personas: everyone sleeps, SpO2 for a part of them
    const cohort = ref.people.filter((p) => p.key.startsWith("SYN-C"));
    expect(cohort).toHaveLength(COHORT);
    const has = (m: CompareMetric) => cohort.filter((p) => p.facts.some((f) => metricValue(m, f) != null)).length;
    expect(has("sleep")).toBe(COHORT);
    expect(has("spo2")).toBeGreaterThan(0);
    expect(has("spo2")).toBeLessThan(COHORT);
    // every cohort member has a valid day on every day up to yesterday
    for (const p of cohort) for (let d = from; d < today; d = addDays(d, 1)) expect(metricValue("steps", p.facts[p.days.indexOf(d)] ?? null), p.key).not.toBeNull();
  });

  it("says when no other participant has data for a metric", async () => {
    // six participants, nobody but SYN-G01 with sleep
    const file = join(dir, "nobody-sleeps.db");
    const noSleep = ["GARMIN_SLEEP_STAGE_SAMPLE", "GARMIN_SLEEP_STATS_SAMPLE", "GARMIN_EVENT_SAMPLE"] as const;
    writeGarminDb(file, { now: NOW, participants: [{ code: "SYN-G01", seed: 101, days: 10 }, ...[1, 2, 3, 4, 5].map((k) => ({ code: `SYN-N0${k}`, seed: 200 + k, days: 10, omit: [...noSleep] }))] });
    const s = await testServer({ dir, dataFile: file });
    const { participants } = await participantClients(s, ["SYN-G01"]);
    const c = participants.get("SYN-G01")!.client;
    const f = addDays(today, -9);
    const res = (await c.get<{ days: DailyDistribution[] }>(`/api/compare/daily?metric=sleep&from=${f}&to=${to}`)).body.days;
    expect(res.every((d) => d.n === 0 && d.median == null)).toBe(true);
    const st = (await standingOf(c, "sleep", f, to)).body.standing;
    expect(st).toMatchObject({ noOthers: true, comparable: { count: 0, unit: "day" }, median: null, percentile: null });
    expect(st.mine.value).toBeNull(); // no comparable day: their own sleep is not judged
    expect(summarySentence({ metric: "sleep", span: "Novembre", standing: st, text: String, fmt: String })).toBe("Nessun altro partecipante ha dati sul sonno in questo periodo");
    // steps: the others have them
    expect((await standingOf(c, "steps", f, to)).body.standing).toMatchObject({ noOthers: false, comparable: { count: 9 } });
  });

  it("the summary uses only the days (weeks) where the others' distribution exists, for the participant too", async () => {
    // the default participants alone: on most days fewer than 5 others have data
    const file = syntheticDb("vitabridge", dir);
    const s = await testServer({ dir, dataFile: file });
    const { participants } = await participantClients(s, ["SYN-G01"]);
    const c = participants.get("SYN-G01")!.client;
    const f = addDays(today, -35);
    const daily = (await c.get<{ days: DailyDistribution[] }>(`/api/compare/daily?metric=steps&from=${f}&to=${to}`)).body.days;
    const comparable = daily.filter((d) => d.median != null && d.day < today).map((d) => d.day);
    expect(comparable.length).toBeGreaterThan(0);
    expect(comparable.length).toBeLessThan(daily.length - 1); // not all of them: that is the point
    const st = (await standingOf(c, "steps", f, to)).body.standing;
    expect(st.comparable).toEqual({ count: comparable.length, unit: "day" });
    const mine = (await direct(file)).people.find((p) => p.key === "SYN-G01")!;
    const values = comparable.map((d) => metricValue("steps", mine.facts[mine.days.indexOf(d)] ?? null)).filter((v): v is number => v != null);
    expect(st.mine.days).toBe(values.length);
    expect(st.mine.value).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 6);
    // weekly: the complete weeks where the weekly distribution exists
    const ws = weeksCovering(f, to);
    const wf = ws[0].start;
    const wt = ws[ws.length - 1].end;
    const weeks = (await c.get<{ weeks: DailyDistribution[] }>(`/api/compare/weekly?metric=intensity&from=${wf}&to=${wt}`)).body.weeks;
    const wst = (await standingOf(c, "intensity", wf, wt)).body.standing;
    expect(wst.comparable).toEqual({ count: weeks.filter((w) => w.median != null && addDays(w.day, 7) <= today).length, unit: "week" });
    expect(wst.comparable.count).toBeLessThan(weeks.length);
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

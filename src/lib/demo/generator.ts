/**
 * Generates realistic synthetic Garmin FIT files (monitoring, sleep, HRV, activities) for the demo
 * mode, and exposes the same simulated days as plain values (used by the demo comparison cohort).
 * Deterministic: a day depends only on (seed, day, persona), never on "now" or on other days.
 */
import { BaseType as B } from "../fit/decoder";
import { FitEncoder, toGarminTs } from "../fit/encoder";
import type { FakeFile } from "./fake-watch";

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fileId(e: FitEncoder, type: number, created: number, number: number) {
  e.write(0, [
    { num: 0, base: B.ENUM, value: type },
    { num: 1, base: B.UINT16, value: 1 }, // garmin
    { num: 2, base: B.UINT16, value: 3466 },
    { num: 3, base: B.UINT32Z, value: 3412345678 },
    { num: 4, base: B.UINT32, value: toGarminTs(created) },
    { num: 5, base: B.UINT16, value: number },
  ]);
}

/** How a simulated person lives. The demo band uses DEFAULT_PERSONA; the comparison cohort varies it. */
export interface Persona {
  /** lowest resting heart rate (0..6 bpm are added each day) */
  restingHr: number;
  /** multiplies the chance of walking in a given minute */
  activity: number;
  /** multiplies the steps of each walking minute */
  stepScale: number;
  /** seconds added to bedtime and to wake-up time */
  bedShift: number;
  wakeShift: number;
  /** daytime stress: base + random 0..spread */
  stressBase: number;
  stressSpread: number;
  hrvBase: number;
  respShift: number;
  spo2Base: number;
  /** how fast Body Battery recharges during sleep (1 = demo band) */
  recharge: number;
  /** weekdays (0 = Sunday) with an evening run / a late-morning walk */
  runDays: number[];
  walkDays: number[];
}

export const DEFAULT_PERSONA: Persona = {
  restingHr: 55,
  activity: 1,
  stepScale: 1,
  bedShift: 0,
  wakeShift: 0,
  stressBase: 20,
  stressSpread: 45,
  hrvBase: 38,
  respShift: 0,
  spo2Base: 93,
  recharge: 1,
  runDays: [2, 4, 6],
  walkDays: [0, 3],
};

export interface Night {
  start: number;
  end: number;
  /** stage of each minute starting at t (1 awake, 2 light, 3 deep, 4 REM) */
  stages: { t: number; stage: number }[];
}

export interface PlannedWorkout {
  start: number;
  duration: number;
  sport: number;
  name: string;
}

/** What the band writes in the monitoring file, in order. */
export type MonitorEvent =
  | { kind: "minute"; t: number; type: number; intensity: number; hr: number; walkSteps: number; walkDist: number; runSteps: number; runDist: number; cal: number }
  | { kind: "stress"; t: number; stress: number; energy: number }
  /** respiration in hundredths (FIT scale 100) */
  | { kind: "resp"; t: number; raw: number }
  | { kind: "spo2"; t: number; value: number };

export interface HrvNight {
  values: { t: number; v: number }[];
  base: number;
  avg: number;
  max: number;
}

export interface DemoDay {
  day: number;
  dayEnd: number;
  /** the night ending this morning (`slept` = false when it has not started yet) */
  night: Night;
  slept: boolean;
  hrv: HrvNight | null;
  events: MonitorEvent[];
  restingHr: number;
  /** day totals of the band's counters */
  steps: number;
  calories: number;
  workouts: PlannedWorkout[];
}

/** Independent generators per day and per part: the data of a minute never depends on "now". */
export const dayRandom = (seed: number, day: number) => {
  const dayKey = Math.round(day / 3600);
  return (salt: number) => rng(seed * 100003 + dayKey * 31 + salt);
};

/** Simulates one local day [day, nextDay) up to `nowTs`; null if the day has not started. */
export function simulateDay(day: number, nextDay: number, nowTs: number, seed: number, p: Persona = DEFAULT_PERSONA): DemoDay | null {
  const dayEnd = Math.min(nextDay, nowTs);
  if (dayEnd <= day) return null;
  const R = dayRandom(seed, day);
  let rand = R(1);

  // --- sleep from previous evening (~23:00) to ~07:00
  const bed = day - 3600 + Math.round(rand() * 5400) - 1800 + p.bedShift;
  const wake = day + 7 * 3600 + Math.round(rand() * 3600) - 1200 + p.wakeShift;
  const night: Night = { start: bed, end: Math.min(wake, nowTs), stages: [] };
  const slept = night.end > night.start;
  if (slept) {
    let t = night.start;
    let cycleStart = t;
    while (t < night.end) {
      const inCycle = (t - cycleStart) / 60;
      const cycleLen = 90;
      let stage: number;
      if (inCycle < 10) stage = 2;
      else if (inCycle < 35) stage = t - night.start < 4 * 3600 ? 3 : 2;
      else if (inCycle < 70) stage = 2;
      else stage = 4;
      if (rand() < 0.03) stage = 1;
      if (inCycle >= cycleLen) cycleStart = t;
      night.stages.push({ t, stage });
      t += 60;
    }
  }
  const hrv = slept ? simulateHrv(night, R(3), p) : null;

  // --- workouts and monitoring for the day
  rand = R(4);
  const workouts: PlannedWorkout[] = [];
  const dow = new Date(day * 1000).getDay();
  if (p.runDays.includes(dow)) {
    const start = day + 18 * 3600 + Math.round(rand() * 3600);
    const duration = 1800 + Math.round(rand() * 1200);
    if (start + duration < nowTs) workouts.push({ start, duration, sport: 1, name: "Corsa" });
  }
  if (p.walkDays.includes(dow)) {
    const start = day + 10 * 3600 + Math.round(rand() * 7200);
    const duration = 2400 + Math.round(rand() * 1800);
    if (start + duration < nowTs) workouts.push({ start, duration, sport: 11, name: "Camminata" });
  }
  const m = simulateMonitoring(day, dayEnd, night, workouts, R(5), p);
  return { day, dayEnd, night, slept, hrv, workouts, ...m };
}

export interface DemoOptions {
  days?: number;
  seed?: number;
  now?: Date;
  persona?: Persona;
}

export function generateDemoFiles(opts: DemoOptions = {}): FakeFile[] {
  const days = opts.days ?? 14;
  const seed = opts.seed ?? 42;
  const now = opts.now ?? new Date();
  const persona = opts.persona ?? DEFAULT_PERSONA;
  const nowTs = Math.floor(now.getTime() / 1000);
  const files: FakeFile[] = [];
  let fileNumber = 1;

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime() / 1000;
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1).getTime() / 1000;
    const sim = simulateDay(day, nextDay, nowTs, seed, persona);
    if (!sim) continue;
    const R = dayRandom(seed, day);
    if (sim.slept) {
      files.push(sleepFile(sim.night, fileNumber++, R(2)));
      files.push(hrvFile(sim.night, sim.hrv!, fileNumber++));
    }
    files.push(monitorFile(sim, fileNumber++));
    sim.workouts.forEach((w, k) => files.push(activityFile(w, fileNumber++, R(6 + k))));
  }
  return files;
}

function simulateMonitoring(day: number, dayEnd: number, night: Night, workouts: PlannedWorkout[], rand: () => number, p: Persona) {
  const events: MonitorEvent[] = [];
  const wakeEnd = night.end;
  let walkSteps = 0;
  let walkDist = 0; // cm
  let runSteps = 0;
  let runDist = 0;
  let cal = 0;
  let energy = 35 + Math.round(rand() * 15);
  const restingHr = p.restingHr + Math.round(rand() * 6);
  let hrNow = restingHr + 5;
  const smooth = (target: number) => (hrNow += (target - hrNow) * 0.35 + (rand() - 0.5) * 3);
  for (let t = day + 60; t <= dayEnd; t += 60) {
    const hour = new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60;
    const asleep = t < wakeEnd || hour >= 23.5;
    const workout = workouts.find((w) => t >= w.start && t < w.start + w.duration);
    let type = 8; // sedentary
    let intensity = 0;
    let target = restingHr + 8;
    if (asleep) {
      target = restingHr - 3;
      energy = Math.min(100, energy + (rand() < 0.35 * p.recharge ? 1 : 0));
    } else if (workout) {
      const isRun = workout.sport === 1;
      type = isRun ? 1 : 6;
      intensity = isRun ? 4 : 2;
      const s = isRun ? 150 + Math.round(rand() * 20) : 100 + Math.round(rand() * 15);
      if (isRun) {
        runSteps += s;
        runDist += s * 105;
      } else {
        walkSteps += s;
        walkDist += s * 75;
      }
      cal += isRun ? 11 : 5;
      target = isRun ? 152 : 104;
      energy = Math.max(5, energy - (rand() < 0.5 ? 1 : 0));
    } else {
      const activeHour = (hour > 8 && hour < 9.5) || (hour > 12.5 && hour < 13.5) || (hour > 17.5 && hour < 19.5);
      if (rand() < (activeHour ? 0.55 : 0.12) * p.activity) {
        type = 6;
        intensity = 1;
        const s = Math.round((20 + Math.round(rand() * (activeHour ? 90 : 40))) * p.stepScale);
        walkSteps += s;
        walkDist += s * 72;
        cal += 1 + Math.round(s / 40);
        target += 18;
      }
      if (rand() < 0.08) energy = Math.max(5, energy - 1);
    }
    const hr = Math.round(smooth(target));
    // while sleeping only one sample every 15 minutes (like real bands)
    if (asleep && t % 900 !== 0) continue;
    events.push({ kind: "minute", t, type, intensity, hr, walkSteps, walkDist, runSteps, runDist, cal });
    if (t % 180 === 0) {
      const stress = asleep ? 5 + Math.round(rand() * 15) : workout ? -2 : p.stressBase + Math.round(rand() * p.stressSpread);
      events.push({ kind: "stress", t, stress, energy });
    }
    if (t % 900 === 0) {
      events.push({ kind: "resp", t, raw: Math.round(((asleep ? 13.5 : 15.5 + rand() * 3) + p.respShift) * 100) });
      if (asleep) events.push({ kind: "spo2", t, value: p.spo2Base + Math.round(rand() * 5) });
    }
  }
  return { events, restingHr, steps: walkSteps + runSteps, calories: cal };
}

function monitorFile(sim: DemoDay, number: number): FakeFile {
  const e = new FitEncoder();
  fileId(e, 32, sim.dayEnd, number);
  e.write(103, [
    { num: 253, base: B.UINT32, value: toGarminTs(sim.day) },
    { num: 1, base: B.ENUM, value: 6 },
    { num: 5, base: B.UINT16, value: 1650 },
  ]);
  let first = true;
  for (const ev of sim.events) {
    if (ev.kind === "minute") {
      const { t, type, intensity } = ev;
      const fields = [
        first ? { num: 253, base: B.UINT32, value: toGarminTs(t) } : { num: 26, base: B.UINT16, value: toGarminTs(t) & 0xffff },
        { num: 24, base: B.BYTE, value: (type & 0x1f) | (intensity << 5) },
        { num: 27, base: B.UINT8, value: ev.hr },
        ...(intensity >= 2 ? [{ num: intensity >= 4 ? 34 : 33, base: B.UINT16, value: 1 }] : []),
      ] as const;
      const counters =
        type === 1
          ? [{ num: 5, base: B.ENUM, value: 1 }, { num: 3, base: B.UINT32, value: ev.runSteps }, { num: 2, base: B.UINT32, value: ev.runDist }, { num: 19, base: B.UINT16, value: ev.cal }]
          : [{ num: 5, base: B.ENUM, value: 6 }, { num: 3, base: B.UINT32, value: ev.walkSteps }, { num: 2, base: B.UINT32, value: ev.walkDist }, { num: 19, base: B.UINT16, value: ev.cal }];
      e.write(55, [...fields, ...(type === 8 && !first ? [] : counters)] as never);
      first = false;
    } else if (ev.kind === "stress") {
      e.write(227, [
        { num: 0, base: B.SINT16, value: ev.stress },
        { num: 1, base: B.UINT32, value: toGarminTs(ev.t) },
        { num: 3, base: B.SINT8, value: ev.energy },
      ]);
    } else if (ev.kind === "resp") {
      e.write(297, [
        { num: 253, base: B.UINT32, value: toGarminTs(ev.t) },
        { num: 0, base: B.SINT16, value: ev.raw },
      ]);
    } else {
      e.write(269, [
        { num: 253, base: B.UINT32, value: toGarminTs(ev.t) },
        { num: 0, base: B.UINT8, value: ev.value },
        { num: 1, base: B.UINT8, value: 3 },
        { num: 2, base: B.ENUM, value: 3 },
      ]);
    }
  }
  e.write(211, [
    { num: 253, base: B.UINT32, value: toGarminTs(sim.dayEnd - 60) },
    { num: 0, base: B.UINT8, value: sim.restingHr },
    { num: 1, base: B.UINT8, value: sim.restingHr },
  ]);
  return { dataType: 128, subType: 32, fileNumber: number, date: sim.dayEnd, data: e.finish() };
}

function sleepFile(night: Night, number: number, rand: () => number): FakeFile {
  const e = new FitEncoder();
  fileId(e, 49, night.end, number);
  e.write(273, [
    { num: 253, base: B.UINT32, value: toGarminTs(night.start) },
    { num: 1, base: B.UINT16, value: 60 },
  ]);
  // like a real vívosmart 5: sleep start/end events and only the stage *changes*
  const sleepEvent = (t: number, type: number) =>
    e.write(21, [
      { num: 253, base: B.UINT32, value: toGarminTs(t) },
      { num: 0, base: B.ENUM, value: 74 },
      { num: 1, base: B.ENUM, value: type },
      { num: 3, base: B.UINT32, value: toGarminTs(t) },
    ]);
  sleepEvent(night.start, 0);
  if (night.end > night.start + 600) sleepEvent(night.end, 1);
  // the band writes one sample per run of equal stages, at the END of the run (upper bound)
  const writeLevel = (t: number, stage: number) =>
    e.write(275, [
      { num: 253, base: B.UINT32, value: toGarminTs(t) },
      { num: 0, base: B.ENUM, value: stage },
    ]);
  night.stages.forEach((s, i) => {
    const next = night.stages[i + 1];
    if (!next) writeLevel(night.end, s.stage);
    else if (next.stage !== s.stage) writeLevel(next.t, s.stage);
  });
  const awakenings = night.stages.filter((s, i) => s.stage === 1 && night.stages[i - 1]?.stage !== 1).length;
  e.write(346, [
    { num: 6, base: B.UINT8, value: 65 + Math.round(rand() * 28) },
    { num: 3, base: B.UINT8, value: 60 + Math.round(rand() * 35) },
    { num: 5, base: B.UINT8, value: 60 + Math.round(rand() * 35) },
    { num: 9, base: B.UINT8, value: 55 + Math.round(rand() * 40) },
    { num: 4, base: B.UINT8, value: 60 + Math.round(rand() * 35) },
    { num: 11, base: B.UINT8, value: awakenings },
    { num: 15, base: B.UINT16, value: Math.round((10 + rand() * 12) * 100) },
  ]);
  e.write(382, [
    { num: 0, base: B.UINT32, value: toGarminTs(night.start) },
    { num: 1, base: B.UINT8, value: 8 + Math.round(rand() * 20) },
  ]);
  return { dataType: 128, subType: 49, fileNumber: number, date: night.end, data: e.finish() };
}

function simulateHrv(night: Night, rand: () => number, p: Persona): HrvNight {
  const base = p.hrvBase + rand() * 12;
  const values: { t: number; v: number }[] = [];
  let sum = 0;
  let max = 0;
  for (let t = night.start; t < night.end; t += 300) {
    const v = base + (rand() - 0.5) * 16;
    sum += v;
    max = Math.max(max, v);
    values.push({ t, v });
  }
  return { values, base, avg: values.length ? sum / values.length : base, max };
}

function hrvFile(night: Night, h: HrvNight, number: number): FakeFile {
  const e = new FitEncoder();
  fileId(e, 68, night.end, number);
  for (const { t, v } of h.values)
    e.write(371, [
      { num: 253, base: B.UINT32, value: toGarminTs(t) },
      { num: 0, base: B.UINT16, value: Math.round(v * 128) },
    ]);
  const avg = h.avg;
  e.write(370, [
    { num: 253, base: B.UINT32, value: toGarminTs(night.end) },
    { num: 0, base: B.UINT16, value: Math.round((h.base + 1) * 128) },
    { num: 1, base: B.UINT16, value: Math.round(avg * 128) },
    { num: 2, base: B.UINT16, value: Math.round(h.max * 128) },
    { num: 3, base: B.UINT16, value: Math.round(32 * 128) },
    { num: 4, base: B.UINT16, value: Math.round(36 * 128) },
    { num: 5, base: B.UINT16, value: Math.round(52 * 128) },
    { num: 6, base: B.ENUM, value: avg >= 36 && avg <= 52 ? 4 : 3 },
  ]);
  return { dataType: 128, subType: 68, fileNumber: number, date: night.end, data: e.finish() };
}

function activityFile(w: { start: number; duration: number; sport: number; name: string }, number: number, rand: () => number): FakeFile {
  const e = new FitEncoder();
  fileId(e, 4, w.start + w.duration, number);
  e.write(12, [
    { num: 0, base: B.ENUM, value: w.sport },
    { num: 1, base: B.ENUM, value: 0 },
    { num: 3, base: B.STRING, value: w.name, size: 16 },
  ]);
  const isRun = w.sport === 1;
  const speed = isRun ? 2.9 : 1.35; // m/s
  const maxHr = 186;
  const restHr = 58;
  // Garmin default zones (% of max HR): high boundaries of zones 0..5
  const bounds = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((k) => Math.round(maxHr * k));
  const zoneTime = [0, 0, 0, 0, 0, 0];
  // a loop around Milan's Parco Sempione
  const lat0 = 45.4731;
  const lon0 = 9.1749;
  const warmup = isRun ? 240 : 0; // the first minutes of a run are walked/jogged
  let dist = 0;
  let vNow = speed * 0.5;
  let hrW = isRun ? 95 : 85;
  let hrSum = 0;
  let hrMax = 0;
  let hrMin = 255;
  let cadSum = 0;
  let cadMax = 0;
  let n = 0;
  let temp = 26;
  const STEP = 5;
  // laps: auto-lap every km, like a Garmin set to metric units
  let lap = { start: w.start, dist: 0, hr: 0, hrMax: 0, cad: 0, n: 0, vMax: 0 };
  let lapIndex = 0;
  const writeLap = (t: number, trigger: number) => {
    const elapsed = t - lap.start;
    if (elapsed <= 0 || !lap.n) return;
    const d = dist - lap.dist;
    e.write(19, [
      { num: 253, base: B.UINT32, value: toGarminTs(t) },
      { num: 254, base: B.UINT16, value: lapIndex++ },
      { num: 2, base: B.UINT32, value: toGarminTs(lap.start) },
      { num: 7, base: B.UINT32, value: elapsed * 1000 },
      { num: 8, base: B.UINT32, value: elapsed * 1000 },
      { num: 9, base: B.UINT32, value: Math.round(d * 100) },
      { num: 11, base: B.UINT16, value: Math.round((isRun ? 10.5 : 4.5) * (elapsed / 60)) },
      { num: 110, base: B.UINT32, value: Math.round((d / elapsed) * 1000) },
      { num: 111, base: B.UINT32, value: Math.round(lap.vMax * 1000) },
      { num: 15, base: B.UINT8, value: Math.round(lap.hr / lap.n) },
      { num: 16, base: B.UINT8, value: lap.hrMax },
      { num: 17, base: B.UINT8, value: Math.round(lap.cad / lap.n) },
      { num: 24, base: B.ENUM, value: trigger },
    ]);
    lap = { start: t, dist, hr: 0, hrMax: 0, cad: 0, n: 0, vMax: 0 };
  };
  for (let t = w.start; t <= w.start + w.duration; t += STEP) {
    const p = (t - w.start) / w.duration;
    const ang = p * Math.PI * 2 * (isRun ? 3 : 2);
    const lat = lat0 + Math.sin(ang) * 0.004;
    const lon = lon0 + Math.cos(ang) * 0.006;
    const target = t - w.start < warmup ? speed * 0.55 : speed * (0.95 + rand() * 0.1);
    vNow += (target - vNow) * 0.15;
    const v = vNow;
    dist += v * STEP;
    const hrTarget = (isRun ? (t - w.start < warmup ? 112 : 142) : 96) + p * 18;
    hrW += (hrTarget - hrW) * 0.08 + (rand() - 0.5) * 2;
    const hr = Math.round(hrW);
    // strides per minute (FIT running cadence), the app shows steps = strides × 2
    const cad = isRun ? (t - w.start < warmup ? 58 : 80) + Math.round(rand() * 4) : 55 + Math.round(rand() * 6);
    if (rand() < 0.01) temp += rand() < 0.6 ? -1 : 1;
    hrSum += hr;
    hrMax = Math.max(hrMax, hr);
    hrMin = Math.min(hrMin, hr);
    cadSum += cad;
    cadMax = Math.max(cadMax, cad);
    n++;
    const zone = bounds.findIndex((b) => hr <= b);
    zoneTime[zone < 0 ? 5 : zone] += STEP;
    lap.hr += hr;
    lap.hrMax = Math.max(lap.hrMax, hr);
    lap.cad += cad;
    lap.vMax = Math.max(lap.vMax, v);
    lap.n++;
    e.write(20, [
      { num: 253, base: B.UINT32, value: toGarminTs(t) },
      { num: 0, base: B.SINT32, value: Math.round((lat * 2 ** 31) / 180) },
      { num: 1, base: B.SINT32, value: Math.round((lon * 2 ** 31) / 180) },
      { num: 3, base: B.UINT8, value: hr },
      { num: 5, base: B.UINT32, value: Math.round(dist * 100) },
      { num: 73, base: B.UINT32, value: Math.round(v * 1000) },
      { num: 78, base: B.UINT32, value: Math.round((122 + Math.sin(ang) * 4 + 500) * 5) },
      { num: 4, base: B.UINT8, value: cad },
      { num: 13, base: B.SINT8, value: temp },
    ]);
    if (dist - lap.dist >= 1000) writeLap(t, 2);
  }
  const end = w.start + w.duration;
  writeLap(end, 7);
  e.write(216, [
    { num: 253, base: B.UINT32, value: toGarminTs(end) },
    { num: 0, base: B.UINT16, value: 18 },
    { num: 1, base: B.UINT16, value: 0 },
    { num: 2, base: B.UINT32, value: zoneTime.map((s) => s * 1000) },
    { num: 6, base: B.UINT8, value: bounds },
    { num: 11, base: B.UINT8, value: maxHr },
    { num: 12, base: B.UINT8, value: restHr },
  ]);
  const minutes = w.duration / 60;
  e.write(18, [
    { num: 253, base: B.UINT32, value: toGarminTs(end) },
    { num: 254, base: B.UINT16, value: 0 },
    { num: 2, base: B.UINT32, value: toGarminTs(w.start) },
    { num: 5, base: B.ENUM, value: w.sport },
    { num: 6, base: B.ENUM, value: 0 },
    { num: 7, base: B.UINT32, value: w.duration * 1000 },
    { num: 8, base: B.UINT32, value: w.duration * 1000 },
    { num: 9, base: B.UINT32, value: Math.round(dist * 100) },
    { num: 10, base: B.UINT32, value: Math.round(cadSum * (STEP / 60)) },
    { num: 11, base: B.UINT16, value: Math.round((isRun ? 10.5 : 4.5) * minutes) },
    { num: 16, base: B.UINT8, value: Math.round(hrSum / n) },
    { num: 17, base: B.UINT8, value: hrMax },
    { num: 64, base: B.UINT8, value: hrMin },
    { num: 18, base: B.UINT8, value: Math.round(cadSum / n) },
    { num: 19, base: B.UINT8, value: cadMax },
    { num: 22, base: B.UINT16, value: Math.round(15 + rand() * 30) },
    { num: 23, base: B.UINT16, value: Math.round(15 + rand() * 30) },
    { num: 24, base: B.UINT8, value: isRun ? 28 + Math.round(rand() * 8) : 12 + Math.round(rand() * 6) },
    { num: 137, base: B.UINT8, value: isRun ? Math.round(rand() * 6) : 0 },
    { num: 57, base: B.SINT8, value: 25 },
    { num: 58, base: B.SINT8, value: 27 },
    { num: 150, base: B.SINT8, value: 23 },
    { num: 178, base: B.UINT16, value: Math.round((isRun ? 8 : 4) * minutes) },
    { num: 215, base: B.UINT8, value: 62 },
    { num: 216, base: B.UINT8, value: isRun ? 55 : 59 },
    { num: 124, base: B.UINT32, value: Math.round((dist / w.duration) * 1000) },
  ]);
  return { dataType: 128, subType: 4, fileNumber: number, date: end, data: e.finish() };
}

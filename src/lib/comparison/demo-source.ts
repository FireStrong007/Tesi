/**
 * Example comparison data until the server exists: a synthetic cohort of ~50 people simulated with
 * the demo band's generator, each with a different lifestyle. A person's day depends only on
 * (person, day), so any period can be compared, months back too. Values are computed on demand
 * and cached.
 *
 * The day values follow the importer + loadRange rules exactly (checked in tests/comparison.test.ts):
 * samples belong to the local day of their timestamp, steps/calories are the band's day counters,
 * stress averages only valid samples, the night belongs to the day you wake up.
 */
import { counterDelta } from "../db/importer";
import { addDays, startOfDay } from "../db/repo";
import { DEFAULT_PERSONA, dayRandom, rng, simulateDay, type DemoDay, type Persona } from "../demo/generator";
import { stats, stressAverage } from "../metrics";
import { averageOfUsers } from "./aggregate";
import { metricValue, type DayFacts } from "./daily-values";
import type { CompareMetric, ComparisonQuery, ComparisonSource, DailyAverage } from "./types";

export interface CohortMember {
  id: string;
  seed: number;
  persona: Persona;
  /** probability of wearing the band on a given day */
  wear: number;
  hasSpo2: boolean;
  hasHrv: boolean;
}

export const COHORT_SIZE = 50;
export const COHORT_SEED = 20_251;

/** The cohort's people: deterministic for a given seed. */
export function demoCohort(size = COHORT_SIZE, seed = COHORT_SEED): CohortMember[] {
  return Array.from({ length: size }, (_, i) => {
    const r = rng(seed * 7919 + i * 104_729);
    const between = (lo: number, hi: number) => lo + r() * (hi - lo);
    // k distinct weekdays (Fisher-Yates: the same on every JS engine)
    const days = (k: number) => {
      const w = [0, 1, 2, 3, 4, 5, 6];
      for (let j = w.length - 1; j > 0; j--) {
        const x = Math.floor(r() * (j + 1));
        [w[j], w[x]] = [w[x], w[j]];
      }
      return w.slice(0, k).sort((a, b) => a - b);
    };
    const activity = between(0.25, 1.15);
    const persona: Persona = {
      ...DEFAULT_PERSONA,
      restingHr: Math.round(between(47, 70)),
      activity,
      // more active people also take longer walks
      stepScale: Math.sqrt(activity) * between(0.85, 1.15),
      bedShift: Math.round(between(-5400, 4200)),
      wakeShift: Math.round(between(-4800, 4800)),
      stressBase: Math.round(between(8, 34)),
      stressSpread: Math.round(between(28, 55)),
      hrvBase: between(22, 58),
      respShift: between(-1.5, 2),
      spo2Base: Math.round(between(90, 95)),
      recharge: between(0.1, 0.45),
      runDays: days(Math.floor(between(0, activity > 0.8 ? 3.99 : 1.99))),
      walkDays: days(Math.floor(between(0, 3.99))),
    };
    return {
      id: `demo-${String(i + 1).padStart(2, "0")}`,
      seed: seed * 1000 + i,
      persona,
      wear: between(0.82, 1),
      hasSpo2: r() < 0.8,
      hasHrv: r() < 0.9,
    };
  });
}

/** Today's values change while the day goes on: they are recomputed after this many seconds. */
const TODAY_TTL = 600;

export class DemoComparisonSource implements ComparisonSource {
  readonly sample = true;
  readonly members: CohortMember[];
  private now: () => number;
  private sims = new Map<string, { at: number; sim: DemoDay | null }>();
  private facts = new Map<string, { at: number; facts: DayFacts | null }>();

  constructor(opts: { size?: number; seed?: number; now?: () => number } = {}) {
    this.members = demoCohort(opts.size, opts.seed);
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async dailyAverages(metric: CompareMetric, from: number, to: number, query: ComparisonQuery = {}): Promise<DailyAverage[]> {
    const members = this.members.filter((m) => m.id !== query.excludeUserId);
    const out: DailyAverage[] = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      out.push({ day: d, ...averageOfUsers(members.map((m) => metricValue(metric, this.factsOf(m, d)))) });
      // keep the page responsive while a new period is simulated
      if (out.length % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }

  /** One person's day as the importer + loadRange would see it; null = band not worn / future day. */
  factsOf(m: CohortMember, day: number): DayFacts | null {
    const now = this.now();
    const key = `${m.id}:${day}`;
    const hit = this.facts.get(key);
    const isToday = addDays(day, 1) > now;
    if (hit && (!isToday || now - hit.at < TODAY_TTL)) return hit.facts;
    const facts = dayRandom(m.seed, day)(99)() < m.wear ? this.computeFacts(m, day, now) : null;
    this.facts.set(key, { at: now, facts });
    return facts;
  }

  private simulate(m: CohortMember, day: number, now: number): DemoDay | null {
    const key = `${m.id}:${day}`;
    const hit = this.sims.get(key);
    if (hit && (addDays(day, 1) <= now || now - hit.at < TODAY_TTL)) return hit.sim;
    const sim = simulateDay(day, addDays(day, 1), now, m.seed, m.persona);
    this.sims.set(key, { at: now, sim });
    return sim;
  }

  /**
   * Steps and active calories of the day as the importer counts them: per activity type, as the
   * difference between consecutive cumulative counters (a lower value = the counter restarted),
   * starting from the last values seen on the previous days.
   */
  private dayCounters(m: CohortMember, day: number, sim: DemoDay, now: number) {
    const prev: Record<"1" | "6", { steps: number; cal: number }> = { "1": { steps: -1, cal: -1 }, "6": { steps: -1, cal: -1 } };
    const missing = new Set<"1" | "6">(["1", "6"]);
    for (let k = 1; k <= 8 && missing.size; k++) {
      const before = this.simulate(m, addDays(day, -k), now);
      if (!before) continue;
      const rows = counterRows(before);
      for (const key of [...missing]) {
        const last = rows.filter((r) => r.key === key).pop();
        if (last) {
          prev[key] = { steps: last.steps, cal: last.cal };
          missing.delete(key);
        }
      }
    }
    let steps = 0;
    let calories = 0;
    for (const r of counterRows(sim)) {
      steps += counterDelta(prev[r.key].steps, r.steps);
      calories += counterDelta(prev[r.key].cal, r.cal);
      prev[r.key] = { steps: r.steps, cal: r.cal };
    }
    return { steps, calories };
  }

  private computeFacts(m: CohortMember, day: number, now: number): DayFacts | null {
    const sim = this.simulate(m, day, now);
    if (!sim) return null;
    const next = addDays(day, 1);
    // samples are assigned by timestamp: the previous file's last sample (at midnight) belongs to this day
    const prev = this.simulate(m, addDays(day, -1), now);
    const events = [...(prev?.events.filter((e) => e.t >= day) ?? []), ...sim.events.filter((e) => e.t < next)];
    const stress: { timestamp: number; value: number }[] = [];
    const energy: number[] = [];
    const spo2: number[] = [];
    const resp: number[] = [];
    let moderate = 0;
    let vigorous = 0;
    for (const e of events) {
      if (e.kind === "stress") {
        // the importer stores stress >= 0 and Body Battery >= 0
        if (e.stress >= 0) stress.push({ timestamp: e.t, value: e.stress });
        if (e.energy >= 0) energy.push(e.energy);
      } else if (e.kind === "spo2") spo2.push(e.value);
      else if (e.kind === "resp") resp.push(e.raw / 100);
      else if (e.intensity >= 4) vigorous++;
      else if (e.intensity >= 2) moderate++;
    }
    const counters = this.dayCounters(m, day, sim, now);
    return {
      steps: counters.steps,
      activeCalories: counters.calories,
      moderateMinutes: moderate,
      vigorousMinutes: vigorous,
      sleep: nightMinutes(sim),
      restingHr: sim.restingHr,
      stressAvg: stressAverage(stress),
      bodyBatteryMax: energy.length ? Math.max(...energy) : null,
      spo2Avg: m.hasSpo2 ? stats(spo2).avg : null,
      respirationAvg: stats(resp).avg,
      // the file stores 1/128 ms, the importer keeps whole milliseconds
      hrvNightAvg: m.hasHrv && sim.hrv ? Math.round(Math.round(sim.hrv.avg * 128) / 128) : null,
    };
  }
}

/** Monitoring rows that carry the band's cumulative counters, keyed by activity type like the importer. */
function counterRows(sim: DemoDay) {
  const rows: { key: "1" | "6"; steps: number; cal: number }[] = [];
  let first = true;
  for (const e of sim.events) {
    if (e.kind !== "minute") continue;
    // sedentary minutes carry no counters, except the first row of the file
    if (e.type !== 8 || first) rows.push(e.type === 1 ? { key: "1", steps: e.runSteps, cal: e.cal } : { key: "6", steps: e.walkSteps, cal: e.cal });
    first = false;
  }
  return rows;
}

/**
 * Minutes per stage of the night ending on this day, as sleepSessions rebuilds them from the
 * band's file: every stage lasts until the next change, the night ends at the wake-up event,
 * nights shorter than 20 minutes are ignored.
 */
function nightMinutes(sim: DemoDay): DayFacts["sleep"] {
  const n = sim.night;
  if (!sim.slept || n.end - n.start < 20 * 60 || startOfDay(n.end) !== sim.day) return null;
  const out = { light: 0, deep: 0, rem: 0 };
  for (const s of n.stages) {
    const mins = (Math.min(s.t + 60, n.end) - s.t) / 60;
    if (s.stage === 2) out.light += mins;
    else if (s.stage === 3) out.deep += mins;
    else if (s.stage === 4) out.rem += mins;
  }
  return out;
}

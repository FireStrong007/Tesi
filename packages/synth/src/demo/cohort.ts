/**
 * The people of a synthetic cohort: deterministic personas for the demo generator, used by the
 * comparison tests (and, until Fase 4, by the app's demo comparison).
 */
import { DEFAULT_PERSONA, rng, type Persona } from "./generator";

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

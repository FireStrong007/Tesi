/**
 * A participant's goals, kept by the server with their account (not in the browser's copy, which
 * is deleted at logout): the same definition and limits for the app and the server.
 */
export interface Goals {
  step_goal: number;
  sleep_goal_min: number;
  /** intensity minutes per week (WHO: 150) */
  active_minutes_goal: number;
  distance_goal_m: number;
  /** active calories per day */
  calories_goal: number;
}

export const DEFAULT_GOALS: Goals = { step_goal: 8000, sleep_goal_min: 480, active_minutes_goal: 150, distance_goal_m: 5000, calories_goal: 350 };

export const GOAL_LIMITS: Record<keyof Goals, { min: number; max: number; label: string }> = {
  step_goal: { min: 500, max: 100_000, label: "Passi al giorno" },
  sleep_goal_min: { min: 180, max: 900, label: "Sonno (minuti)" },
  active_minutes_goal: { min: 10, max: 3000, label: "Minuti di intensità a settimana" },
  distance_goal_m: { min: 500, max: 100_000, label: "Distanza al giorno (metri)" },
  calories_goal: { min: 50, max: 5000, label: "Calorie attive al giorno" },
};

/** The goals in `value` (missing ones from `base`), or the Italian reason why they are not acceptable. */
export function checkGoals(value: unknown, base: Goals = DEFAULT_GOALS): { goals: Goals } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Obiettivi non validi." };
  const out = { ...base };
  for (const [k, v] of Object.entries(value)) {
    if (!(k in GOAL_LIMITS)) return { error: `Obiettivo sconosciuto: ${k}` };
    const { min, max, label } = GOAL_LIMITS[k as keyof Goals];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return { error: `${label}: un numero intero tra ${min} e ${max}.` };
    out[k as keyof Goals] = v;
  }
  return { goals: out };
}

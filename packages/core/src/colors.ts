/** Sleep stage colors/labels (FIT SleepLevel: 1 awake, 2 light, 3 deep, 4 REM). No UI dependencies. */
export const STAGE_COLOR: Record<number, string> = {
  1: "var(--sleep-awake)",
  2: "var(--sleep-light)",
  3: "var(--sleep-deep)",
  4: "var(--sleep-rem)",
};
export const STAGE_LABEL: Record<number, string> = { 1: "Sveglio", 2: "Leggero", 3: "Profondo", 4: "REM" };

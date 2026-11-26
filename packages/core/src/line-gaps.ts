/**
 * Where a chart's line breaks: between two measures further apart than a few times the series' own
 * typical interval. Garmin bands measure every minute, Gima watches every 10–20 minutes: one fixed
 * threshold either breaks the Gima lines at almost every measure or bridges real Garmin pauses.
 * Each chart keeps its old fixed threshold as the minimum, so per-minute series break where they did.
 */

/** a pause longer than this many typical intervals breaks the line */
export const GAP_FACTOR = 2.5;

/** the median of the intervals between consecutive measures (seconds); null with fewer than two */
export function typicalInterval(points: readonly { timestamp: number }[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const s = points[i].timestamp - points[i - 1].timestamp;
    if (s > 0) d.push(s);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/** the pause (seconds) that breaks this series' line: GAP_FACTOR × its typical interval, at least `min` */
export function lineGap(points: readonly { timestamp: number }[], min: number): number {
  const t = typicalInterval(points);
  return t == null ? min : Math.max(min, GAP_FACTOR * t);
}

/** how far (seconds) from a measure the reading under the pointer still shows it: half a line gap, at least `min` */
export function readingReach(points: readonly { timestamp: number }[], min: number): number {
  const t = typicalInterval(points);
  return t == null ? min : Math.max(min, (GAP_FACTOR * t) / 2);
}

/** the series split where it breaks: runs of measures closer than `gap`; a run of one is an isolated measure */
export function lineRuns<T extends { timestamp: number }>(points: readonly T[], gap: number): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  for (const p of points) {
    if (run.length && p.timestamp - run[run.length - 1].timestamp > gap) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** the measures with no neighbour within `gap`: a line cannot show them, the chart draws them as dots */
export const isolatedPoints = <T extends { timestamp: number }>(points: readonly T[], gap: number): T[] =>
  lineRuns(points, gap)
    .filter((r) => r.length === 1)
    .map((r) => r[0]);

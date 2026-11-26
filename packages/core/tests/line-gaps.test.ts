import { describe, expect, it } from "vitest";
import { GAP_FACTOR, isolatedPoints, lineGap, lineRuns, readingReach, typicalInterval } from "../src/line-gaps";

const T0 = 1_795_644_600; // 25 November 2026, 23:10 in Rome
/** one measure every `step` seconds, with a little irregularity like the watches' */
const every = (n: number, step: number, t0 = T0, jitter = [0, 40, -35, 70, -20]) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: t0 + i * step + jitter[i % jitter.length], value: 60 + (i % 7) }));

describe("where a chart's line breaks (core/line-gaps)", () => {
  it("the typical interval is the median of the intervals", () => {
    expect(typicalInterval([])).toBeNull();
    expect(typicalInterval([{ timestamp: 5 }])).toBeNull();
    expect(typicalInterval([{ timestamp: 0 }, { timestamp: 60 }, { timestamp: 120 }, { timestamp: 4000 }])).toBe(60);
    expect(typicalInterval([{ timestamp: 0 }, { timestamp: 60 }, { timestamp: 180 }])).toBe(90);
    // repeated timestamps do not count as intervals
    expect(typicalInterval([{ timestamp: 0 }, { timestamp: 0 }, { timestamp: 600 }])).toBe(600);
  });

  it("a Gima night (a measure every ~18 minutes) is one line, not isolated points", () => {
    const night = every(26, 18 * 60);
    // the old fixed threshold of the sleep chart (15 minutes): every measure alone, no line drawn
    expect(isolatedPoints(night, 900)).toHaveLength(26);
    const gap = lineGap(night, 900);
    expect(gap).toBeCloseTo(GAP_FACTOR * typicalInterval(night)!, 6);
    expect(gap).toBeGreaterThan(40 * 60);
    expect(lineRuns(night, gap)).toHaveLength(1);
    expect(isolatedPoints(night, gap)).toEqual([]);
  });

  it("a real pause still breaks the line, and a measure alone after it is isolated", () => {
    const a = every(10, 18 * 60);
    const lone = { timestamp: a[9].timestamp + 3 * 3600, value: 70 };
    const b = every(8, 18 * 60, lone.timestamp + 3 * 3600);
    const pts = [...a, lone, ...b];
    const gap = lineGap(pts, 900);
    expect(lineRuns(pts, gap).map((r) => r.length)).toEqual([10, 1, 8]);
    expect(isolatedPoints(pts, gap)).toEqual([lone]);
  });

  it("per-minute series (Garmin) keep the chart's old threshold: VitaBridge unchanged", () => {
    const minute = [...every(120, 60), ...every(60, 60, T0 + 120 * 60 + 20 * 60), ...every(30, 60, T0 + 200 * 60 + 40 * 60)];
    for (const min of [900, 1800, 3600]) {
      expect(lineGap(minute, min)).toBe(min);
      expect(lineRuns(minute, lineGap(minute, min))).toEqual(lineRuns(minute, min));
    }
    expect(readingReach(minute, 900)).toBe(900);
    expect(readingReach(minute, 600)).toBe(600);
  });

  it("the reading reaches half a line gap from a measure", () => {
    const night = every(26, 18 * 60);
    expect(readingReach(night, 900)).toBeCloseTo(lineGap(night, 900) / 2, 6);
    expect(lineGap([], 900)).toBe(900);
    expect(readingReach([{ timestamp: 1 }], 900)).toBe(900);
  });
});

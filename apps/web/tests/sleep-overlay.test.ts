import { describe, expect, it } from "vitest";
import { HYPNOGRAM_PAD, hypnogramPlot, nightTiles, overlayScale } from "@/lib/sleep-overlay";

describe("sleep stages chart with a measure on top", () => {
  it("the plot area is the same with or without a measure on top: the right axis is always reserved", () => {
    // hypnogramPlot takes only the width: nothing about the measure can move or resize the plot
    expect(hypnogramPlot.length).toBe(1);
    for (const w of [326, 358, 600, 1000]) {
      const p = hypnogramPlot(w);
      expect(p.left).toBe(HYPNOGRAM_PAD.left);
      expect(p.width).toBe(w - HYPNOGRAM_PAD.left - HYPNOGRAM_PAD.right);
    }
    expect(HYPNOGRAM_PAD.right).toBeGreaterThanOrEqual(30); // room for «100»
    expect(HYPNOGRAM_PAD.top).toBeGreaterThan(0); // room for «100 bpm» above the plot
  });

  it("each measure has a fixed scale, widened only when a value falls outside", () => {
    expect(overlayScale("hr", [55, 70, 92])).toEqual({ lo: 40, hi: 100, ticks: [40, 60, 80, 100], unit: "bpm" });
    expect(overlayScale("spo2", [91, 97])).toEqual({ lo: 85, hi: 100, ticks: [85, 90, 95, 100], unit: "%" });
    expect(overlayScale("resp", [12.5, 17])).toEqual({ lo: 8, hi: 24, ticks: [8, 12, 16, 20, 24], unit: "resp/min" });
    // widened: a high heart rate, a low SpO2, slow breathing
    expect(overlayScale("hr", [38, 124])).toMatchObject({ lo: 20, hi: 140 });
    expect(overlayScale("spo2", [82, 99])).toMatchObject({ lo: 80, hi: 100 });
    expect(overlayScale("resp", [6.5, 20])).toMatchObject({ lo: 4, hi: 24 });
    // SpO2 never above 100; always at least one value between the ends; at most 6 labels
    expect(overlayScale("spo2", [101]).hi).toBe(100);
    for (const s of [overlayScale("hr", [30, 200]), overlayScale("spo2", []), overlayScale("resp", [2, 40])]) {
      expect(s.ticks.length).toBeGreaterThanOrEqual(3);
      expect(s.ticks.length).toBeLessThanOrEqual(6);
      expect(s.ticks[0]).toBe(s.lo);
      expect(s.ticks[s.ticks.length - 1]).toBe(s.hi);
    }
  });

  it("the tiles follow the measure on top: minimum, maximum and average with its unit", () => {
    const night = { hr: [58, 62, 70], spo2: [93, 96, 97, 98], resp: [12.4, 14.1, 15.0] };
    expect(nightTiles("hr", night).map((t) => `${t.label} ${t.value} ${t.unit}`)).toEqual(["Battito minimo 58 bpm", "Battito massimo 70 bpm", "Battito medio 63 bpm"]);
    expect(nightTiles("spo2", night).map((t) => `${t.label} ${t.value} ${t.unit}`)).toEqual(["SpO₂ minima 93 %", "SpO₂ massima 98 %", "SpO₂ media 96 %"]);
    expect(nightTiles("resp", night).map((t) => `${t.label} ${t.value} ${t.unit}`)).toEqual(["Respirazione minima 12,4 resp/min", "Respirazione massima 15 resp/min", "Respirazione media 13,8 resp/min"]);
  });

  it("with no measure on top, the night's averages of the measures with data", () => {
    expect(nightTiles(null, { hr: [60, 70], spo2: [95, 97], resp: [14, 16] }).map((t) => `${t.label} ${t.value} ${t.unit}`)).toEqual([
      "Battito medio 65 bpm",
      "SpO₂ media 96 %",
      "Respirazione media 15 resp/min",
    ]);
    // no SpO2 this night: its tile is left out
    expect(nightTiles(null, { hr: [60, 70], spo2: [], resp: [14, 16] }).map((t) => t.label)).toEqual(["Battito medio", "Respirazione media"]);
    expect(nightTiles(null, { hr: [], spo2: [], resp: [] })).toEqual([]);
  });
});

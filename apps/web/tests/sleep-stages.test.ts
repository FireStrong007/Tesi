import { describe, expect, it } from "vitest";
import { BRANDS, sectionModeOf } from "@/brand";
import { drawnStages, hypnogramRows, stageEntries, tiledStages } from "@/lib/sleep-stages";

const minutes = { deep: 80, light: 250, rem: 0, awake: 30 };

describe("sleep stages per app (brand.ts)", () => {
  it("HeartBridge hides REM and the restless moments, like stress and Body Battery", () => {
    const hb = BRANDS.heartbridge;
    expect(sectionModeOf(hb, "rem")).toBe("hidden");
    expect(sectionModeOf(hb, "restless")).toBe("hidden");
    expect(sectionModeOf(hb, "stress")).toBe("hidden");
    const rem = sectionModeOf(hb, "rem");
    // no REM in the ring, bars and legends, nor in the tiles, nor in the hypnogram's rows; «Sveglio» stays
    expect(stageEntries(minutes, rem).map((e) => e.label)).toEqual(["Profondo", "Leggero", "Sveglio"]);
    expect(tiledStages(rem)).toEqual(["deep", "light", "awake"]);
    expect(hypnogramRows(rem)).toEqual([1, 2, 3]);
  });

  it("VitaBridge keeps every stage and the restless moments", () => {
    const vb = BRANDS.vitabridge;
    expect(sectionModeOf(vb, "rem")).toBe("shown");
    expect(sectionModeOf(vb, "restless")).toBe("shown");
    const rem = sectionModeOf(vb, "rem");
    expect(stageEntries(minutes, rem).map((e) => e.label)).toEqual(["Profondo", "Leggero", "REM", "Sveglio"]);
    expect(tiledStages(rem)).toEqual(["deep", "light", "rem", "awake"]);
    expect(hypnogramRows(rem)).toEqual([1, 4, 2, 3]);
  });

  it('"unavailable" keeps only the REM tile (with the notice), nothing drawn for it', () => {
    expect(drawnStages("unavailable")).toEqual(["deep", "light", "awake"]);
    expect(tiledStages("unavailable")).toEqual(["deep", "light", "rem", "awake"]);
    expect(hypnogramRows("unavailable")).toEqual([1, 2, 3]);
  });
});

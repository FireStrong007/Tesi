/**
 * The sleep stages an app shows. A device that does not measure REM (Gima: deep and light only, the
 * pauses between them awake) has no REM in the ring, the tiles, the legends, the bars nor in the
 * hypnogram's rows; «Sveglio» always stays. With "unavailable" (brand.ts) the REM tile stays, with
 * «Non disponibile con questo dispositivo», and nothing is drawn for it.
 */
import { STAGE_COLOR, STAGE_LABEL } from "@bridge/core/colors";
import type { MissingSection } from "@/brand";

export type StageKey = "deep" | "light" | "rem" | "awake";
export type StageMinutes = Record<StageKey, number>;
type Mode = "shown" | MissingSection;

/** stage number of each key (core/colors: 1 awake, 2 light, 3 deep, 4 REM) */
const STAGE_OF: Record<StageKey, number> = { deep: 3, light: 2, rem: 4, awake: 1 };
/** the order of the ring, the tiles, the bars and the legends */
const ORDER: StageKey[] = ["deep", "light", "rem", "awake"];

/** the stages drawn (ring, bars, legends), in order */
export const drawnStages = (rem: Mode): StageKey[] => ORDER.filter((k) => k !== "rem" || rem === "shown");

/** the stages with a tile: the drawn ones, plus REM when it is "unavailable" */
export const tiledStages = (rem: Mode): StageKey[] => ORDER.filter((k) => k !== "rem" || rem !== "hidden");

/** the hypnogram's rows, top to bottom (stage numbers): Sveglio, REM, Leggero, Profondo */
export const hypnogramRows = (rem: Mode): number[] => [1, 4, 2, 3].filter((st) => st !== 4 || rem === "shown");

/** label, minutes and colour of each drawn stage */
export const stageEntries = (m: StageMinutes, rem: Mode) =>
  drawnStages(rem).map((k) => ({ key: k, label: STAGE_LABEL[STAGE_OF[k]], value: m[k], color: STAGE_COLOR[STAGE_OF[k]] }));

/** label and colour of a stage, for the tiles */
export const stageLabel = (k: StageKey) => STAGE_LABEL[STAGE_OF[k]];
export const stageColor = (k: StageKey) => STAGE_COLOR[STAGE_OF[k]];

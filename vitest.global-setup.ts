/**
 * Once for the whole test run: the files in data/ (real research databases, the export, the
 * synthetic databases) must be byte for byte the same after the tests as before, and no file may
 * appear next to them. The tests never write there; this proves it on every run.
 */
import { resolve } from "node:path";
import { diffSnapshots, snapshotDir, type DirSnapshot } from "./packages/synth/src/data-guard";

// DATA_GUARD_DIR: another folder, only to check that the guard fails a run (never needed otherwise)
const DATA = resolve(import.meta.dirname, process.env.DATA_GUARD_DIR ?? "data");
let before: DirSnapshot;

export async function setup() {
  before = await snapshotDir(DATA);
}

export async function teardown() {
  const changes = diffSnapshots(before, await snapshotDir(DATA));
  if (changes.length) throw new Error(`I file in data/ sono cambiati durante i test (devono essere aperti solo in lettura):\n${changes.join("\n")}`);
  console.log(`data/: ${Object.keys(before).length} file identici prima e dopo i test (SHA-256)`);
}

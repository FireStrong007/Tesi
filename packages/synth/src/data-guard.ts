/**
 * The research data in data/ are only ever read: the test run takes a fingerprint of every file
 * there (name, size, SHA-256) before the tests and compares it afterwards (vitest.global-setup.ts at
 * the repository root). A changed, removed or new file (e.g. a -wal/-shm left by a database opened
 * without immutable=1) fails the run.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type DirSnapshot = Record<string, { size: number; sha256: string }>;

const hashFile = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

/** Every file under `dir` (recursively), by path relative to it; empty when `dir` does not exist. */
export async function snapshotDir(dir: string): Promise<DirSnapshot> {
  const out: DirSnapshot = {};
  if (!existsSync(dir)) return out;
  const walk = async (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p).replace(/\\/g, "/")] = { size: statSync(p).size, sha256: await hashFile(p) };
    }
  };
  await walk(dir);
  return out;
}

/** What differs between two snapshots, in words; empty when they are identical. */
export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): string[] {
  const out: string[] = [];
  for (const name of Object.keys(before)) {
    if (!(name in after)) out.push(`${name}: rimosso`);
    else if (before[name].sha256 !== after[name].sha256) out.push(`${name}: modificato`);
  }
  for (const name of Object.keys(after)) if (!(name in before)) out.push(`${name}: nuovo file`);
  return out;
}

/**
 * Reads a real Gadgetbridge export (the zip made by "Export database" / "Esporta dati") for the
 * tests that compare our conversion with what Gadgetbridge stored. The export holds personal health
 * data, so it is never part of the repository: its path comes from the GB_EXPORT environment
 * variable and the tests are skipped without it.
 */
import { readFileSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { listZip, readZipEntry, sourceFromBytes } from "../src/lib/zip";
import { fileIdOf } from "../src/lib/gb-import";
import type { Oo1Db } from "../src/lib/db/sql";

export const GB_EXPORT = process.env.GB_EXPORT ?? "";

export interface GbExport {
  /**
   * The FIT files of every pairing, by the folder Gadgetbridge keeps them in (the band's Bluetooth
   * address, which changes at each new pairing), in the order they were downloaded (creation time)
   */
  fit: Map<string, { name: string; data: Uint8Array; created: number | null; type: number }[]>;
  /** Gadgetbridge's own database from the same export */
  db: Oo1Db;
}

export async function loadGbExport(path: string): Promise<GbExport> {
  const src = sourceFromBytes(new Uint8Array(readFileSync(path)));
  const entries = await listZip(src);
  const dbEntry = entries.find((e) => /(^|\/)database\/Gadgetbridge$/.test(e.name));
  if (!dbEntry) throw new Error("L'export non contiene database/Gadgetbridge");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
  const bytes = await readZipEntry(src, dbEntry);
  const db = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rc = sqlite3.capi.sqlite3_deserialize((db as any).pointer, "main", p, bytes.length, bytes.length, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc) throw new Error(`sqlite3_deserialize: ${rc}`);

  const fit: GbExport["fit"] = new Map();
  for (const e of entries.filter((x) => /\.fit$/i.test(x.name))) {
    const folder = e.name.match(/(?:^|\/)files\/([^/]+)\//)?.[1];
    if (!folder) continue;
    const data = await readZipEntry(src, e);
    try {
      const id = fileIdOf(data);
      const list = fit.get(folder) ?? [];
      list.push({ name: e.name, data, created: id.created, type: id.type });
      fit.set(folder, list);
    } catch {
      /* not a FIT file */
    }
  }
  for (const list of fit.values()) list.sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.name.localeCompare(b.name));
  return { fit, db };
}

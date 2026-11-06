# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VitaBridge: a serverless PWA (React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui) that replaces Gadgetbridge for Garmin bands (target: vívosmart 5). It talks to the band over **Web Bluetooth** and stores everything in **SQLite WASM on OPFS** inside a worker. No backend. The protocol code is a port of Gadgetbridge (AGPL-3.0); it has been verified only against the built-in simulator, never against a real band.

Language conventions: UI strings, README and log messages for the user are in **Italian**; code comments and identifiers are in English.

## Commands

```bash
npm install
npm run dev                      # Vite dev server on :5173 (host: true)
npm run build                    # tsc -b && vite build -> dist/
npm run typecheck                # tsc -b --noEmit
npm test                         # vitest run (all tests/**/*.test.ts, node environment)
npx vitest run tests/sync.test.ts          # single test file
npx vitest run -t "pairs, syncs"           # single test by name
npm run gen:fit-profile          # regenerate src/lib/fit/profile.ts (needs ../Gadgetbridge checkout + python3)
```

There is no linter configured. CI (`.github/workflows/pages.yml`) runs `npm test` then `npm run build` on every push to `main` and deploys `dist/` to GitHub Pages, so both must pass. `vite.config.ts` uses `base: "./"` so the build works under any sub-path; keep asset paths relative.

`src/lib/fit/profile.ts` is generated — edit `scripts/gen-fit-profile.py` (the `WANTED` message set) instead.

## Architecture

Data flow: **BLE transport → Multi-Link → GFDI session → FIT files → `fit_file` table → importer → sample tables → repo queries → pages/charts.**

- **`src/lib/garmin/`** — protocol stack. `transport.ts` defines the `BleTransport` interface (real impl: `WebBluetoothTransport`). `multilink.ts` registers services on handle 0 and handles the GFDI channel plus realtime channels (HR, steps, floors, Body Battery, respiration, SpO₂). Packets are COBS-framed with Garmin CRC (`cobs.ts`, `crc.ts`). `gfdi.ts` builds/parses GFDI messages; `session.ts` (`GarminSession`) does the handshake and file sync (directory → download → archive on band).
- **`src/lib/demo/`** — `FakeWatch` implements `BleTransport` and speaks the real Multi-Link/GFDI protocol; `generator.ts` produces realistic FIT files (via `fit/encoder.ts`). The demo mode and the test suite both run the *same* session/decode/import code as a real band, so protocol changes must keep `FakeWatch` in sync.
- **`src/lib/fit/`** — FIT decoder/encoder driven by the generated profile.
- **`src/lib/db/`** — `sql.ts` defines `SqlExecutor` (`all`/`run`/`batch`), the only DB interface used by `repo.ts` and `importer.ts`. In the browser it is `DbClient` (`client.ts`), a promise RPC to `db.worker.ts` (OPFS file `/vitabridge.sqlite3`); in tests it is `oo1Executor` over an in-memory DB (`tests/helpers.ts` → `memoryDb()`). Schema lives in `schema.ts` as an append-only `MIGRATIONS` array applied via `PRAGMA user_version` (`migrate.ts`): to change the schema, append a migration and bump `SCHEMA_VERSION`, never edit old entries.
- **Schema conventions** — every sample table has `user_id` and `device_id` (designed for a future multi-patient "doctor area"); all timestamps are **unix seconds**. Raw FIT bytes are kept in `fit_file` (SHA-256 dedup) so data can be reprocessed; if older files arrive after newer ones, the device's samples are rebuilt from all its files.
- **`src/lib/device-manager.ts`** — glue between sessions (real or demo) and the DB: connect, sync, import, battery, live state. `live-recorder.ts` saves live values to `live_sample` each minute; queries append these to synced data but ignore them where FIT files already cover the period.
- **`src/lib/metrics.ts`, `db/repo.ts`, `day-data.ts`, `range-data.ts`** — computations deliberately aligned with Gadgetbridge's (sleep stage = end boundary of the period, Garmin stress bands, active + resting calories with BMR prorated). Preserve that alignment when changing them.
- **Activities** — `importer.ts` stores each FIT session in `workout` (all session fields as JSON in `summary`, plus `_zones` from `time_in_zone`), track points in `workout_record`, laps in `workout_lap`. `src/lib/workout.ts` derives zones, km splits, steps/min (Garmin running cadence is strides/min → ×2) for `pages/workouts.tsx`.
- **`src/lib/zip.ts`, `gb-import.ts`** — streaming import of Gadgetbridge export zips / loose `.fit` files, matched to devices by serial number in the FIT file.
- **UI** — `App.tsx` + `app-context.tsx`; routing is a custom hash router (`lib/router.ts`, needed for static hosting/PWA). Pages in `src/pages/`, hand-written SVG charts in `src/components/charts/`, shadcn components (new-york style) in `src/components/ui/`. Path alias `@/` → `src/`. `public/sw.js` is a network-first offline cache.

## Tests

`tests/` uses vitest in node with the real `@sqlite.org/sqlite-wasm` in memory. `sync.test.ts`/`live.test.ts` run a full `GarminSession` against `FakeWatch` end to end; `protocol.test.ts`, `fit.test.ts`, `metrics.test.ts`, `sleep.test.ts`, `gb-import.test.ts` cover the individual layers.

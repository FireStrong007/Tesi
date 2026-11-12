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
GB_EXPORT=/path/gadgetbridge_*.zip npx vitest run tests/server-format.test.ts   # checks against a real Gadgetbridge export (skipped without it; never commit an export)
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
- **Demo profile** — the demo band lives only in a separate user with `user.is_demo = 1` (`ensureDemoUser`, `openDemo`/`leaveDemo` in `app-context.tsx`, active profile in `meta.active_user`); `addDevice` refuses to mix demo and real bands in one profile and Gadgetbridge imports refuse the demo profile, because every query filters by user only. The demo profile never contributes to comparisons or uploads (`repo.shareableUsers`).
- **Schema check** — at startup (and after restoring a database) `checkSchema` in `migrate.ts` compares the DB with a fresh in-memory copy built from `MIGRATIONS`, recreates missing tables/indexes/columns, logs it, and `reprocessSchemaFailures` re-imports files that failed for a missing table or column.
- **Schema conventions** — every sample table has `user_id` and `device_id` (designed for a future multi-patient "doctor area"); all timestamps are **unix seconds**. Raw FIT bytes are kept in `fit_file` (SHA-256 dedup) so data can be reprocessed; if older files arrive after newer ones, the device's samples are rebuilt from all its files.
- **`src/lib/device-manager.ts`** — glue between sessions (real or demo) and the DB: connect, sync, import, battery, live state. `live-recorder.ts` saves live values to `live_sample` each minute; queries append these to synced data but ignore them where FIT files already cover the period.
- **`src/lib/metrics.ts`, `db/repo.ts`, `day-data.ts`, `range-data.ts`** — computations deliberately aligned with Gadgetbridge's (sleep stage = end boundary of the period, Garmin stress bands, active + resting calories with BMR prorated). Preserve that alignment when changing them.
- **Activities** — `importer.ts` stores each FIT session in `workout` (all session fields as JSON in `summary`, plus `_zones` from `time_in_zone`), track points in `workout_record`, laps in `workout_lap`. `src/lib/workout.ts` derives zones, km splits, steps/min (Garmin running cadence is strides/min → ×2) for `pages/workouts.tsx`.
- **Comparison with other users** — `src/lib/comparison/`: `ComparisonSource` interface (`types.ts`), the only entry point for the UI is `getComparisonSource()` in `index.ts` (today `DemoComparisonSource`, a synthetic cohort simulated with `demo/generator.ts` personas; later an HTTP client). It returns, per day (or per Monday–Sunday week for `WEEKLY_METRICS`, i.e. intensity minutes), the other users' median and 25th/75th percentile plus `n`, drawn as a band with the median line; the summary judgement is between people (`periodStanding`: each person's period value from `daily-values.periodValue`, the user's percentile rank among them; `aggregate.summarySentence`), only with ≥ `MIN_VALID_DAYS` (7) valid days. A "valid day" (band worn ≥ 10 h with heart rate) is defined once in `metrics.ts` (`isValidDay`) and applies to day totals of both the user and the cohort. Daily values are defined once in `daily-values.ts` for both the user (`loadRange`) and the cohort; `tests/comparison.test.ts` imports cohort members' FIT files and checks the two paths agree, so keep them in sync when changing importer/loadRange rules. Median, percentiles and ranks need ≥ `MIN_USERS` (5). «Confronta» must only add the overlay, never change the chart, and the line must measure what the bar height shows. The demo generator's default persona must keep producing identical files.
- **Research server** — `src/lib/server/`: the professor's server schema (`schema.ts`, Gadgetbridge's own Garmin tables: activity samples and battery in seconds, every other table in milliseconds, -1 = not measured, activity STEPS/DISTANCE_CM/ACTIVE_CALORIES are cumulative day counters summed over activity types). `fit-to-server.ts` replicates Gadgetbridge's FitImporter (FIT → server rows, verified row by row on a real export); `views.ts` shows the server tables as the app's tables (per-minute deltas with LAG per user/device/local day, value at t covers the minute before; the day comes from an explicit `timeZone` option, by default the study's `STUDY_TIME_ZONE` = Europe/Rome for every participant (`src/lib/time-zone.ts`), via the TEMP table `tz_offset`, never from SQLite 'localtime'; `ServerComparisonSource.open` refuses a Node process not running in that zone, since loadRange groups days with the process's local time; tests run with TZ=Europe/Rome via vite.config.ts), so `loadRange` and the comparison rules run unchanged on the server; `server-source.ts` is a `ComparisonSource` over the participants of one or more server databases (materialized snapshot). Bands are identified by the Garmin serial number, not the MAC (Web Bluetooth hides it and the vívosmart 5 changes it at every pairing). Known limit of the Gadgetbridge format, kept on purpose for consistency with data uploaded by Gadgetbridge for Android: the midnight totals can be overwritten by the next file. In the comparison the user's own values also go through this format (`user-mirror.ts`: their FIT files converted into the worker's scratch database, `DbClient.scratch()`), so "Tu" and the others share the same rules; the chart bars keep the app's values.
- **Day counters** — the importer restarts the per-activity-type counters at the band's midnight (`bandDay`, offset from `monitoring_info.local_timestamp`, browser offset only as fallback). Migration 7 sets `meta.reprocess_pending`: at the next start every device is rebuilt once from its FIT files (`runPendingReprocess`) and the user sees «Dati ricalcolati».
- **`src/lib/zip.ts`, `gb-import.ts`** — streaming import of Gadgetbridge export zips / loose `.fit` files, matched to devices by serial number in the FIT file.
- **UI** — `App.tsx` + `app-context.tsx`; routing is a custom hash router (`lib/router.ts`, needed for static hosting/PWA). Pages in `src/pages/`, hand-written SVG charts in `src/components/charts/`, shadcn components (new-york style) in `src/components/ui/`. Path alias `@/` → `src/`. `public/sw.js` is a network-first offline cache.

## Tests

`tests/` uses vitest in node with the real `@sqlite.org/sqlite-wasm` in memory. `sync.test.ts`/`live.test.ts` run a full `GarminSession` against `FakeWatch` end to end; `protocol.test.ts`, `fit.test.ts`, `metrics.test.ts`, `sleep.test.ts`, `gb-import.test.ts`, `workout.test.ts`, `transport.test.ts`, `comparison.test.ts` cover the individual layers; `separation.test.ts` covers the demo/real separation, file dedup and the schema check; `server.test.ts` the server views and comparison (synthetic data), `server-synthetic.test.ts` hand-written FIT files with the expected Gadgetbridge rows (band on Tokyo time), `server-format.test.ts` the conversion against a real export (`GB_EXPORT`).

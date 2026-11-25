/**
 * The comparison cache: every participant's daily facts from the data copy in use, rebuilt when a
 * new copy arrives (DataSource.version), in a worker thread. Until the new cache is ready the
 * answers keep coming from the previous one, then it is swapped in one step. Only aggregates ever
 * leave it (core's FactsComparisonSource).
 */
import { Worker } from "node:worker_threads";
import { FactsComparisonSource } from "@bridge/core/comparison/facts";
import type { AppId } from "@bridge/core/datasets";
import type { DataSource } from "../data-source";
import type { Logger } from "../log";
import { buildFacts, type BuildResult, type BuildStats } from "./build";
import type { BuildRequest } from "./worker";

export type Builder = (file: string, app: AppId, nowSec: number) => Promise<BuildResult>;

/** Builds in the main thread (tests, or when a worker cannot start). */
export const inlineBuilder: Builder = (file, app, nowSec) => buildFacts(file, app, nowSec);

/**
 * Builds in a worker thread. The worker is src/comparison/worker.ts when running from the sources
 * (tsx), dist/comparison-worker.js next to dist/server.js after the build.
 */
export function workerBuilder(log: Logger): Builder {
  const fromSources = import.meta.url.endsWith(".ts");
  const url = new URL(fromSources ? "./worker.ts" : "./comparison-worker.js", import.meta.url);
  return (file, app, nowSec) =>
    new Promise<BuildResult>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        log.warn("Il calcolo del confronto non può usare un worker: lo faccio nel processo principale", { error: e });
        inlineBuilder(file, app, nowSec).then(resolve, reject);
        return;
      }
      worker.once("message", (m: { ok: true; result: BuildResult } | { ok: false; error: string }) => {
        void worker.terminate();
        if (m.ok) resolve(m.result);
        else reject(new Error(m.error));
      });
      worker.once("error", reject);
      worker.postMessage({ file, app, nowSec } satisfies BuildRequest);
    });
}

export interface ComparisonStatus {
  /** version of the data copy the cache was built from */
  version: number | null;
  /** when that copy was taken (ms) */
  dataTakenAt: number | null;
  builtAt: number | null;
  building: boolean;
  stats: BuildStats | null;
  lastError: string | null;
  minParticipants: number;
}

export class ComparisonService {
  private current: { version: number; dataTakenAt: number; builtAt: number; source: FactsComparisonSource; stats: BuildStats } | null = null;
  private building: { version: number; promise: Promise<void> } | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;

  constructor(
    private data: DataSource,
    private app: AppId,
    private opts: { minParticipants: number; builder: Builder; log: Logger; now?: () => number },
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** first cache now, then a check of the data copy every minute */
  start() {
    void this.ensure();
    this.timer = setInterval(() => void this.ensure(), 60_000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Starts a rebuild when the data copy in use is not the cache's; one build at a time. Returns the
   * running build, if any.
   */
  ensure(): Promise<void> | null {
    let snap;
    try {
      snap = this.data.current();
    } catch {
      return null; // no data yet
    }
    if (this.building) return this.building.promise;
    if (this.current?.version === snap.version) return null;
    const { version, takenAt, file } = snap;
    const started = this.now();
    const promise = (async () => {
      try {
        const r = await this.opts.builder(file, this.app, Math.floor(started / 1000));
        // the swap: from here on every answer comes from the new cache
        this.current = {
          version,
          dataTakenAt: takenAt,
          builtAt: this.now(),
          source: new FactsComparisonSource(r.people, () => Math.floor(this.now() / 1000), this.opts.minParticipants),
          stats: r.stats,
        };
        this.lastError = null;
        this.opts.log.info("Confronto ricalcolato", { version, ...r.stats });
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.opts.log.error("Calcolo del confronto non riuscito: resta in uso quello precedente", { version, error: e });
      } finally {
        this.building = null;
      }
      // a newer copy may have arrived meanwhile
      if (this.current?.version !== this.data.current().version && !this.lastError) await this.ensure();
    })();
    this.building = { version, promise };
    return promise;
  }

  /**
   * The cache to answer with: the current one even while a newer one is being built; only when
   * there is none yet (just started) it waits for the first.
   */
  async source(): Promise<FactsComparisonSource | null> {
    const running = this.ensure();
    if (!this.current && running) await running;
    return this.current?.source ?? null;
  }

  status(): ComparisonStatus {
    return {
      version: this.current?.version ?? null,
      dataTakenAt: this.current?.dataTakenAt ?? null,
      builtAt: this.current?.builtAt ?? null,
      building: !!this.building,
      stats: this.current?.stats ?? null,
      lastError: this.lastError,
      minParticipants: this.opts.minParticipants,
    };
  }
}

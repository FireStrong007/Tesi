/**
 * Worker thread: builds the participants' daily facts (build.ts) away from the server's main
 * thread, which keeps answering with the previous cache. One worker per build: its memory goes
 * away with it.
 */
import { parentPort } from "node:worker_threads";
import type { AppId } from "@bridge/core/datasets";
import { buildFacts } from "./build";

export interface BuildRequest {
  file: string;
  app: AppId;
  nowSec: number;
}

parentPort?.once("message", async (req: BuildRequest) => {
  try {
    parentPort!.postMessage({ ok: true, result: await buildFacts(req.file, req.app, req.nowSec) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

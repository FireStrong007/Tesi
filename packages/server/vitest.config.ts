import { defineProject } from "vitest/config";

export default defineProject({
  // the study's time zone: the same days locally and in CI; the hooks build synthetic databases
  // (slow on a busy machine): 60 s
  test: { name: "server", environment: "node", testTimeout: 30_000, hookTimeout: 60_000, include: ["tests/**/*.test.ts"], env: { TZ: "Europe/Rome" } },
});

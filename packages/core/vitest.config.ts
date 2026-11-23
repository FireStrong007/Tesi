import { defineProject } from "vitest/config";

export default defineProject({
  // the study's time zone (src/time-zone.ts): the same days locally and in CI
  test: { name: "core", environment: "node", include: ["tests/**/*.test.ts"], env: { TZ: "Europe/Rome" } },
});

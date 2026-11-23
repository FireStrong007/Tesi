import { defineProject } from "vitest/config";

export default defineProject({
  // the study's time zone: the same days locally and in CI
  test: { name: "server", environment: "node", include: ["tests/**/*.test.ts"], env: { TZ: "Europe/Rome" } },
});

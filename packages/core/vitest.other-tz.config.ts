import { defineProject } from "vitest/config";

// the calendar must not depend on the process's zone: the same tests in New York
export default defineProject({
  test: { name: "core (TZ New York)", environment: "node", include: ["tests/time-zone.test.ts"], env: { TZ: "America/New_York" } },
});

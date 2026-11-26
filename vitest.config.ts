import { defineConfig } from "vitest/config";

// every workspace runs its own tests with its own config (aliases, time zone); the global setup
// checks once for the whole run that data/ is unchanged (vitest.global-setup.ts)
export default defineConfig({
  test: {
    projects: ["packages/core", "packages/core/vitest.other-tz.config.ts", "packages/synth", "packages/server", "apps/web"],
    globalSetup: ["./vitest.global-setup.ts"],
  },
});

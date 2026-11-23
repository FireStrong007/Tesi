import { defineConfig } from "vitest/config";

// every workspace runs its own tests with its own config (aliases, time zone)
export default defineConfig({ test: { projects: ["packages/core", "packages/synth", "packages/server", "apps/web"] } });

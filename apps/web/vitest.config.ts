import path from "node:path";
import { defineProject } from "vitest/config";

// the web app's pure modules (no DOM): what each app shows (brand.ts, lib/)
export default defineProject({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: { name: "web", environment: "node", include: ["tests/**/*.test.ts"] },
});

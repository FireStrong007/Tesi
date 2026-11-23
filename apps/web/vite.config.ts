/// <reference types="vitest/config" />
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // relative paths: the build works at any address (e.g. https://<user>.github.io/vitabridge/)
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // sqlite-wasm loads its .wasm via import.meta.url: it must not be pre-bundled
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  // the API is our Node server (packages/server): same origin in development too, so cookies work without CORS
  server: { host: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}` } } },
  preview: { proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}` } } },
  // the study's time zone (src/lib/time-zone.ts): the same days locally and in CI
  test: { name: "web", environment: "node", include: ["tests/**/*.test.ts"], env: { TZ: "Europe/Rome" } },
});

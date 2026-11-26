import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

type AppId = "vitabridge" | "heartbridge";
const TITLE: Record<AppId, { name: string; themeColor: string }> = {
  vitabridge: { name: "VitaBridge", themeColor: "#0f766e" },
  heartbridge: { name: "HeartBridge", themeColor: "#cf5539" },
};

/**
 * The app's icon and manifest (brands/<app>/), its name and colour in index.html and
 * data-brand on <html> (index.css picks the palette before any script runs).
 */
function brandAssets(app: AppId): Plugin {
  const dir = path.resolve(__dirname, "brands", app);
  const files: Record<string, string> = { "icon.svg": "image/svg+xml", "manifest.webmanifest": "application/manifest+json" };
  return {
    name: "bridge-brand",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].replace(/^\//, "") ?? "";
        if (!(name in files)) return next();
        res.setHeader("Content-Type", files[name]);
        res.end(readFileSync(path.join(dir, name)));
      });
    },
    generateBundle() {
      for (const name of Object.keys(files)) this.emitFile({ type: "asset", fileName: name, source: readFileSync(path.join(dir, name)) });
    },
    transformIndexHtml: (html) =>
      html
        .replace('<html lang="it">', `<html lang="it" data-brand="${app}">`)
        .replace(/<title>.*<\/title>/, `<title>${TITLE[app].name}</title>`)
        .replace(/<meta name="theme-color" content="[^"]*" \/>/, `<meta name="theme-color" content="${TITLE[app].themeColor}" />`),
  };
}

// the app is chosen with --mode heartbridge (or VITE_APP): name, colours, icon, sections (src/brand.ts)
export default defineConfig(({ mode }) => {
  const app: AppId = mode === "heartbridge" || process.env.VITE_APP === "heartbridge" ? "heartbridge" : "vitabridge";
  return {
    // relative paths: the build works at any address
    base: "./",
    plugins: [react(), tailwindcss(), brandAssets(app)],
    define: { "import.meta.env.VITE_APP": JSON.stringify(app) },
    resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
    // sqlite-wasm loads its .wasm via import.meta.url: it must not be pre-bundled
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    worker: { format: "es" as const },
    build: { outDir: app === "heartbridge" ? "dist-heartbridge" : "dist" },
    // the API is our Node server (packages/server): same origin in development too, so cookies work without CORS
    server: { host: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}` } } },
    preview: { proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}` } } },
  };
});

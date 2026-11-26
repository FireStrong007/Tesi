// npm run dev: the API server (packages/server, port 8787) and the web app (Vite, port 5173) together.
// npm run dev:heartbridge (--app heartbridge): HeartBridge on 8788 / 5174 with data/synthetic-gima.db
// (HEARTBRIDGE_DATA_FILE for another file), so both apps can run side by side.
// The server reads its settings from .env at the repository root (see .env.example); what is set
// here wins over .env (Node's loadEnvFile does not override existing variables).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env") && !process.env.DATA_FILE) console.warn("[dev] Manca il file .env: copia .env.example in .env e imposta ADMIN_PASSWORD (e DATA_FILE).");
// npm's own script, run with this Node: no shell in between (arguments are passed as they are)
const npmCli = process.env.npm_execpath;
const args = process.argv.slice(2);
const appAt = args.indexOf("--app");
const app = appAt >= 0 ? args.splice(appAt, 2)[1] : "vitabridge";
const viteArgs = [...args];
if (app === "heartbridge") {
  Object.assign(process.env, {
    APP: "heartbridge",
    PORT: "8788",
    API_PORT: "8788",
    PUBLIC_ORIGIN: "http://localhost:5174",
    DATA_MODE: "file",
    DATA_FILE: process.env.HEARTBRIDGE_DATA_FILE ?? "data/synthetic-gima.db",
  });
  viteArgs.unshift("--mode", "heartbridge", "--port", "5174");
} else if (app !== "vitabridge") {
  console.error("[dev] --app deve essere vitabridge o heartbridge");
  process.exit(2);
}
const run = (args) => (npmCli ? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "pipe", "pipe"] }) : spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] }));
const children = [
  ["server", ["run", "dev", "-w", "@bridge/server"]],
  ["web", ["run", "dev", "-w", "@bridge/web", "--", ...viteArgs]],
].map(([name, args]) => {
  const child = run(args);
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join("\n") + "\n";
  child.stdout.on("data", (c) => process.stdout.write(prefix(c)));
  child.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  child.on("exit", (code) => {
    console.log(`[${name}] terminato (${code})`);
    stop();
  });
  return child;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * Starts the server: configuration from the environment (in development also from the .env file
 * at the repository root), the first administrator, the data source, the HTTP API.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { DATASETS } from "@bridge/core/datasets";
import { createApp, ensureFirstAdmin } from "./app";
import { LoginLimiter } from "./auth/limiter";
import { AuthStore } from "./auth/store";
import { ConfigError, configSecrets, describeConfig, loadConfig } from "./config";
import { createDataSource } from "./data-source";
import { createLogger } from "./log";

// npm run dev from the repository root: paths in .env are relative to it
const base = process.env.INIT_CWD ?? process.cwd();
const envFile = resolve(base, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const bootLog = createLogger();
let config;
try {
  config = loadConfig(process.env, base);
} catch (e) {
  if (e instanceof ConfigError) {
    bootLog.error(`Configurazione non valida: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const log = createLogger({ secrets: configSecrets(config) });
log.info("Avvio", describeConfig(config));

const auth = new AuthStore(config.authDb, config.sessionIdleMs);
await ensureFirstAdmin(auth, config, log);
const data = createDataSource(config.data, DATASETS[config.app], log);
await data.start();
const limiter = new LoginLimiter(config.login.maxFailures, config.login.windowMs);
const app = createApp({ config, auth, data, limiter, log });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => log.info(`In ascolto su http://${info.address}:${info.port}`));

const stop = () => {
  log.info("Arresto");
  server.close();
  data.close();
  auth.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

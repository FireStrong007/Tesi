/**
 * Administrator accounts are managed only from the server's command line, never from the web:
 *   npm run admin:create -- <nome>          a new administrator
 *   npm run admin:reset-password -- <nome>  a new temporary password (any account)
 *   npm run admin:accept-source             the accounts database accepts the data source now
 *                                           configured (the same data moved elsewhere)
 * The first two print a temporary password once (it must be changed at the first login). Every
 * command records the action in audit_log with the author "cli:<operating system user>". They read
 * APP / AUTH_DB / DATA_* from the environment or the .env file at the repository root, like the
 * server; they can run while the server is running (the accounts database is in WAL mode).
 */
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { hashPassword, temporaryPassword } from "./auth/passwords";
import { AuthStore, USERNAME_RE, normalizeUsername } from "./auth/store";
import { ConfigError, loadAuthConfig } from "./config";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** the author recorded in audit_log for commands run on the server */
export function cliActor() {
  let user = "sconosciuto";
  try {
    user = userInfo().username || user;
  } catch {
    /* no user information (some containers) */
  }
  return { id: null, username: `cli:${user}` };
}

const USAGE = "Uso: npm run admin:create -- <nome>  |  npm run admin:reset-password -- <nome>  |  npm run admin:accept-source";

/** Runs one command; returns the process exit code. */
export async function runAdminCommand(args: string[], env: NodeJS.ProcessEnv, baseDir: string, io: CliIo, now: () => number = Date.now): Promise<number> {
  const [command, rawName, ...rest] = args;
  const named = ["create", "reset-password"].includes(command);
  if (!command || rest.length || (named ? !rawName : command !== "accept-source" || rawName)) {
    io.err(USAGE);
    return 2;
  }
  let cfg;
  try {
    cfg = loadAuthConfig(env, baseDir);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`Configurazione non valida: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const auth = new AuthStore(cfg.authDb, cfg.sessionIdleMs, now);
  try {
    const actor = cliActor();
    if (command === "accept-source") {
      const before = auth.source();
      if (before?.fingerprint === cfg.source.fingerprint) {
        io.out(`Il database degli account (${cfg.authDb}) è già legato a questa sorgente: ${cfg.source.description}.`);
        return 0;
      }
      auth.acceptSource(cfg.source, actor);
      io.out(`Database degli account: ${cfg.authDb}`);
      io.out(`Sorgente precedente: ${before?.description ?? "nessuna"}`);
      io.out(`Sorgente accettata: ${cfg.source.description}`);
      io.out("Al prossimo uso ogni account viene controllato sui nuovi dati: quelli con numero e codice corrispondenti tornano attivi da soli, gli altri restano «da verificare».");
      return 0;
    }
    const username = normalizeUsername(rawName);
    const temp = temporaryPassword();
    const existing = auth.credentials(username);
    if (command === "create") {
      if (!USERNAME_RE.test(username)) {
        io.err("Il nome deve avere 3–40 caratteri: lettere minuscole, cifre, punto, trattino o trattino basso.");
        return 1;
      }
      if (existing) {
        io.err(`Esiste già un account «${username}». Per una nuova password: npm run admin:reset-password -- ${username}`);
        return 1;
      }
      const account = auth.create({ username, passwordHash: await hashPassword(temp), role: "admin", participant: null, mustChangePassword: true });
      auth.audit(actor, "account_created", account);
      io.out(`Amministratore «${account.username}» creato (database degli account: ${cfg.authDb}).`);
    } else {
      if (!existing) {
        io.err(`Nessun account «${username}» in ${cfg.authDb}.`);
        return 1;
      }
      const account = auth.get(existing.id)!;
      auth.setPassword(account.id, await hashPassword(temp), true);
      auth.endSessionsOf(account.id);
      auth.audit(actor, "password_reset", account);
      io.out(`Password di «${account.username}» (${account.role === "admin" ? "amministratore" : "partecipante"}) reimpostata; le sessioni aperte sono state chiuse.`);
      if (account.disabled) io.out("Attenzione: l'account è disattivato. Riattivalo dall'area amministratore per poter accedere.");
    }
    io.out(`Password temporanea: ${temp}`);
    io.out("Viene mostrata solo ora. Al primo accesso andrà cambiata.");
    return 0;
  } finally {
    auth.close();
  }
}

// run directly (npm run admin:..., or node dist/admin.js after the build): the same .env and base folder as the server
if (process.argv[1] && /admin(-cli)?\.[cm]?[jt]s$/.test(process.argv[1])) {
  const base = process.env.INIT_CWD ?? process.cwd();
  const envFile = resolve(base, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const code = await runAdminCommand(process.argv.slice(2), process.env, base, { out: (l) => console.log(l), err: (l) => console.error(l) });
  process.exit(code);
}

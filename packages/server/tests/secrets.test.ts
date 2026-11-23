/**
 * Passwords, session tokens, cookies, CSRF tokens and the backup credentials never appear in the
 * log nor in an error answer. A whole session of use is run and everything is collected.
 */
import { describe, expect, it } from "vitest";
import { configSecrets, describeConfig, loadConfig } from "../src/config";
import type { DataSource } from "../src/data-source";
import { HIDDEN, createLogger } from "../src/log";
import { ADMIN, participantClients, tempDir, testServer, type Client } from "./helpers";

const dir = tempDir();

/** session tokens seen in Set-Cookie headers */
const tokensOf = (clients: Client[]) =>
  clients.flatMap((c) => c.seen.map((r) => r.headers.get("set-cookie")?.split(";")[0].split("=")[1]).filter((v): v is string => !!v));

describe("secrets never reach the log or error answers", () => {
  it("over a whole session of use", async () => {
    const s = await testServer({ dir });
    const { admin, participants } = await participantClients(s, ["SYN-G01", "SYN-G02"]);
    const p = participants.get("SYN-G01")!;
    const secrets = [ADMIN.password, ...[...participants.values()].map((x) => x.password)];

    // temporary passwords: creation and reset
    const accountId = s.auth.list().find((a) => a.participantId === participants.get("SYN-G02")!.participantId)!.id;
    const reset = await admin.post<{ temporaryPassword: string }>(`/api/admin/accounts/${accountId}/reset-password`);
    secrets.push(reset.body.temporaryPassword);

    // failures that are logged or answered with an error
    const intruder = s.client();
    await intruder.login("syn-g01", "Nuova-password-SYN-G0"); // almost right
    await intruder.login(ADMIN.password, ADMIN.password); // password typed in the username field
    await p.client.post("/api/auth/password", { currentPassword: "sbagliata", newPassword: p.password });
    await p.client.post("/api/auth/password", { currentPassword: p.password, newPassword: "corta" });
    await p.client.req("POST", "/api/data/refresh", {}, { "x-csrf-token": "falso" });
    await s.client({ origin: "https://evil.example" }).login("admin", ADMIN.password);
    await admin.post("/api/admin/accounts", { participantId: "1; DROP TABLE account" });
    secrets.push("Nuova-password-SYN-G0", "sbagliata", "falso");

    const clients = [admin, intruder, p.client, ...[...participants.values()].map((x) => x.client)];
    const tokens = tokensOf(clients);
    const csrf = clients.map((c) => c.csrf).filter((v): v is string => !!v);
    expect(tokens.length).toBeGreaterThan(3);

    const log = s.logs.join("\n");
    const errors = clients.flatMap((c) => c.seen.filter((r) => r.status >= 400).map((r) => r.text)).join("\n");
    expect(errors.length).toBeGreaterThan(0);
    for (const v of [...secrets, ...tokens, ...csrf]) {
      expect(log).not.toContain(v);
      expect(errors).not.toContain(v);
    }
    // what is logged: who and what, not how
    expect(log).toContain("Accesso non riuscito");
    expect(log).toContain("Password reimpostata");
  });

  it("an unexpected error answers with a generic message and the log hides the configured secrets", async () => {
    const lines: string[] = [];
    const config = loadConfig({
      PUBLIC_ORIGIN: "https://studio.example.org",
      DATA_MODE: "backup",
      BACKUP_URL: "https://server.example.org/admin/backup",
      BACKUP_USERNAME: "amministratore",
      BACKUP_PASSWORD: "PasswordDelBackup!42",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: ADMIN.password,
    });
    const basic = Buffer.from("amministratore:PasswordDelBackup!42").toString("base64");
    const log = createLogger({ secrets: configSecrets(config), sink: (l) => lines.push(l) });
    // the startup summary has no secrets
    log.info("Avvio", describeConfig(config));
    // a failure whose message contains the credentials (e.g. a library echoing a header)
    const broken: DataSource = {
      current: () => {
        throw new Error(`Authorization: Basic ${basic} rifiutata per PasswordDelBackup!42`);
      },
      refresh: async () => ({ updated: false }),
      status: () => ({ mode: "backup", takenAt: null, version: 0, lastAttemptAt: null, lastError: null, refreshing: false }),
      start: async () => {},
      close: () => {},
    };
    const s = await testServer({ dir, data: broken });
    const { createApp } = await import("../src/app");
    const app = createApp({ config: s.config, auth: s.auth, data: broken, limiter: new (await import("../src/auth/limiter")).LoginLimiter(5, 60_000), log });
    const admin = s.client();
    await admin.login("admin", ADMIN.password);
    const res = await app.request("/api/admin/participants", { headers: { cookie: admin.cookie! } });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: "Errore interno del server." }));
    const all = lines.join("\n");
    expect(all).toContain("Errore interno");
    expect(all).toContain(HIDDEN);
    for (const v of ["PasswordDelBackup!42", basic, ADMIN.password]) {
      expect(all).not.toContain(v);
      expect(body).not.toContain(v);
    }
    // fields named like secrets are hidden whatever their value
    log.info("prova", { password: "abc-1234", nested: { sessionToken: "xyz-9876", cookie: "k=v" } });
    expect(lines[lines.length - 1]).not.toMatch(/abc-1234|xyz-9876|k=v/);
  });
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdminCommand } from "../src/admin-cli";
import { ADMIN, tempDir, testServer } from "./helpers";

const dir = tempDir();

/** runs a command against the server's accounts database and collects what it prints */
async function cli(authDb: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCommand(args, { AUTH_DB: authDb }, dir, { out: (l) => out.push(l), err: (l) => err.push(l) });
  const password = out.map((l) => /^Password temporanea: (\S+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  return { code, out, err, password };
}

describe("administrator commands on the server", () => {
  it("admin:create makes an administrator with a temporary password to change at the first login", async () => {
    const s = await testServer({ dir });
    const r = await cli(s.config.authDb, "create", "Seconda.Admin");
    expect(r.code).toBe(0);
    expect(r.password).toMatch(/^[A-Za-z2-9]{12}$/);
    // printed once, never again
    expect(r.out.filter((l) => l.includes(r.password!)).length).toBe(1);

    const c = s.client();
    const login = await c.login("seconda.admin", r.password!);
    expect(login.body.account).toEqual({ username: "seconda.admin", role: "admin", mustChangePassword: true });
    expect((await c.get("/api/admin/participants")).body).toMatchObject({ code: "password_change_required" });
    await c.post("/api/auth/password", { currentPassword: r.password, newPassword: "Una-password-nuova" });
    expect((await c.get("/api/admin/participants")).status).toBe(200);

    // the action is in the audit log, with the operating system user as author
    const log = await c.get<{ entries: { actorUsername: string; action: string; targetUsername: string }[] }>("/api/admin/audit");
    expect(log.body.entries[0]).toMatchObject({ action: "account_created", targetUsername: "seconda.admin" });
    expect(log.body.entries[0].actorUsername).toMatch(/^cli:/);
  });

  it("refuses an existing or invalid name and wrong usage", async () => {
    const s = await testServer({ dir });
    expect((await cli(s.config.authDb, "create", "admin")).err[0]).toMatch(/Esiste già/);
    expect((await cli(s.config.authDb, "create", "a")).code).toBe(1);
    expect((await cli(s.config.authDb, "create")).code).toBe(2);
    expect((await cli(s.config.authDb, "delete", "admin")).code).toBe(2);
    expect((await cli(s.config.authDb, "reset-password", "nessuno")).err[0]).toMatch(/Nessun account/);
  });

  it("admin:reset-password recovers an administrator: old password and sessions stop working, the change is forced", async () => {
    const s = await testServer({ dir });
    const open = s.client();
    await open.login(ADMIN.username, ADMIN.password);
    const r = await cli(s.config.authDb, "reset-password", "ADMIN");
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/amministratore/);
    expect((await open.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
    expect((await s.client().login(ADMIN.username, ADMIN.password)).status).toBe(401);
    const c = s.client();
    expect((await c.login(ADMIN.username, r.password!)).body.account.mustChangePassword).toBe(true);
    await c.post("/api/auth/password", { currentPassword: r.password, newPassword: "Recuperata-dal-server" });
    const log = await c.get<{ entries: { actorUsername: string; action: string; targetUsername: string }[] }>("/api/admin/audit");
    expect(log.body.entries[0]).toMatchObject({ action: "password_reset", targetUsername: "admin" });
    expect(log.body.entries[0].actorUsername).toMatch(/^cli:/);
    // the temporary password is not stored or logged anywhere
    expect(s.logs.join("\n")).not.toContain(r.password);
    expect(JSON.stringify(log.body)).not.toContain(r.password);
  });

  it("reads AUTH_DB relative to the repository root, like the server", async () => {
    const out: string[] = [];
    const code = await runAdminCommand(["create", "terzo"], { AUTH_DB: "auth-relativo.db" }, dir, { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toContain(join(dir, "auth-relativo.db"));
  });
});

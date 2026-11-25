import { describe, expect, it } from "vitest";
import { ensureFirstAdmin } from "../src/app";
import { createLogger } from "../src/log";
import { ADMIN, ORIGIN, participantClients, tempDir, testServer, type ParticipantRow } from "./helpers";

const dir = tempDir();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("first administrator", () => {
  it("is created from ADMIN_USERNAME / ADMIN_PASSWORD once, without a forced password change", async () => {
    const s = await testServer({ dir });
    const r = await s.client().login("ADMIN ", ADMIN.password); // username: no case, no spaces around
    expect(r.status).toBe(200);
    expect(r.body.account).toEqual({ username: "admin", role: "admin", mustChangePassword: false });
    // a second start does not create another one nor change the password
    await ensureFirstAdmin(s.auth, { ...s.config, admin: { username: "altro", password: "Un'altra-password" } }, createLogger({ sink: () => {} }));
    expect(s.auth.countAdmins()).toBe(1);
  });

  it("refuses a weak ADMIN_PASSWORD", async () => {
    await expect(testServer({ dir, env: { ADMIN_PASSWORD: "corta" } })).rejects.toThrow(/almeno 10 caratteri/);
  });
});

describe("login and sessions", () => {
  it("sets an HttpOnly, SameSite=Strict cookie; Secure with the __Host- prefix on https", async () => {
    const s = await testServer({ dir });
    const r = await s.client().login(ADMIN.username, ADMIN.password);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-bridge_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=28800/); // 8 hours for administrators
    const http = await testServer({ dir, env: { PUBLIC_ORIGIN: "http://localhost:5173" } });
    const c = http.client({ origin: "http://localhost:5173" });
    const cookie2 = (await c.login(ADMIN.username, ADMIN.password)).headers.get("set-cookie")!;
    expect(cookie2).toMatch(/^bridge_session=/);
    expect(cookie2).not.toMatch(/Secure/);
  });

  it("answers the same for a wrong password and an unknown username", async () => {
    const s = await testServer({ dir });
    const a = await s.client().login(ADMIN.username, "sbagliata-123");
    const b = await s.client().login("nessuno", "sbagliata-123");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it("limits failed logins per username (and lets the right password in after the window)", async () => {
    const s = await testServer({ dir });
    for (let i = 0; i < 5; i++) expect((await s.client().login(ADMIN.username, `sbagliata-${i}`)).status).toBe(401);
    const blocked = await s.client().login(ADMIN.username, ADMIN.password);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    s.clock.t += 16 * 60_000;
    expect((await s.client().login(ADMIN.username, ADMIN.password)).status).toBe(200);
  });

  it("limits failed logins per IP: X-Forwarded-For only with TRUST_PROXY", async () => {
    const proxied = await testServer({ dir, env: { TRUST_PROXY: "true" } });
    for (let i = 0; i < 5; i++) await proxied.client({ ip: "203.0.113.7" }).login(`utente${i}`, "sbagliata-123");
    expect((await proxied.client({ ip: "203.0.113.7" }).login(ADMIN.username, ADMIN.password)).status).toBe(429);
    // another client behind the same proxy is not blocked; the last address is the one the proxy saw
    expect((await proxied.client({ ip: "203.0.113.7, 198.51.100.2" }).login(ADMIN.username, ADMIN.password)).status).toBe(200);

    const direct = await testServer({ dir });
    // without TRUST_PROXY a forged X-Forwarded-For does not give a fresh address
    for (let i = 0; i < 5; i++) await direct.client({ ip: `198.51.100.${i}` }).login(`utente${i}`, "sbagliata-123");
    expect((await direct.client({ ip: "192.0.2.99" }).login(ADMIN.username, ADMIN.password)).status).toBe(429);
  });

  it("ends a session after the role's inactivity limit: 8 hours for administrators, 30 days for participants", async () => {
    const s = await testServer({ dir });
    const { admin, participants } = await participantClients(s, ["SYN-G01"]);
    const p = participants.get("SYN-G01")!.client;
    s.clock.t += 7 * HOUR;
    expect((await admin.get<{ account: unknown }>("/api/auth/me")).body.account).not.toBeNull(); // used: renewed
    s.clock.t += 7 * HOUR;
    expect((await admin.get<{ account: unknown }>("/api/auth/me")).body.account).not.toBeNull();
    s.clock.t += 8 * HOUR + 1000;
    expect((await admin.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
    // the participant was idle for 22 hours: still in
    expect((await p.get<{ account: unknown }>("/api/auth/me")).body.account).not.toBeNull();
    s.clock.t += 29 * DAY;
    expect((await p.get<{ account: unknown }>("/api/auth/me")).body.account).not.toBeNull();
    s.clock.t += 30 * DAY + 1000;
    expect((await p.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
  });

  it("takes the inactivity limits from the configuration", async () => {
    const s = await testServer({ dir, env: { SESSION_IDLE_HOURS_ADMIN: "1", SESSION_IDLE_DAYS_PARTICIPANT: "2" } });
    expect(s.config.sessionIdleMs).toEqual({ admin: HOUR, participant: 2 * DAY });
    const a = s.client();
    await a.login(ADMIN.username, ADMIN.password);
    s.clock.t += HOUR + 1000;
    expect((await a.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
  });

  it("logs out", async () => {
    const s = await testServer({ dir });
    const a = s.client();
    await a.login(ADMIN.username, ADMIN.password);
    const cookie = a.cookie;
    expect((await a.post("/api/auth/logout")).status).toBe(200);
    a.cookie = cookie; // the old cookie no longer works
    expect((await a.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
  });
});

describe("origin and CSRF", () => {
  it("refuses requests that change data from another origin or without the CSRF token", async () => {
    const s = await testServer({ dir });
    expect((await s.client({ origin: null }).login(ADMIN.username, ADMIN.password)).status).toBe(403);
    expect((await s.client({ origin: "https://evil.example" }).login(ADMIN.username, ADMIN.password)).status).toBe(403);
    const crossSite = await s.client().req("POST", "/api/auth/login", { username: ADMIN.username, password: ADMIN.password }, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);

    const a = s.client();
    await a.login(ADMIN.username, ADMIN.password);
    const { body } = await a.get<{ participants: ParticipantRow[] }>("/api/admin/participants");
    const named = { participantId: body.participants[0].id, code: body.participants[0].code };
    expect((await a.req("POST", "/api/admin/accounts", named, { "x-csrf-token": "sbagliato" })).status).toBe(403);
    const noToken = s.client();
    noToken.cookie = a.cookie;
    expect((await noToken.post("/api/admin/accounts", named)).status).toBe(403);
    expect((await a.post("/api/admin/accounts", named)).status).toBe(201);
  });
});

describe("accounts of participants", () => {
  it("shows the temporary password once and forces a change at the first login", async () => {
    const s = await testServer({ dir });
    const admin = s.client();
    await admin.login(ADMIN.username, ADMIN.password);
    const list = await admin.get<{ participants: ParticipantRow[] }>("/api/admin/participants");
    const p = list.body.participants.find((x) => x.code === "SYN-G02")!;
    expect(p.account).toBeNull();
    expect(p.suggestedUsername).toBe("syn-g02");
    const created = await admin.post<{ temporaryPassword: string; account: { username: string } }>("/api/admin/accounts", { participantId: p.id, code: p.code });
    expect(created.status).toBe(201);
    const temp = created.body.temporaryPassword;
    expect(temp).toMatch(/^[A-Za-z2-9]{12}$/);
    // never again: not in the list, not in the audit log, not in the status
    for (const path of ["/api/admin/participants", "/api/admin/audit", "/api/admin/status"]) expect((await admin.get(path)).text).not.toContain(temp);
    expect((await admin.post("/api/admin/accounts", { participantId: p.id, code: p.code })).status).toBe(409);

    const user = s.client();
    const first = await user.login("syn-g02", temp);
    expect(first.body.account.mustChangePassword).toBe(true);
    expect((await user.get("/api/data/tables")).body).toMatchObject({ code: "password_change_required" });
    expect((await user.post("/api/auth/password", { currentPassword: "sbagliata", newPassword: "Una-password-lunga" })).status).toBe(400);
    expect((await user.post("/api/auth/password", { currentPassword: temp, newPassword: "corta" })).body).toMatchObject({ code: "weak_password" });
    const oldCookie = user.cookie;
    const changed = await user.post<{ account: { mustChangePassword: boolean } }>("/api/auth/password", { currentPassword: temp, newPassword: "Una-password-lunga" });
    expect(changed.status).toBe(200);
    expect(changed.body.account.mustChangePassword).toBe(false);
    expect(user.cookie).not.toBe(oldCookie); // a new session
    expect((await user.get("/api/data/tables")).status).toBe(200);
    const old = s.client();
    old.cookie = oldCookie;
    expect((await old.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
    // the temporary password no longer works
    expect((await s.client().login("syn-g02", temp)).status).toBe(401);
  });

  it("resets the password (new temporary one, sessions closed), disables and enables an account", async () => {
    const s = await testServer({ dir });
    const { admin, participants } = await participantClients(s, ["SYN-G03"]);
    const p = participants.get("SYN-G03")!;
    const accountId = s.auth.list().find((a) => a.participantId === p.participantId)!.id;

    const reset = await admin.post<{ temporaryPassword: string }>(`/api/admin/accounts/${accountId}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await p.client.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull();
    expect((await s.client().login("syn-g03", p.password)).status).toBe(401);
    const again = s.client();
    expect((await again.login("syn-g03", reset.body.temporaryPassword)).body.account.mustChangePassword).toBe(true);

    expect((await admin.post(`/api/admin/accounts/${accountId}/disable`)).status).toBe(200);
    expect((await again.get<{ account: unknown }>("/api/auth/me")).body.account).toBeNull(); // the open session ends at once
    const refused = await s.client().login("syn-g03", reset.body.temporaryPassword);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "disabled" });
    expect((await admin.post(`/api/admin/accounts/${accountId}/enable`)).status).toBe(200);
    expect((await s.client().login("syn-g03", reset.body.temporaryPassword)).status).toBe(200);

    // administrator accounts are not managed from here
    const adminId = s.auth.list().find((a) => a.role === "admin")!.id;
    expect((await admin.post(`/api/admin/accounts/${adminId}/disable`)).status).toBe(403);
  });

  it("records the administrator's actions in the audit log, shown only to administrators", async () => {
    const s = await testServer({ dir });
    const { admin, participants } = await participantClients(s, ["SYN-G04", "SYN-G05"]);
    const accountId = s.auth.list().find((a) => a.participantId === participants.get("SYN-G04")!.participantId)!.id;
    s.clock.t += 1000;
    await admin.post(`/api/admin/accounts/${accountId}/reset-password`);
    s.clock.t += 1000;
    await admin.post(`/api/admin/accounts/${accountId}/disable`);
    s.clock.t += 1000;
    await admin.post(`/api/admin/accounts/${accountId}/enable`);
    // a refused action is not recorded
    await admin.post(`/api/admin/accounts/999999/disable`);

    const log = await admin.get<{ entries: { at: number; actorUsername: string; action: string; targetUsername: string; participantId: number }[] }>("/api/admin/audit");
    expect(log.status).toBe(200);
    const mine = log.body.entries.filter((e) => e.targetUsername === "syn-g04");
    expect(mine.map((e) => e.action)).toEqual(["account_enabled", "account_disabled", "password_reset", "account_created"]);
    for (const e of mine) {
      expect(e.actorUsername).toBe("admin");
      expect(e.targetUsername).toBe("syn-g04");
      expect(e.participantId).toBe(participants.get("SYN-G04")!.participantId);
    }
    expect(mine[0].at - mine[3].at).toBe(3000);
    // participants never see it
    expect((await participants.get("SYN-G05")!.client.get("/api/admin/audit")).status).toBe(403);
  });
});

it("the configured origin is the only one accepted", async () => {
  const s = await testServer({ dir });
  expect(s.config.publicOrigin).toBe(ORIGIN);
});

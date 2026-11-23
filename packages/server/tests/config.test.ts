import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "../src/config";

const base = { DATA_MODE: "file", DATA_FILE: "data/x.db" };

describe("configuration", () => {
  it("has development defaults and requires PUBLIC_ORIGIN in production", () => {
    const c = loadConfig(base, "/srv");
    expect(c).toMatchObject({ app: "vitabridge", port: 8787, publicOrigin: "http://localhost:5173", trustProxy: false, secureCookies: false });
    expect(c.sessionIdleMs).toEqual({ participant: 30 * 86_400_000, admin: 8 * 3_600_000 });
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/PUBLIC_ORIGIN/);
  });

  it("checks PUBLIC_ORIGIN and TRUST_PROXY; https gives secure cookies", () => {
    const c = loadConfig({ ...base, PUBLIC_ORIGIN: "https://vitabridge.example.org", TRUST_PROXY: "true" });
    expect(c).toMatchObject({ publicOrigin: "https://vitabridge.example.org", trustProxy: true, secureCookies: true });
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: "https://vitabridge.example.org/app" })).toThrow(/senza percorso/);
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: "non un indirizzo" })).toThrow(/non è un indirizzo/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "forse" })).toThrow(/TRUST_PROXY/);
  });

  it("backup mode: credentials apart from the URL, intervals configurable, never in the summary", () => {
    const env = { DATA_MODE: "backup", BACKUP_URL: "https://server.example.org/admin/backup", BACKUP_USERNAME: "u", BACKUP_PASSWORD: "PasswordDelBackup", BACKUP_INTERVAL_MIN: "30", SYNC_REFRESH_MIN_AGE_MIN: "2" };
    const c = loadConfig(env, "/srv");
    expect(c.data).toMatchObject({ mode: "backup", intervalMin: 30, minAgeMin: 2 });
    expect(JSON.stringify(describeConfig(c))).not.toContain("PasswordDelBackup");
    expect(() => loadConfig({ ...env, BACKUP_URL: "https://u:p@server.example.org/admin/backup" })).toThrow(/credenziali/);
    expect(() => loadConfig({ ...env, BACKUP_PASSWORD: "" })).toThrow(/BACKUP_PASSWORD/);
    expect(() => loadConfig({ ...base, APP: "altro" })).toThrow(/APP/);
    expect(() => loadConfig({ ...base, ADMIN_USERNAME: "admin" })).toThrow(/insieme/);
  });
});

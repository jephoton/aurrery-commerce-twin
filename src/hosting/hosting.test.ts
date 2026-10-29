import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { hostedConfig } from "./config";
import { createHostingStore, limitsFor } from "./store";

const secret = "s".repeat(48);
const password = "correct-horse-battery-staple-and-more";
const remote = { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "private-token" };
const env = { RENDER: "true", APP_URL: "https://example.test", ADMIN_PASSWORD: password, HOSTED_SECRET: secret, ...remote };
describe("hosted configuration", () => {
  it("keeps local workflow when hosted flags are absent, even with remote credentials", () => {
    expect(hostedConfig({})).toEqual({ hosted: false });
    expect(hostedConfig(remote)).toEqual({ hosted: false });
  });
  it("forces Render to use Turso, rejects partial settings, and accepts its trusted URL fallback", () => {
    for (const invalid of [
      { ...env, ADMIN_PASSWORD: "short" }, { ...env, APP_URL: "http://example.test" },
      { ...env, LEDGER_BACKEND: "sqlite" }, { ...env, LEDGER_PATH: "/var/data/ledger.sqlite" },
      { ...env, TURSO_AUTH_TOKEN: undefined }, { ...env, TURSO_DATABASE_URL: undefined },
      { ...env, TURSO_DATABASE_URL: "https://attacker.example" },
      { ...env, APP_URL: undefined, RENDER_EXTERNAL_URL: "http://example.test" },
    ]) expect(() => hostedConfig(invalid)).toThrow();
    expect(hostedConfig({ ...env, HOSTED_DEMO: "false" })).toMatchObject({ hosted: true, origin: env.APP_URL });
    expect(hostedConfig({ ...env, APP_URL: undefined, RENDER_EXTERNAL_URL: "https://render.example" })).toMatchObject({ hosted: true, origin: "https://render.example" });
    expect(hostedConfig({ ...env, RENDER_EXTERNAL_URL: "https://other.example" })).toMatchObject({ hosted: true, origin: env.APP_URL });
  });
  it("retains a durable absolute local SQLite path for explicit non-Render hosted mode", () => {
    const local = { RENDER: "false", HOSTED_DEMO: "true", APP_URL: "https://example.test", ADMIN_PASSWORD: password, HOSTED_SECRET: secret, LEDGER_PATH: join(tmpdir(), "aurrery-hosted-test", "ledger.sqlite") };
    expect(hostedConfig(local).hosted).toBe(true);
    expect(() => hostedConfig({ ...local, LEDGER_PATH: "relative/ledger.sqlite" })).toThrow();
    expect(() => hostedConfig({ ...local, LEDGER_PATH: ":memory:" })).toThrow();
    expect(() => hostedConfig({ ...local, LEDGER_PATH: undefined })).toThrow();
    expect(() => hostedConfig({ ...local, LEDGER_BACKEND: "unknown" })).toThrow();
  });
});

const directory = mkdtempSync(join(tmpdir(), "aurrery-hosted-store-"));
afterAll(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows native handle release. */ } });
async function fixture(name: string) {
  const db = new DatabaseSync(join(directory, `${name}.sqlite`));
  const connection = createLocalConnection(db);
  await initializeLedgerSchema(connection);
  return { db, connection, store: createHostingStore(connection, secret) };
}
describe("durable hosted store", () => {
  it("rejects forged, expired, revoked and password-rotated sessions", async () => {
    const { db, store } = await fixture("sessions");
    try {
      expect(store.verifyPassword(password, password)).toBe(true);
      expect(store.verifyPassword("wrong", password)).toBe(false);
      const token = await store.createSession(password, 1_000);
      expect(await store.isSessionValid(token, password, 1_001)).toBe(true);
      expect(await store.isSessionValid(token + "a", password, 1_001)).toBe(false);
      expect(await store.isSessionValid(token, password + "new", 1_001)).toBe(false);
      expect(await store.isSessionValid(token, password, 1_000 + 2 * 60 * 60 * 1_000)).toBe(false);
      await store.revokeSession(token);
      expect(await store.isSessionValid(token, password, 1_001)).toBe(false);
      expect(JSON.stringify(db.prepare("SELECT * FROM hosted_sessions").all())).not.toContain(token);
    } finally { db.close(); }
  });
  it("applies client, hourly global and daily global limits with opaque keys", async () => {
    const { db, store } = await fixture("limits");
    try {
      expect(limitsFor("login")).toEqual([{ scope: "client", max: 5, windowMs: 900_000 }, { scope: "global", max: 30, windowMs: 900_000 }]);
      let allowed = 0;
      for (let hour = 0; hour < 4; hour++) for (let i = 0; i < 6; i++) {
        if ((await store.admit("agent", `raw-client-${hour}-${i}`, hour * 3_600_000 + 1_000)).allowed) allowed++;
      }
      expect(allowed).toBe(20);
      const blocked = await store.admit("agent", "fresh-client", 4 * 3_600_000 + 1_000);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBeGreaterThan(3_600);
      expect(JSON.stringify(db.prepare("SELECT bucket_key FROM hosted_limits").all())).not.toContain("raw-client");
    } finally { db.close(); }
  });
});

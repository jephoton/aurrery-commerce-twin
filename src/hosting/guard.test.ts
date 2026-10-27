import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostingStore } from "./store";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { guardHostedRequest, parseSessionCookie } from "./guard";
import type { HostedConfig } from "./config";

const config: HostedConfig = { hosted: true, origin: "https://example.test", adminPassword: "p".repeat(40), secret: "s".repeat(48) };
const dir = mkdtempSync(join(tmpdir(), "aurrery-guard-"));
const db = new DatabaseSync(join(dir, "db.sqlite"));
const connection = createLocalConnection(db);
const store = createHostingStore(connection, config.hosted ? config.secret : "");
afterEach(async () => { await connection.executeMultiple("DELETE FROM hosted_limits; DELETE FROM hosted_sessions;"); });
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
describe("hosted request guard", () => {
  it("applies a separate global webhook quota of 30 per minute and 1200 per day", async () => {
    await initializeLedgerSchema(connection);
    const moment = 1_000;
    const admissions = [];
    for (let i = 0; i < 31; i++) admissions.push(await store.admit("webhook", `client-${i}`, moment));
    expect(admissions.filter((result) => result.allowed)).toHaveLength(30);
    expect(admissions[30].retryAfter).toBeGreaterThan(0);
    expect((await store.admit("webhook", "new-client", 61_000)).allowed).toBe(true);
  });
  it("stops webhook admission at the durable daily global cap across minute windows", async () => {
    await initializeLedgerSchema(connection);
    for (let minute = 0; minute < 40; minute++) {
      for (let attempt = 0; attempt < 30; attempt++)
        expect((await store.admit("webhook", `client-${attempt}`, minute * 60_000 + 1_000)).allowed).toBe(true);
    }
    expect((await store.admit("webhook", "fresh", 40 * 60_000 + 1_000)).allowed).toBe(false);
    expect((await store.admit("webhook", "fresh", 24 * 60 * 60_000 + 1_000)).allowed).toBe(true);
  });
  it("rejects absent and wrong origins even with a valid session", async () => {
    await initializeLedgerSchema(connection);
    const token = await store.createSession(config.hosted ? config.adminPassword : "");
    for (const origin of [undefined, "https://evil.test", "http://example.test"]) {
      const headers: Record<string, string> = { cookie: `__Host-aurrery-admin=${token}` };
      if (origin) headers.origin = origin;
      const response = await guardHostedRequest(new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers }), { admin: true }, config, store);
      expect(response?.status).toBe(403);
    }
  });
  it("rejects missing or forged admin cookies before mutation", async () => {
    for (const cookie of [undefined, "__Host-aurrery-admin=fake"] ) {
      const response = await guardHostedRequest(new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers: { origin: "https://example.test", ...(cookie ? { cookie } : {}) } }), { admin: true }, config, store);
      expect(response?.status).toBe(401);
    }
    expect(parseSessionCookie("other=one; __Host-aurrery-admin=abc; x=y")).toBe("abc");
  });
  it("admits same-origin public mutation and known admin", async () => {
    const token = await store.createSession(config.hosted ? config.adminPassword : "");
    const req = new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers: { origin: "https://example.test", cookie: `__Host-aurrery-admin=${token}` } });
    expect(await guardHostedRequest(req, { admin: true }, config, store)).toBeNull();
    expect(await guardHostedRequest(new Request("https://example.test/api/simulate", { method: "POST", headers: { origin: "https://example.test" } }), {}, config, store)).toBeNull();
  });
  it("shares the unverified client bucket despite forged proxy headers or an administrator cookie", async () => {
    const token = await store.createSession(config.hosted ? config.adminPassword : "");
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const request = new Request("https://example.test/api/agent", { method: "POST", headers: {
        origin: "https://example.test", cookie: `__Host-aurrery-admin=${token}`,
        "x-forwarded-for": `203.0.113.${i + 1}`, "x-real-ip": `198.51.100.${i + 1}`,
      } });
      outcomes.push(await guardHostedRequest(request, { limit: "agent" }, config, store));
    }
    expect(outcomes.slice(0, 3)).toEqual([null, null, null]);
    expect(outcomes[3]?.status).toBe(429);
    expect(Number(outcomes[3]?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

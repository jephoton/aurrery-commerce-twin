import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostingStore } from "./store";
import { guardHostedRequest, parseSessionCookie } from "./guard";
import type { HostedConfig } from "./config";

const config: HostedConfig = { hosted: true, origin: "https://example.test", adminPassword: "p".repeat(40), secret: "s".repeat(48) };
const dir = mkdtempSync(join(tmpdir(), "aurrery-guard-"));
const db = new DatabaseSync(join(dir, "db.sqlite"));
const store = createHostingStore(db, config.hosted ? config.secret : "");
afterEach(() => db.exec("DELETE FROM hosted_limits; DELETE FROM hosted_sessions;"));
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
describe("hosted request guard", () => {
  it("rejects absent and wrong origins even with a valid session", () => {
    const token = store.createSession(config.hosted ? config.adminPassword : "");
    for (const origin of [undefined, "https://evil.test", "http://example.test"]) {
      const headers: Record<string, string> = { cookie: `__Host-aurrery-admin=${token}` };
      if (origin) headers.origin = origin;
      const response = guardHostedRequest(new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers }), { admin: true }, config, store);
      expect(response?.status).toBe(403);
    }
  });
  it("rejects missing or forged admin cookies before mutation", () => {
    for (const cookie of [undefined, "__Host-aurrery-admin=fake"] ) {
      const response = guardHostedRequest(new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers: { origin: "https://example.test", ...(cookie ? { cookie } : {}) } }), { admin: true }, config, store);
      expect(response?.status).toBe(401);
    }
    expect(parseSessionCookie("other=one; __Host-aurrery-admin=abc; x=y")).toBe("abc");
  });
  it("admits same-origin public mutation and known admin", () => {
    const token = store.createSession(config.hosted ? config.adminPassword : "");
    const req = new Request("https://example.test/api/proposals/x/approve", { method: "POST", headers: { origin: "https://example.test", cookie: `__Host-aurrery-admin=${token}` } });
    expect(guardHostedRequest(req, { admin: true }, config, store)).toBeNull();
    expect(guardHostedRequest(new Request("https://example.test/api/simulate", { method: "POST", headers: { origin: "https://example.test" } }), {}, config, store)).toBeNull();
  });
});

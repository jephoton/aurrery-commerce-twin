import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedConfig } from "./config";
import { createHostingStore, limitsFor } from "./store";

const secret = "s".repeat(48);
const password = "correct-horse-battery-staple-and-more";
const env = { RENDER: "true", APP_URL: "https://example.test", ADMIN_PASSWORD: password, HOSTED_SECRET: secret, LEDGER_PATH: "/var/data/ledger.sqlite" };
describe("hosted configuration", () => {
  it("keeps local workflow when hosted flags are absent", () => expect(hostedConfig({})).toEqual({ hosted: false }));
  it("cannot disable hosting on Render and fails closed on missing or weak settings", () => {
    expect(() => hostedConfig({ RENDER: "true", HOSTED_DEMO: "false" })).toThrow();
    expect(() => hostedConfig({ ...env, ADMIN_PASSWORD: "short" })).toThrow();
    expect(() => hostedConfig({ ...env, APP_URL: "http://example.test" })).toThrow();
    expect(() => hostedConfig({ ...env, LEDGER_PATH: undefined })).toThrow();
    expect(() => hostedConfig({ ...env, RENDER: "false", HOSTED_DEMO: "true", LEDGER_PATH: undefined })).toThrow();
    expect(() => hostedConfig({ ...env, RENDER: "false", HOSTED_DEMO: "true", LEDGER_PATH: ":memory:" })).toThrow();
    expect(() => hostedConfig({ ...env, LEDGER_PATH: "/var/data/../tmp/ledger.sqlite" })).toThrow();
    expect(hostedConfig({ ...env, HOSTED_DEMO: "false" })).toMatchObject({ hosted: true });
  });
});

describe("durable hosted store", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const open = () => { const dir = mkdtempSync(join(tmpdir(), "aurrery-admission-")); dirs.push(dir); return join(dir, "admission.sqlite"); };
  it("rejects forged, expired, logged-out, and password-rotated sessions", () => {
    const db = new DatabaseSync(open()); const store = createHostingStore(db, secret);
    expect(store.verifyPassword(password, password)).toBe(true);
    expect(store.verifyPassword("wrong", password)).toBe(false);
    const token = store.createSession(password, 1_000);
    expect(store.isSessionValid(token, password, 1_001)).toBe(true);
    expect(store.isSessionValid(token + "a", password, 1_001)).toBe(false);
    expect(store.isSessionValid(token, password + "new", 1_001)).toBe(false);
    expect(store.isSessionValid(token, password, 1_000 + 2 * 60 * 60 * 1_000)).toBe(false);
    store.revokeSession(token);
    expect(store.isSessionValid(token, password, 1_001)).toBe(false);
    db.close();
  });
  it("admits atomic quotas and retains them across database restart", async () => {
    const path = open(); const db = new DatabaseSync(path); const store = createHostingStore(db, secret);
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => store.admit("agent", `client-${i}`, 1_000))));
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(6);
    expect(outcomes.find((o) => !o.allowed)?.retryAfter).toBeGreaterThan(0);
    db.close();
    const restarted = new DatabaseSync(path); const newStore = createHostingStore(restarted, secret);
    expect(newStore.admit("agent", "new-client", 1_001).allowed).toBe(false);
    restarted.close();
  });
  it("applies client and global limits, even as forwarded identities vary", () => {
    const db = new DatabaseSync(open()); const store = createHostingStore(db, secret);
    expect(limitsFor("login")).toEqual([{ scope: "client", max: 5, windowMs: 900_000 }, { scope: "global", max: 30, windowMs: 900_000 }]);
    for (let i = 0; i < 3; i++) expect(store.admit("agent", "shared", 10_000).allowed).toBe(true);
    expect(store.admit("agent", "shared", 10_000).allowed).toBe(false);
    for (let i = 0; i < 3; i++) expect(store.admit("agent", `spoofed-${i}`, 10_000).allowed).toBe(true);
    expect(store.admit("agent", "yet-another", 10_000).allowed).toBe(false);
    db.close();
  });
  it("retains the global daily ceiling across hourly windows and stores opaque keys", () => {
    const db = new DatabaseSync(open()); const store = createHostingStore(db, secret);
    let admitted = 0;
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < 6; i++) {
        const result = store.admit("agent", `raw-client-${hour}-${i}`, hour * 3_600_000 + 1_000);
        if (result.allowed) admitted++;
      }
    }
    expect(admitted).toBe(20);
    const blocked = store.admit("agent", "fresh-client", 4 * 3_600_000 + 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(3_600);
    expect(JSON.stringify(db.prepare("SELECT bucket_key FROM hosted_limits").all())).not.toContain("raw-client");
    db.close();
  });
});

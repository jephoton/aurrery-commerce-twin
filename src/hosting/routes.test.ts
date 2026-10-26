import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledger } from "@/ledger/db";
import { createAgentHandler } from "@/agent/http";
import { POST as simulate } from "@/app/api/simulate/route";
import { POST as prepare } from "@/app/api/proposals/route";
import { POST as approve } from "@/app/api/proposals/[id]/approve/route";
import { POST as reject } from "@/app/api/proposals/[id]/reject/route";
import { GET as poll } from "@/app/api/paypal/status/route";
import { createHostingStore } from "./store";

const dir = mkdtempSync(join(tmpdir(), "aurrery-hosted-routes-"));
const origin = "https://example.test";
beforeAll(() => {
  vi.stubEnv("HOSTED_DEMO", "true"); vi.stubEnv("RENDER", "false"); vi.stubEnv("APP_URL", origin);
  vi.stubEnv("HOSTED_SECRET", "s".repeat(48)); vi.stubEnv("ADMIN_PASSWORD", "p".repeat(40));
  vi.stubEnv("LEDGER_PATH", join(dir, "ledger.sqlite"));
});
afterAll(() => { ledger().close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const request = (path: string, originHeader?: string) => new Request(`${origin}${path}`, { method: "POST", headers: originHeader ? { origin: originHeader } : undefined, body: "{}" });
const params = { params: Promise.resolve({ id: "missing" }) };

describe("direct hosted API admission", () => {
  it("blocks admin mutations before any PayPal or proposal write", async () => {
    expect((await approve(request("/api/proposals/missing/approve", origin), params)).status).toBe(401);
    expect((await reject(request("/api/proposals/missing/reject", origin), params)).status).toBe(401);
    expect((await approve(request("/api/proposals/missing/approve"), params)).status).toBe(403);
    expect((ledger().prepare("SELECT count(*) AS n FROM proposals").get() as {n: number}).n).toBe(0);
  });
  it("bounds authenticated approval and rejection bodies before PayPal work", async () => {
    const token = createHostingStore(ledger(), "s".repeat(48)).createSession("p".repeat(40));
    const huge = new Request(`${origin}/api/proposals/missing/approve`, { method: "POST", headers: { origin, cookie: `__Host-aurrery-admin=${token}` }, body: "x".repeat(70_000) });
    expect((await approve(huge, params)).status).toBe(413);
    const rejectHuge = new Request(`${origin}/api/proposals/missing/reject`, { method: "POST", headers: { origin, cookie: `__Host-aurrery-admin=${token}` }, body: "x".repeat(70_000) });
    expect((await reject(rejectHuge, params)).status).toBe(413);
  });
  it("requires configured origin for every public mutation before parsing", async () => {
    expect((await simulate(request("/api/simulate"))).status).toBe(403);
    expect((await prepare(request("/api/proposals", "https://evil.test"))).status).toBe(403);
    expect((await createAgentHandler({ run: vi.fn() })(request("/api/agent"))).status).toBe(403);
  });
  it("bounds live PayPal polling even if request host varies", async () => {
    const bad = new Request("https://another-host.test/api/paypal/status");
    // It may fail for unavailable Sandbox credentials, but a forged Host never
    // changes the admission bucket. Fill it without calling PayPal by using the store.
    const store = createHostingStore(ledger(), "s".repeat(48));
    for (let i = 0; i < 30; i++) expect(store.admit("poll", "unverified-proxy-client").allowed).toBe(true);
    const response = await poll(bad);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

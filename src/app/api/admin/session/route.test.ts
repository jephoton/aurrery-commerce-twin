import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST, DELETE } from "./route";
import { ledger } from "@/ledger/db";

const dir = mkdtempSync(join(tmpdir(), "aurrery-session-route-"));
const origin = "https://example.test";
const headers = { origin, "content-type": "application/json" };
const password = "p".repeat(40);
beforeAll(() => {
  vi.stubEnv("HOSTED_DEMO", "true"); vi.stubEnv("RENDER", "false"); vi.stubEnv("APP_URL", origin);
  vi.stubEnv("HOSTED_SECRET", "s".repeat(48)); vi.stubEnv("ADMIN_PASSWORD", password);
  vi.stubEnv("LEDGER_PATH", join(dir, "ledger.sqlite"));
});
afterAll(() => { ledger().close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const login = (body: string, extra: Record<string,string> = {}) => POST(new Request(`${origin}/api/admin/session`, { method: "POST", headers: { ...headers, ...extra }, body }));

describe("admin session API", () => {
  it("returns only safe capability state", async () => {
    const response = await GET(new Request(`${origin}/api/admin/session`));
    expect(await response.json()).toEqual({ hosted: true, configured: true, authenticated: false, canReview: false });
  });
  it("bounds login input and rejects wrong origin", async () => {
    expect((await login(JSON.stringify({ password }), { origin: "https://evil.test" })).status).toBe(403);
    expect((await login(JSON.stringify({ password: "x".repeat(70_000) }))).status).toBe(413);
  });
  it("uses a secure opaque cookie and revokes on logout", async () => {
    expect((await login(JSON.stringify({ password: "wrong" }))).status).toBe(401);
    const response = await login(JSON.stringify({ password }));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/__Host-aurrery-admin=[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly.*Secure.*SameSite=Strict/i);
    expect(cookie).not.toContain(password);
    const credential = cookie.split(";")[0];
    expect(await (await GET(new Request(`${origin}/api/admin/session`, { headers: { cookie: credential } }))).json()).toMatchObject({ authenticated: true, canReview: true });
    expect((await DELETE(new Request(`${origin}/api/admin/session`, { method: "DELETE", headers: { origin, cookie: credential } }))).status).toBe(200);
    expect(await (await GET(new Request(`${origin}/api/admin/session`, { headers: { cookie: credential } }))).json()).toMatchObject({ authenticated: false });
  });
  it("counts failed login attempts before password comparison", async () => {
    ledger().exec("DELETE FROM hosted_limits;");
    for (let i = 0; i < 5; i++) expect((await login(JSON.stringify({ password: "wrong" }))).status).toBe(401);
    const blocked = await login(JSON.stringify({ password }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("fails closed when Render settings are missing", async () => {
    vi.stubEnv("RENDER", "true");
    expect((await GET(new Request(`${origin}/api/admin/session`))).status).toBe(503);
    vi.stubEnv("RENDER", "false");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runtimeLedgerConnection } from "@/ledger/connection";
import { admitHostedRequest } from "./guard";

vi.mock("@/ledger/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/connection")>();
  return { ...actual, runtimeLedgerConnection: vi.fn(async () => { throw new Error("storage unavailable"); }) };
});

afterEach(() => { vi.unstubAllEnvs(); vi.mocked(runtimeLedgerConnection).mockClear(); });
function configure() {
  vi.stubEnv("HOSTED_DEMO", "true");
  vi.stubEnv("RENDER", "false");
  vi.stubEnv("APP_URL", "https://example.test");
  vi.stubEnv("ADMIN_PASSWORD", "p".repeat(40));
  vi.stubEnv("HOSTED_SECRET", "s".repeat(48));
  vi.stubEnv("LEDGER_BACKEND", "sqlite");
  vi.stubEnv("LEDGER_PATH", resolve("unused-ledger.sqlite"));
}

it("rejects a wrong origin and missing admin cookie before opening storage", async () => {
  configure();
  const wrongOrigin = new Request("https://example.test/api/proposals/p/approve", { method: "POST", headers: { origin: "https://evil.test" } });
  expect((await admitHostedRequest(wrongOrigin, { admin: true }))?.status).toBe(403);
  const missingCookie = new Request("https://example.test/api/proposals/p/approve", { method: "POST", headers: { origin: "https://example.test" } });
  expect((await admitHostedRequest(missingCookie, { admin: true }))?.status).toBe(401);
  expect(runtimeLedgerConnection).not.toHaveBeenCalled();
});

it("fails closed with a bounded response when admitted work cannot reach storage", async () => {
  configure();
  const request = new Request("https://example.test/api/simulate", { method: "POST", headers: { origin: "https://example.test" } });
  const response = await admitHostedRequest(request, { limit: "preparation" });
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({ error: "HOSTED_UNAVAILABLE" });
  expect(runtimeLedgerConnection).toHaveBeenCalledOnce();
});

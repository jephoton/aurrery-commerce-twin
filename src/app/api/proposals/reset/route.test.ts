import { afterEach, expect, it, vi } from "vitest";
import * as guard from "@/hosting/guard";
import * as reset from "@/execution/reset";
import * as config from "@/hosting/config";
import * as connection from "@/ledger/connection";
import * as paypal from "@/paypal/client";
import { POST } from "./route";

afterEach(() => vi.restoreAllMocks());

it.each([401, 403])("blocks an unauthorized reset preview before body or PayPal/ledger access (%i)", async (status) => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(Response.json({ error: "BLOCKED" }, { status }));
  const preview = vi.spyOn(reset, "previewDemoReset");
  const response = await POST(new Request("https://example.test/api/proposals/reset", { method: "POST", body: "{" }));
  expect(response.status).toBe(status);
  expect(guard.admitHostedRequest).toHaveBeenCalledWith(expect.any(Request), { admin: true, limit: "preparation" });
  expect(preview).not.toHaveBeenCalled();
});

it.each([false, true])("returns a preview without approval or execution (has targets: %s)", async (hasTargets) => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(null);
  const result = { proposal: hasTargets ? { id: "reset", status: "proposed" } : null, skipped: [] };
  const preview = vi.spyOn(reset, "previewDemoReset").mockResolvedValue(result as never);
  const response = await POST(new Request("http://localhost/api/proposals/reset", { method: "POST", body: "{}" }));
  expect(response.status).toBe(hasTargets ? 201 : 200); expect(await response.json()).toEqual(result);
  expect(preview).toHaveBeenCalledWith();
});

it.each(["https://evil.test", null, "https://example.test"])("uses the actual origin/admin guard before storage, SDK and body (%s)", async (origin) => {
  vi.spyOn(config, "hostedConfig").mockReturnValue({ hosted: true, origin: "https://example.test", adminPassword: "x".repeat(32), secret: "s".repeat(32) });
  const ledger = vi.spyOn(connection, "runtimeLedgerConnection").mockRejectedValue(new Error("forbidden storage"));
  const sdk = vi.spyOn(paypal, "paypal"); const preview = vi.spyOn(reset, "previewDemoReset");
  const request = new Request("https://example.test/api/proposals/reset", { method: "POST", headers: origin ? { origin } : {}, body: "{" });
  const response = await POST(request);
  expect(response.status).toBe(origin === "https://example.test" ? 401 : 403);
  expect(request.bodyUsed).toBe(false); expect(ledger).not.toHaveBeenCalled(); expect(sdk).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
});

it("rejects arbitrary targets or prices before preview", async () => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(null);
  const preview = vi.spyOn(reset, "previewDemoReset");
  const response = await POST(new Request("http://localhost/api/proposals/reset", { method: "POST", body: JSON.stringify({ targets: ["I-ARBITRARY"], listPrice: "1.00" }) }));
  expect(response.status).toBe(400);
  expect(preview).not.toHaveBeenCalled();
});

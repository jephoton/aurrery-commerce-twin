import { afterEach, expect, it, vi } from "vitest";
import * as guard from "@/hosting/guard";
import * as proposals from "@/ledger/proposals";
import * as execution from "@/execution/execute";
import * as paypal from "@/paypal/client";
import * as config from "@/hosting/config";
import * as connection from "@/ledger/connection";
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const url = "http://localhost/api/proposals/reset/p/confirm";
const params = { params: Promise.resolve({ id: "p" }) };

it("blocks unauthorized confirmation before parsing or SDK/ledger access", async () => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(Response.json({ error: "ADMIN_REQUIRED" }, { status: 401 }));
  const approve = vi.spyOn(proposals, "approveResetProposal");
  const execute = vi.spyOn(execution, "executeProposal");
  const response = await POST(new Request(url, { method: "POST", body: "{" }), params);
  expect(response.status).toBe(401);
  expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it("requires the exact hash and literal fresh confirmation", async () => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(null);
  const approve = vi.spyOn(proposals, "approveResetProposal");
  const execute = vi.spyOn(execution, "executeProposal");
  for (const body of [{ actionHash: "a".repeat(64), confirmed: false }, { actionHash: "a".repeat(64), confirmed: true, targets: ["I-ARBITRARY"] },
    { actionHash: "a".repeat(64) }, { actionHash: "a".repeat(64), confirmed: "true" }, { actionHash: "bad", confirmed: true }]) {
    const response = await POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), params);
    expect(response.status).toBe(400);
  }
  expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it("approves the exact reset before entering the shared claim/execution flow", async () => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(null); vi.spyOn(paypal, "paypalConfigured").mockReturnValue(true);
  const calls: string[] = [];
  const approve = vi.spyOn(proposals, "approveResetProposal").mockImplementation(async () => { calls.push("approve"); return {} as never; });
  const execute = vi.spyOn(execution, "executeProposal").mockImplementation(async () => { calls.push("execute"); return { proposal: { id: "p", status: "executing" }, outcomes: [] } as never; });
  const response = await POST(new Request(url, { method: "POST", body: JSON.stringify({ actionHash: "a".repeat(64), confirmed: true }) }), params);
  expect(response.status).toBe(200); expect(calls).toEqual(["approve", "execute"]);
  expect(approve).toHaveBeenCalledWith("p", "a".repeat(64), "administrator (demo reset)"); expect(execute).toHaveBeenCalledWith("p");
  expect(guard.admitHostedRequest).toHaveBeenCalledWith(expect.any(Request), { admin: true });
});

it.each(["tampered", "uncertain approval"])("stops before execution on %s", async (failure) => {
  vi.spyOn(guard, "admitHostedRequest").mockResolvedValue(null); vi.spyOn(paypal, "paypalConfigured").mockReturnValue(true);
  vi.spyOn(proposals, "approveResetProposal").mockRejectedValue(failure === "tampered" ? new proposals.ProposalError("Tampered hash", "HASH_MISMATCH") : new Error("unknown acknowledgement"));
  const execute = vi.spyOn(execution, "executeProposal");
  const response = await POST(new Request(url, { method: "POST", body: JSON.stringify({ actionHash: "a".repeat(64), confirmed: true }) }), params);
  expect(response.status).toBe(409); expect((await response.json()).error).toBe(failure === "tampered" ? "HASH_MISMATCH" : "RECONCILIATION_REQUIRED");
  expect(execute).not.toHaveBeenCalled();
});

it.each(["https://evil.test", null, "https://example.test"])("checks actual origin/admin access before body, storage and SDK on confirm (%s)", async (origin) => {
  vi.spyOn(config, "hostedConfig").mockReturnValue({ hosted: true, origin: "https://example.test", adminPassword: "x".repeat(32), secret: "s".repeat(32) });
  const ledger = vi.spyOn(connection, "runtimeLedgerConnection").mockRejectedValue(new Error("forbidden storage"));
  const sdk = vi.spyOn(paypal, "paypalConfigured"); const approve = vi.spyOn(proposals, "approveResetProposal"); const execute = vi.spyOn(execution, "executeProposal");
  const request = new Request(url, { method: "POST", headers: origin ? { origin } : {}, body: "{" });
  const response = await POST(request, params);
  expect(response.status).toBe(origin === "https://example.test" ? 401 : 403); expect(request.bodyUsed).toBe(false);
  expect(ledger).not.toHaveBeenCalled(); expect(sdk).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

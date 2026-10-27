import { afterEach, expect, it, vi } from "vitest";
import * as proposals from "@/ledger/proposals";
import * as execution from "@/execution/execute";
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("rejects a stale client hash and missing literal confirmation without executing", async () => {
  vi.stubEnv("HOSTED_DEMO", "false"); vi.stubEnv("RENDER", "false");
  const get = vi.spyOn(proposals, "getProposal").mockResolvedValue({ id: "p", status: "approved", actionHash: "b".repeat(64) } as never);
  const execute = vi.spyOn(execution, "executeProposal");
  const params = { params: Promise.resolve({ id: "p" }) };
  const wrong = await POST(new Request("http://localhost/api/proposals/p/execute", { method: "POST", body: JSON.stringify({ actionHash: "a".repeat(64), confirmed: true }) }), params);
  expect(wrong.status).toBe(409);
  const missing = await POST(new Request("http://localhost/api/proposals/p/execute", { method: "POST", body: JSON.stringify({ actionHash: "b".repeat(64), confirmed: false }) }), params);
  expect(missing.status).toBe(400);
  expect(get).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it("refuses replay when the proposal is already executing", async () => {
  vi.stubEnv("HOSTED_DEMO", "false"); vi.stubEnv("RENDER", "false");
  vi.spyOn(proposals, "getProposal").mockResolvedValue({ id: "p", status: "executing", actionHash: "b".repeat(64) } as never);
  const execute = vi.spyOn(execution, "executeProposal");
  const response = await POST(new Request("http://localhost/api/proposals/p/execute", { method: "POST", body: JSON.stringify({ actionHash: "b".repeat(64), confirmed: true }) }), { params: Promise.resolve({ id: "p" }) });
  expect(response.status).toBe(409);
  expect(execute).not.toHaveBeenCalled();
});

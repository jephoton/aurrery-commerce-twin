import { afterEach, expect, it, vi } from "vitest";
import { LedgerStorageError } from "@/ledger/connection";
import * as proposals from "@/ledger/proposals";
import * as execution from "@/execution/execute";
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reports uncertain approval storage acknowledgement and does not start PayPal execution", async () => {
  vi.stubEnv("HOSTED_DEMO", "false");
  vi.stubEnv("RENDER", "false");
  vi.stubEnv("PAYPAL_CLIENT_ID", "offline-test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "offline-test-secret");
  vi.spyOn(proposals, "approveProposal").mockRejectedValue(new LedgerStorageError());
  const execute = vi.spyOn(execution, "executeProposal");
  const request = new Request("http://localhost/api/proposals/prop_test/approve", { method: "POST", body: JSON.stringify({ actionHash: "a".repeat(64), approvedBy: "merchant" }) });
  const response = await POST(request, { params: Promise.resolve({ id: "prop_test" }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "RECONCILIATION_REQUIRED", proposalId: "prop_test" });
  expect(execute).not.toHaveBeenCalled();
});

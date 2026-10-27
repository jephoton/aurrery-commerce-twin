import { afterEach, expect, it, vi } from "vitest";
import * as proposals from "@/ledger/proposals";
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("accepts only a source ID and creates a proposed revert without PayPal calls", async () => {
  vi.stubEnv("HOSTED_DEMO", "false"); vi.stubEnv("RENDER", "false");
  const create = vi.spyOn(proposals, "createRevertProposal").mockResolvedValue({ id: "new", status: "proposed" } as never);
  const request = new Request("http://localhost/api/proposals/revert", { method: "POST", body: JSON.stringify({ sourceProposalId: "prop_00000000-0000-4000-8000-000000000001", targets: ["I-ARBITRARY"] }) });
  const response = await POST(request);
  expect(response.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

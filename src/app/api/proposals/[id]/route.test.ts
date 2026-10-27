import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/hosting/guard", () => ({ admitHostedRequest: async () => null }));
import * as proposals from "@/ledger/proposals";
import { GET } from "./route";

afterEach(() => vi.restoreAllMocks());

it("returns one authoritative proposal so an older selected action can refresh after uncertain execution", async () => {
  const get = vi.spyOn(proposals, "getProposal").mockResolvedValue({ id: "prop_00000000-0000-4000-8000-000000000001", status: "executing" } as never);
  const request = new Request("http://localhost/api/proposals/prop_00000000-0000-4000-8000-000000000001");
  const response = await GET(request, { params: Promise.resolve({ id: "prop_00000000-0000-4000-8000-000000000001" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ proposal: { id: "prop_00000000-0000-4000-8000-000000000001", status: "executing" } });
  expect(get).toHaveBeenCalledWith("prop_00000000-0000-4000-8000-000000000001");
});

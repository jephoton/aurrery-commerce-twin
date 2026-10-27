import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/hosting/guard", () => ({ admitHostedRequest: async () => null }));
import * as proposals from "@/ledger/proposals";
import { GET } from "./route";

afterEach(() => vi.restoreAllMocks());

it("returns a bounded outstanding page with an opaque continuation cursor", async () => {
  const list = vi.spyOn(proposals, "listOutstandingProposals").mockResolvedValue({ proposals: [{ id: "pending" } as never], nextCursor: { createdAt: "2026-01-01T00:00:00.000Z", id: "prop_00000000-0000-4000-8000-000000000001" } });
  const response = await GET(new Request("http://localhost/api/proposals/outstanding?limit=1"));
  expect(response.status).toBe(200);
  expect((await response.json()).proposals).toEqual([{ id: "pending" }]);
  expect(list).toHaveBeenCalledWith(1, undefined);
  expect((await GET(new Request("http://localhost/api/proposals/outstanding?limit=1000"))).status).toBe(400);
});

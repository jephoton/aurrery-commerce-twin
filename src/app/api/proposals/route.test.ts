import { describe, expect, it, vi } from "vitest";
import { ledger } from "@/ledger/db";
import { listProposals } from "@/ledger/proposals";
import type { Strategy } from "@/twin/interventions";
import { compareStrategies } from "@/twin/simulate";
import * as workerClient from "@/twin/worker-client";
import { POST } from "./route";

const strategy: Strategy = { id: "save", name: "Save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } };
describe("proposal worker boundary", () => {
  it("does not persist a cancelled request", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController(); controller.abort();
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
    const response = await POST(request);
    expect(response.status).toBe(408);
    expect(await listProposals()).toHaveLength(0);
  });
  it("does not persist when cancellation arrives during recomputation", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController();
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
    const pending = POST(request);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await listProposals()).toHaveLength(0);
  });
  it("checks cancellation again after a worker result and before proposal persistence", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController();
    const spy = vi.spyOn(workerClient, "runComparison").mockImplementation(async (twin, strategies) => {
      const result = compareStrategies(twin, strategies, { runs: 10, horizonMonths: 1, seed: 42 });
      controller.abort();
      return result;
    });
    try {
      const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
      expect((await POST(request)).status).toBe(408);
      expect(await listProposals()).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it("rejects an oversized body", async () => {
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "x".repeat(70_000), strategy }) });
    expect((await POST(request)).status).toBe(413);
  });
});

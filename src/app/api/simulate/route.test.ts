import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import type { Strategy } from "@/twin/interventions";
import { runComparison } from "@/twin/worker-client";
import { POST } from "./route";

const strategy: Strategy = { id: "save", name: "Save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } };
const body = { strategies: [strategy], options: { runs: 100, horizonMonths: 2, seed: 42 } };
const request = (value: string, signal?: AbortSignal) => new Request("http://localhost/api/simulate", { method: "POST", body: value, signal });

describe("manual simulation route", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the server simulation budget by default and caps larger requests", async () => {
    vi.stubEnv("SIMULATION_RUNS", "150");
    for (const options of [{ horizonMonths: 1 }, { runs: 5000, horizonMonths: 1 }]) {
      const response = await POST(request(JSON.stringify({ strategies: [strategy], options })));
      expect(response.status).toBe(200);
      expect((await response.json()).options.runs).toBe(150);
    }
  });
  it("returns the exact seeded worker comparison", async () => {
    const response = await POST(request(JSON.stringify(body)));
    expect(response.status).toBe(200);
    const { observedSnapshot, ...comparison } = await response.json();
    expect(comparison).toEqual(compareStrategies(currentMerchant().twin, body.strategies, body.options));
    expect(observedSnapshot).toMatchObject({ evidence: { episodes: 0, subscriberMonths: 0 }, changes: [], provenance: currentMerchant().twin.provenance });
  });
  it("rejects oversized bodies before computation", async () => {
    const response = await POST(request(JSON.stringify({ ...body, padding: "x".repeat(70_000) })));
    expect(response.status).toBe(413);
  });
  it("passes cancellation to worker and maps it to a safe status", async () => {
    const controller = new AbortController(); controller.abort();
    const response = await POST(request(JSON.stringify(body), controller.signal));
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: "ABORTED" });
  });
  it("unblocks a stalled request body when cancelled", async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const request = new Request("http://localhost/api/simulate", { method: "POST", body: stalled, signal: controller.signal, duplex: "half" } as RequestInit & { duplex: "half" });
    const pending = POST(request);
    setTimeout(() => controller.abort(), 10);
    const response = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("body read stalled")), 300))]);
    expect(response.status).toBe(408);
  });
  it("returns busy while another route owns the single capacity", async () => {
    const controller = new AbortController();
    const pending = runComparison(currentMerchant().twin, [strategy], { runs: 5000, horizonMonths: 36, seed: 1 }, { signal: controller.signal });
    const response = await POST(request(JSON.stringify(body)));
    expect(response.status).toBe(429);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });
});

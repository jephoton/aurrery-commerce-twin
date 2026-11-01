import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import type { Strategy } from "@/twin/interventions";
import { runComparison } from "@/twin/worker-client";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildImportedTwin } from "@/import/imported-twin";
import { formatRowError } from "@/import/row-error";
import { samplePayload } from "@/test/import-fixture";
import { POST } from "./route";

// Imported merchants must never read Ridgeline's observed ledger evidence: discount outcomes or annual offers.
const reads = vi.hoisted(() => ({ discount: 0, annual: 0 }));
vi.mock("@/ledger/discount-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/discount-outcomes")>();
  return { ...actual, readDiscountOutcomes: vi.fn(async (...args: Parameters<typeof actual.readDiscountOutcomes>) => { reads.discount++; return actual.readDiscountOutcomes(...args); }) };
});
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return { ...actual, readAnnualOfferEvidence: vi.fn(async (...args: Parameters<typeof actual.readAnnualOfferEvidence>) => { reads.annual++; return actual.readAnnualOfferEvidence(...args); }) };
});

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

describe("imported merchant simulation", () => {
  const options = { runs: 100, horizonMonths: 2, seed: 42 };
  const post = (value: unknown) => POST(request(JSON.stringify(value)));
  const reset = () => { reads.discount = 0; reads.annual = 0; };
  afterEach(() => vi.unstubAllEnvs());

  it("rebuilds the imported twin per request and never reads Ridgeline's observed evidence", async () => {
    reset();
    expect((await post(body)).status).toBe(200);
    expect(reads).toEqual({ discount: 1, annual: 1 }); // control: Ridgeline reads both
    reset();
    const strategies = [STARTER_STRATEGIES[0], STARTER_STRATEGIES[2]];
    const response = await post({ strategies, options, import: samplePayload() });
    expect(response.status).toBe(200);
    const { imported, observedSnapshot, ...comparison } = await response.json();
    expect(imported).toBe(true);
    expect(observedSnapshot).toBeUndefined();
    const built = buildImportedTwin(samplePayload());
    if (!built.ok) throw new Error("The sample must build.");
    expect(comparison).toEqual(compareStrategies(built.twin, strategies, options));
    expect(comparison.merchantId).toBe("imported-csv");
    expect(reads).toEqual({ discount: 0, annual: 0 });
  });

  it("keeps the hosted simulation budget for imports", async () => {
    vi.stubEnv("SIMULATION_RUNS", "150");
    const response = await post({ strategies: [STARTER_STRATEGIES[0]], options: { runs: 5000, horizonMonths: 1 }, import: samplePayload() });
    expect(response.status).toBe(200);
    expect((await response.json()).options.runs).toBe(150);
  });

  it("returns per-row errors and refuses price-reason targeting without feedback, without reading evidence", async () => {
    reset();
    const broken = samplePayload();
    broken.rows[12][3] = 999_999;
    const invalid = await post({ strategies: [STARTER_STRATEGIES[0]], options, import: broken });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
    const noFeedback = await post({ strategies: [STARTER_STRATEGIES[1]], options, import: samplePayload({ feedback: false }) });
    expect(noFeedback.status).toBe(422);
    expect(await noFeedback.json()).toMatchObject({ error: "REASON_UNAVAILABLE" });
    expect(reads).toEqual({ discount: 0, annual: 0 });
  });

  it("rejects an import that breaks the schema without echoing client-sent keys", async () => {
    reset();
    const secretKey = "customer_jane_doe_extra";
    const sample = samplePayload();
    for (const value of [{ ...sample, [secretKey]: true }, { ...sample, economics: { ...sample.economics, [secretKey]: 1 } }]) {
      const response = await post({ strategies: [STARTER_STRATEGIES[0]], options, import: value });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain(secretKey);
      const json = JSON.parse(text);
      expect(json.error).toBe("INVALID_IMPORT");
      expect(json.errors).toHaveLength(1);
      expect(json.errors[0].message).toBe("unexpected field");
    }
    const nullImport = await post({ strategies: [STARTER_STRATEGIES[0]], options, import: null });
    expect(nullImport.status).toBe(400);
    expect((await nullImport.json()).error).toBe("INVALID_IMPORT");
    expect(reads).toEqual({ discount: 0, annual: 0 });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { ledger } from "@/ledger/db";
import { createPredictionCache, predictionCacheKey } from "./cache";
import { classifyFeedback, validateBatch } from "./classify";
import { createProvider, type ClassificationProvider } from "./providers";
import type { ModelInput, Prediction } from "./contracts";

const inputs = (count = 3): ModelInput[] => Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, text: `Message ${i}`, source: "support", segment: "core" }));
const prediction = (id: string, confidence = 0.9): Prediction => ({ id, intent: "stay", reason: "other", confidence });
function fixtureProvider(outputs?: unknown[], onCall?: (batch: ModelInput[]) => void): ClassificationProvider {
  return createProvider({ provider: "groq", env: { GROQ_API_KEY: "test" }, fetch: async (_url, init) => {
    const batch = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as ModelInput[];
    onCall?.(batch);
    const payload = outputs ? outputs.shift() : { items: batch.map((input) => prediction(input.id)) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  } });
}

describe("batch validation", () => {
  it("preserves valid partial predictions and distinguishes missing, invalid and low confidence", () => {
    const batch = inputs(5);
    const result = validateBatch(batch, { items: [prediction("id-0"), prediction("id-1", 0.69), { ...prediction("id-2"), reason: "shipping" }, prediction("unknown")] });
    expect(result.accepted).toEqual([prediction("id-0")]);
    expect(result.schemaValidCount).toBe(2);
    expect(result.unclassified).toEqual([
      { id: "id-1", cause: "low_confidence" }, { id: "id-2", cause: "schema_invalid" }, { id: "id-3", cause: "missing" }, { id: "id-4", cause: "missing" },
    ]);
    expect(result.diagnostics).toEqual([{ cause: "unknown_id", id: "unknown" }]);
  });

  it("rejects every occurrence of duplicate IDs even when one occurrence has invalid fields", () => {
    const result = validateBatch(inputs(), { items: [prediction("id-0"), { id: "id-0", confidence: "bad" }, prediction("id-1"), prediction("id-2", 0.7)] });
    expect(result.accepted.map((p) => p.id)).toEqual(["id-1", "id-2"]);
    expect(result.unclassified).toEqual([{ id: "id-0", cause: "duplicate" }]);
    expect(result.schemaValidCount).toBe(2);
  });

  it.each([null, [], { items: null }, { things: [] }, { items: [], unexpected: true }])("rejects malformed roots (%j)", (raw) => {
    const result = validateBatch(inputs(), raw);
    expect(result.accepted).toEqual([]);
    expect(result.unclassified).toEqual(inputs().map(({ id }) => ({ id, cause: "malformed_batch" })));
    expect(result.diagnostics).toEqual([{ cause: "malformed_batch" }]);
  });

  it("rejects ambiguous input IDs before any provider call", async () => {
    let calls = 0;
    await expect(classifyFeedback([inputs()[0], inputs()[0]], { provider: fixtureProvider(undefined, () => calls++) })).rejects.toThrow("unique");
    expect(calls).toBe(0);
  });
});

describe("sequential classification and SQLite cache", () => {
  beforeEach(() => { createPredictionCache(); ledger().exec("DELETE FROM feedback_prediction_cache"); });

  it("uses batches of 20 in input order and reports progress without caching by default", async () => {
    const sizes: number[] = [];
    const progress: number[] = [];
    const result = await classifyFeedback(inputs(43), { provider: fixtureProvider(undefined, (batch) => sizes.push(batch.length)), onProgress: (batch) => { progress.push(batch.index); } });
    expect(sizes).toEqual([20, 20, 3]);
    expect(progress).toEqual([0, 1, 2]);
    expect(result.accepted.map((p) => p.id)).toEqual(inputs(43).map((p) => p.id));
    expect(result).toMatchObject({ total: 43, schemaValidCount: 43, cacheHits: 0, stopped: false });
    expect(result.batches).toHaveLength(3);
    expect(result.metrics.attempts).toHaveLength(3);
    expect(ledger().prepare("SELECT COUNT(*) AS n FROM feedback_prediction_cache").get()?.n).toBe(0);
  });

  it("caches only accepted results and makes no POST when every item is cached", async () => {
    const batch = inputs();
    await classifyFeedback(batch, { provider: fixtureProvider([{ items: [prediction("id-0"), prediction("id-1", 0.4), { ...prediction("id-2"), intent: "bad" }] }]), cache: true });
    expect(ledger().prepare("SELECT COUNT(*) AS n FROM feedback_prediction_cache").get()?.n).toBe(1);
    let calls = 0;
    const result = await classifyFeedback([batch[0]], { provider: fixtureProvider(undefined, () => calls++), cache: true });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ cacheHits: 1, schemaValidCount: 1, total: 1 });
    expect(result.batches).toHaveLength(0);
  });

  it("treats corrupt, mismatched-ID and low-confidence cached data as misses", async () => {
    const cache = createPredictionCache();
    const provider = fixtureProvider();
    const batch = inputs();
    for (const [index, raw] of ["not JSON", JSON.stringify(prediction("wrong")), JSON.stringify(prediction("id-2", 0.5))].entries()) {
      const key = predictionCacheKey(batch[index], provider);
      ledger().prepare("INSERT INTO feedback_prediction_cache (cache_key, prediction_json) VALUES (?, ?)").run(key, raw);
    }
    let calls = 0;
    const result = await classifyFeedback(batch, { provider: fixtureProvider(undefined, () => calls++), cache });
    expect(calls).toBe(1);
    expect(result.cacheHits).toBe(0);
    expect(result.accepted).toHaveLength(3);
  });

  it("separates keys by all input fields, provider, model, prompt and schema, excluding extra metadata", () => {
    const input = inputs()[0];
    const context = { provider: "gemini" as const, model: "model-a" };
    const key = predictionCacheKey(input, context);
    const variants = [
      predictionCacheKey({ ...input, text: "changed" }, context),
      predictionCacheKey({ ...input, id: "changed" }, context),
      predictionCacheKey({ ...input, segment: "at_risk" }, context),
      predictionCacheKey({ ...input, source: "cancel_flow" }, context),
      predictionCacheKey(input, { ...context, provider: "groq" }),
      predictionCacheKey(input, { ...context, model: "model-b" }),
      predictionCacheKey(input, { ...context, promptVersion: "next" }),
      predictionCacheKey(input, { ...context, schemaVersion: "next" }),
    ];
    expect(new Set([key, ...variants]).size).toBe(9);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(predictionCacheKey({ ...input, pilotIndex: 1 } as ModelInput, context)).toBe(key);
  });

  it("preserves accepted prefix and marks all remaining input unclassified after a terminal provider failure", async () => {
    let calls = 0;
    const provider = createProvider({ provider: "groq", env: { GROQ_API_KEY: "test" }, fetch: async (_url, init) => {
      calls++;
      if (calls === 2) return new Response("quota secret", { status: 429 });
      const batch = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as ModelInput[];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: batch.map((p) => prediction(p.id)) }) } }] }));
    } });
    const result = await classifyFeedback(inputs(45), { provider });
    expect(calls).toBe(2);
    expect(result.accepted).toHaveLength(20);
    expect(result.unclassified).toEqual(inputs(45).slice(20).map(({ id }) => ({ id, cause: "provider_error" })));
    expect(result.stopped).toBe(true);
    expect(result.batches).toHaveLength(2);
    expect(result.batches[1].error?.category).toBe("quota");
  });

  it("revalidates cache writes and keeps input order when hits are interleaved with new predictions", async () => {
    const cache = createPredictionCache();
    const batch = inputs();
    const provider = fixtureProvider();
    cache.set(batch[0], provider, prediction("wrong"));
    cache.set(batch[0], provider, prediction("id-0", 0.6));
    expect(cache.get(batch[0], provider)).toBeUndefined();
    cache.set(batch[1], provider, prediction("id-1"));
    const result = await classifyFeedback(batch, { provider, cache });
    expect(result.accepted.map((p) => p.id)).toEqual(batch.map((p) => p.id));
    expect(result.cacheHits).toBe(1);
    expect(result.schemaValidCount).toBe(3);
  });

  it("continues after a malformed response and preserves the next batch", async () => {
    let calls = 0;
    const provider = createProvider({ provider: "groq", env: { GROQ_API_KEY: "test" }, fetch: async (_url, init) => {
      const batch = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as ModelInput[];
      return new Response(JSON.stringify({ choices: [{ message: { content: ++calls === 1 ? "malformed" : JSON.stringify({ items: batch.map((p) => prediction(p.id)) }) } }] }));
    } });
    const result = await classifyFeedback(inputs(21), { provider });
    expect(calls).toBe(2);
    expect(result.accepted.map((p) => p.id)).toEqual(["id-20"]);
    expect(result.unclassified).toHaveLength(20);
    expect(result.stopped).toBe(false);
    expect(result.batches[0].error?.category).toBe("malformed_json");
  });

  it("makes a fresh evaluation call by default even when the same result is cached", async () => {
    const cache = createPredictionCache();
    const batch = inputs(1);
    const cached = prediction("id-0");
    cache.set(batch[0], fixtureProvider(), cached);
    let calls = 0;
    const fresh = { ...cached, reason: "price" };
    const result = await classifyFeedback(batch, { provider: fixtureProvider([{ items: [fresh] }], () => calls++) });
    expect(calls).toBe(1);
    expect(result.cacheHits).toBe(0);
    expect(result.accepted).toEqual([fresh]);
    expect(cache.get(batch[0], fixtureProvider())).toEqual(cached);
  });
});

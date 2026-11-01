import { expect, it } from "vitest";
import { createMemoryPredictionCache } from "./memory-cache";

const context = { provider: "groq" as const, model: "test-model" };
const input = (id: string, text: string) => ({ id, text, source: "cancel_flow" as const, segment: "at_risk" as const });

it("returns the label for the same input and misses for other text or another model", () => {
  const cache = createMemoryPredictionCache(2);
  cache.set(input("f1", "Too expensive"), context, { id: "f1", intent: "cancel", reason: "price", confidence: 0.9 });
  expect(cache.get(input("f1", "Too expensive"), context)).toEqual({ id: "f1", intent: "cancel", reason: "price", confidence: 0.9 });
  expect(cache.get(input("f1", "Moving abroad"), context)).toBeUndefined();
  expect(cache.get(input("f1", "Too expensive"), { ...context, model: "other-model" })).toBeUndefined();
});

it("stores hashed keys and labels only, and drops the oldest entry beyond its limit", () => {
  const cache = createMemoryPredictionCache(2);
  for (const [i, text] of ["alpha secret", "beta secret", "gamma secret"].entries()) {
    cache.set(input(`f${i}`, text), context, { id: `f${i}`, intent: "stay", reason: "other", confidence: 0.8 });
  }
  expect(cache.size).toBe(2);
  expect(cache.get(input("f0", "alpha secret"), context)).toBeUndefined();
  expect(JSON.stringify(cache.entries())).not.toContain("secret");
  expect(cache.entries().every(([key]) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
});

it("never stores labels below the acceptance threshold", () => {
  const cache = createMemoryPredictionCache();
  cache.set(input("f1", "hmm"), context, { id: "f1", intent: "stay", reason: "other", confidence: 0.4 });
  expect(cache.size).toBe(0);
});

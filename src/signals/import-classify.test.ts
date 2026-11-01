import { expect, it, vi } from "vitest";
import type { FeedbackRow } from "@/import/feedback-csv";
import type { ModelInput } from "./contracts";
import { createMemoryPredictionCache } from "./memory-cache";
import { classifyImportedFeedback } from "./import-classify";
import { emptyMetrics, type ClassificationProvider, type ProviderResult } from "./providers";

function fakeProvider(stopAfter = Infinity) {
  let calls = 0;
  const classify = vi.fn(async (inputs: ModelInput[]): Promise<ProviderResult> => {
    if (++calls > stopAfter) return { metrics: emptyMetrics(), error: { provider: "groq", model: "test-model", category: "timeout", retryCount: 0, quota: {} }, terminal: true };
    return { payload: { items: inputs.map((m) => ({ id: m.id, intent: "cancel", reason: /pric|expensive/i.test(m.text) ? "price" : "other", confidence: m.text === "hmm" ? 0.4 : 0.9 })) }, metrics: emptyMetrics(), terminal: false };
  });
  const provider: ClassificationProvider = { provider: "groq", model: "test-model", classify };
  return { provider, classify };
}
const rows: FeedbackRow[] = [
  { segment: "at_risk", text: "Too expensive now" },
  { segment: "at_risk", text: "Moving abroad" },
  { segment: "core", text: "The price went up" },
  { segment: "new", text: "hmm" },
];

it("counts accepted reasons per segment and leaves low-confidence rows out", async () => {
  const { provider, classify } = fakeProvider();
  const result = await classifyImportedFeedback(rows, { provider, cache: createMemoryPredictionCache() });
  const zero = { price: 0, other: 0 };
  expect(result.reasonCounts).toEqual({ new: zero, core: { price: 1, other: 0 }, price_sensitive: zero, at_risk: { price: 1, other: 1 }, cancel_intent: zero });
  expect(result).toMatchObject({ total: 4, accepted: 3, unclassified: 1, cacheHits: 0, stopped: false });
  expect(result.notes).toContain("3 of 4 rows classified with confidence of at least 0.70; 1 left unclassified and not counted.");
  expect(classify.mock.calls[0][0][0]).toEqual({ id: "f1", text: "Too expensive now", source: "cancel_flow", segment: "at_risk" });
});

it("returns counts and notes only, never the uploaded text", async () => {
  const { provider } = fakeProvider();
  const result = await classifyImportedFeedback(rows, { provider, cache: createMemoryPredictionCache() });
  const serialized = JSON.stringify(result);
  for (const row of rows) expect(serialized).not.toContain(row.text);
});

it("reads the cache first, so the same rows make no second model call", async () => {
  const { provider, classify } = fakeProvider();
  const cache = createMemoryPredictionCache();
  await classifyImportedFeedback(rows.slice(0, 3), { provider, cache });
  const again = await classifyImportedFeedback(rows.slice(0, 3), { provider, cache });
  expect(classify).toHaveBeenCalledTimes(1);
  expect(again).toMatchObject({ accepted: 3, cacheHits: 3 });
  expect(again.notes).toContain("3 reused from this server's in-memory cache (labels only).");
});

it("returns partial counts when classification stops early", async () => {
  const { provider } = fakeProvider(1);
  const many: FeedbackRow[] = Array.from({ length: 25 }, (_, i) => ({ segment: "core", text: `Too expensive ${i}` }));
  const result = await classifyImportedFeedback(many, { provider, cache: createMemoryPredictionCache() });
  expect(result).toMatchObject({ total: 25, accepted: 20, unclassified: 5, stopped: true });
  expect(result.reasonCounts.core).toEqual({ price: 20, other: 0 });
  expect(result.notes).toContain("Classification stopped before every row was classified (time, token or provider limit), so these counts are partial.");
});

it("refuses more than 200 rows before any model call", async () => {
  const { provider, classify } = fakeProvider();
  const tooMany: FeedbackRow[] = Array.from({ length: 201 }, (_, i) => ({ segment: "core", text: `Row ${i}` }));
  await expect(classifyImportedFeedback(tooMany, { provider, cache: createMemoryPredictionCache() })).rejects.toThrow("at most 200");
  expect(classify).not.toHaveBeenCalled();
});

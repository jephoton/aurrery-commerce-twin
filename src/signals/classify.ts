import "server-only";
import { z } from "zod";
import { MIN_CONFIDENCE, PredictionSchema, type ModelInput, type Prediction } from "./contracts";
import { emptyMetrics, type ClassificationProvider, type ProviderMetrics, type SafeProviderError } from "./providers";
import { createPredictionCache, type PredictionCache } from "./cache";
export type UnclassifiedCause = "missing" | "duplicate" | "schema_invalid" | "low_confidence" | "malformed_batch" | "provider_error";
export interface Unclassified { id: string; cause: UnclassifiedCause }
export interface Diagnostic { cause: "unknown_id" | "invalid_item" | "malformed_batch"; id?: string }
export interface BatchValidation { accepted: Prediction[]; unclassified: Unclassified[]; schemaValidCount: number; diagnostics: Diagnostic[] }
export interface BatchResult extends BatchValidation { index: number; inputIds: string[]; metrics: ProviderMetrics; error?: SafeProviderError }
export interface ClassificationResult extends BatchValidation { total: number; cacheHits: number; batches: BatchResult[]; metrics: ProviderMetrics; stopped: boolean }
const batchEnvelope = z.strictObject({ items: z.array(z.unknown()) });

function assertUniqueInputs(inputs: ModelInput[]): void {
  if (inputs.some((input) => !input.id.trim()) || new Set(inputs.map((input) => input.id)).size !== inputs.length) throw new Error("Feedback input IDs must be nonempty and unique");
}

/** Validate members independently, but reject every occurrence of an ambiguous ID. */
export function validateBatch(inputs: ModelInput[], raw: unknown): BatchValidation {
  assertUniqueInputs(inputs);
  const result: BatchValidation = { accepted: [], unclassified: [], schemaValidCount: 0, diagnostics: [] };
  const envelope = batchEnvelope.safeParse(raw);
  if (!envelope.success) return { ...result, unclassified: inputs.map(({ id }) => ({ id, cause: "malformed_batch" })), diagnostics: [{ cause: "malformed_batch" }] };
  const knownIds = new Set(inputs.map(({ id }) => id));
  const byId = new Map<string, unknown[]>();
  for (const item of envelope.data.items) {
    const identified = z.object({ id: z.string() }).safeParse(item);
    if (!identified.success) { result.diagnostics.push({ cause: "invalid_item" }); continue; }
    const id = identified.data.id.trim();
    if (!knownIds.has(id)) { result.diagnostics.push({ cause: "unknown_id", id }); continue; }
    byId.set(id, [...byId.get(id) ?? [], item]);
  }
  for (const input of inputs) {
    const items = byId.get(input.id);
    if (!items) { result.unclassified.push({ id: input.id, cause: "missing" }); continue; }
    if (items.length !== 1) { result.unclassified.push({ id: input.id, cause: "duplicate" }); continue; }
    const parsed = PredictionSchema.safeParse(items[0]);
    if (!parsed.success) { result.unclassified.push({ id: input.id, cause: "schema_invalid" }); continue; }
    result.schemaValidCount++;
    if (parsed.data.confidence < MIN_CONFIDENCE) result.unclassified.push({ id: input.id, cause: "low_confidence" });
    else result.accepted.push(parsed.data);
  }
  return result;
}

/** Cache reuse is opt-in; evaluation's default always makes fresh provider calls. */
export async function classifyFeedback(inputs: ModelInput[], options: {
  provider: ClassificationProvider;
  cache?: boolean | PredictionCache;
  onProgress?: (batch: BatchResult) => void | Promise<void>;
}): Promise<ClassificationResult> {
  assertUniqueInputs(inputs);
  const result: ClassificationResult = { accepted: [], unclassified: [], schemaValidCount: 0, diagnostics: [], total: inputs.length, cacheHits: 0, batches: [], metrics: emptyMetrics(), stopped: false };
  const cache = options.cache === true ? createPredictionCache() : options.cache || undefined;
  const pending: ModelInput[] = [];
  const bulkHits = cache?.getMany ? await cache.getMany(inputs, options.provider) : undefined;
  for (const input of inputs) {
    const hit = bulkHits ? bulkHits.get(input.id) : await cache?.get(input, options.provider);
    if (hit) { result.accepted.push(hit); result.schemaValidCount++; result.cacheHits++; }
    else pending.push(input);
  }
  for (let offset = 0; offset < pending.length; offset += 20) {
    const inputs = pending.slice(offset, offset + 20);
    const response = await options.provider.classify(inputs);
    const validated = response.error
      ? { accepted: [], unclassified: inputs.map(({ id }) => ({ id, cause: "provider_error" as const })), schemaValidCount: 0, diagnostics: [] }
      : validateBatch(inputs, response.payload);
    const batch: BatchResult = { ...validated, index: result.batches.length, inputIds: inputs.map(({ id }) => id), metrics: response.metrics, ...(response.error ? { error: response.error } : {}) };
    result.batches.push(batch);
    result.accepted.push(...batch.accepted);
    result.unclassified.push(...batch.unclassified);
    result.diagnostics.push(...batch.diagnostics);
    result.schemaValidCount += batch.schemaValidCount;
    result.metrics.attempts.push(...response.metrics.attempts);
    result.metrics.latencyMs += response.metrics.latencyMs;
    result.metrics.retries += response.metrics.retries;
    for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) result.metrics.usage[field] += response.metrics.usage[field];
    if (cache) {
      const byId = new Map(inputs.map((input) => [input.id, input]));
      const entries = batch.accepted.map((prediction) => ({ input: byId.get(prediction.id)!, prediction }));
      if (cache.setMany) await cache.setMany(entries, options.provider);
      else for (const entry of entries) await cache.set(entry.input, options.provider, entry.prediction);
    }
    if (response.terminal) {
      result.stopped = true;
      result.unclassified.push(...pending.slice(offset + inputs.length).map(({ id }) => ({ id, cause: "provider_error" as const })));
    }
    await options.onProgress?.(batch);
    if (result.stopped) break;
  }
  const order = new Map(inputs.map(({ id }, index) => [id, index]));
  result.accepted.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  result.unclassified.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return result;
}

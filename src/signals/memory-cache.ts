import "server-only";
import { predictionCacheKey, type PredictionCache } from "./cache";
import { MIN_CONFIDENCE, type Prediction } from "./contracts";

type Label = Omit<Prediction, "id">;
export interface MemoryPredictionCache extends PredictionCache {
  readonly size: number;
  /** For tests: what is held (hashed keys and labels, never text). */
  entries(): [string, Label][];
}

/**
 * Process-memory classifier cache for imported feedback (M6): the persistent cache's SHA-256 keys and the labels only,
 * never text. Bounded; the oldest entry leaves first. Never written to the ledger, so it never travels in an export.
 */
export function createMemoryPredictionCache(limit = 2000): MemoryPredictionCache {
  const store = new Map<string, Label>();
  return {
    get size() { return store.size; },
    entries: () => [...store.entries()].map(([key, label]): [string, Label] => [key, { ...label }]),
    get(input, context) {
      const label = store.get(predictionCacheKey(input, context));
      return label ? { id: input.id, ...label } : undefined;
    },
    set(input, context, prediction) {
      if (!(prediction.confidence >= MIN_CONFIDENCE)) return;
      const key = predictionCacheKey(input, context);
      store.delete(key);
      store.set(key, { intent: prediction.intent, reason: prediction.reason, confidence: prediction.confidence });
      while (store.size > limit) store.delete(store.keys().next().value as string);
    },
  };
}

/** Shared by the import classification route for the life of this server process. */
export const importPredictionCache = createMemoryPredictionCache();

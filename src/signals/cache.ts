import "server-only";
import { createHash } from "node:crypto";
import { ledger } from "@/ledger/db";
import { MIN_CONFIDENCE, PredictionSchema, PROMPT_VERSION, SCHEMA_VERSION, type ModelInput, type Prediction } from "./contracts";
import { toModelInput } from "./corpus";
import type { ProviderName } from "./providers";

export interface CacheContext { provider: ProviderName; model: string; promptVersion?: string; schemaVersion?: string }
export interface PredictionCache {
  get(input: ModelInput, context: CacheContext): Prediction | undefined;
  set(input: ModelInput, context: CacheContext, prediction: Prediction): void;
}
export function predictionCacheKey(input: ModelInput, context: CacheContext): string {
  return createHash("sha256").update(JSON.stringify({ input: toModelInput(input), provider: context.provider, model: context.model, promptVersion: context.promptVersion ?? PROMPT_VERSION, schemaVersion: context.schemaVersion ?? SCHEMA_VERSION })).digest("hex");
}
export function createPredictionCache(): PredictionCache {
  const db = ledger();
  db.exec("CREATE TABLE IF NOT EXISTS feedback_prediction_cache (cache_key TEXT PRIMARY KEY, prediction_json TEXT NOT NULL)");
  return {
    get(input, context) {
      const row = db.prepare("SELECT prediction_json FROM feedback_prediction_cache WHERE cache_key = ?").get(predictionCacheKey(input, context));
      if (!row) return undefined;
      try {
        const parsed = PredictionSchema.safeParse(JSON.parse(String(row.prediction_json)) as unknown);
        if (parsed.success && parsed.data.id === input.id && parsed.data.confidence >= MIN_CONFIDENCE) return parsed.data;
      } catch { /* Invalid persisted values are cache misses. */ }
      return undefined;
    },
    set(input, context, prediction) {
      const parsed = PredictionSchema.safeParse(prediction);
      if (!parsed.success || parsed.data.id !== input.id || parsed.data.confidence < MIN_CONFIDENCE) return;
      db.prepare("INSERT OR REPLACE INTO feedback_prediction_cache (cache_key, prediction_json) VALUES (?, ?)").run(predictionCacheKey(input, context), JSON.stringify(parsed.data));
    },
  };
}

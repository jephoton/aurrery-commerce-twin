import "server-only";
import { createHash } from "node:crypto";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor } from "@/ledger/connection";
import { authoritativeWrite } from "@/ledger/operations";
import { MIN_CONFIDENCE, PredictionSchema, PROMPT_VERSION, SCHEMA_VERSION, type ModelInput, type Prediction } from "./contracts";
import { toModelInput } from "./corpus";
import type { ProviderName } from "./providers";

export interface CacheContext { provider: ProviderName; model: string; promptVersion?: string; schemaVersion?: string }
export type MaybePromise<T> = T | Promise<T>;
export interface PredictionCache {
  get(input: ModelInput, context: CacheContext): MaybePromise<Prediction | undefined>;
  set(input: ModelInput, context: CacheContext, prediction: Prediction): MaybePromise<void>;
  getMany?(inputs: ModelInput[], context: CacheContext): MaybePromise<Map<string, Prediction>>;
  setMany?(entries: { input: ModelInput; prediction: Prediction }[], context: CacheContext): MaybePromise<void>;
}
export function predictionCacheKey(input: ModelInput, context: CacheContext): string {
  return createHash("sha256").update(JSON.stringify({ input: toModelInput(input), provider: context.provider, model: context.model, promptVersion: context.promptVersion ?? PROMPT_VERSION, schemaVersion: context.schemaVersion ?? SCHEMA_VERSION })).digest("hex");
}

function valid(raw: unknown, id: string): Prediction | undefined {
  try {
    const parsed = PredictionSchema.safeParse(JSON.parse(String(raw)) as unknown);
    if (parsed.success && parsed.data.id === id && parsed.data.confidence >= MIN_CONFIDENCE) return parsed.data;
  } catch { /* Invalid persisted values are cache misses. */ }
  return undefined;
}

export function cacheRows(entries: { input: ModelInput; prediction: Prediction }[], context: CacheContext): [string, string][] {
  return entries.flatMap(({ input, prediction }) => {
    const parsed = PredictionSchema.safeParse(prediction);
    return parsed.success && parsed.data.id === input.id && parsed.data.confidence >= MIN_CONFIDENCE
      ? [[predictionCacheKey(input, context), JSON.stringify(parsed.data)]] : [];
  });
}

/** A single parameterized statement per accepted classifier batch. */
export async function writeCacheRows(tx: LedgerExecutor, rows: [string, string][]): Promise<void> {
  if (!rows.length) return;
  const placeholders = rows.map(() => "(?, ?)").join(", ");
  await tx.execute(`INSERT OR REPLACE INTO feedback_prediction_cache (cache_key, prediction_json) VALUES ${placeholders}`, rows.flat());
}

/** Defaults to the selected authoritative runtime backend; a connection can be injected for offline tests. */
export function createPredictionCache(injected?: LedgerConnection): PredictionCache {
  const connection = () => injected ? Promise.resolve(injected) : runtimeLedgerConnection();
  const cache: PredictionCache = {
    async get(input, context) {
      const hits = await cache.getMany!([input], context);
      return hits.get(input.id);
    },
    async getMany(inputs, context) {
      const hits = new Map<string, Prediction>();
      if (!inputs.length) return hits;
      for (let start = 0; start < inputs.length; start += 200) {
        const chunk = inputs.slice(start, start + 200);
        const byKey = new Map(chunk.map((input) => [predictionCacheKey(input, context), input.id]));
        const keys = [...byKey.keys()];
        const rows = await (await connection()).query(`SELECT cache_key, prediction_json FROM feedback_prediction_cache WHERE cache_key IN (${keys.map(() => "?").join(",")})`, keys);
        for (const row of rows) {
          const id = byKey.get(String(row.cache_key));
          if (id) {
            const prediction = valid(row.prediction_json, id);
            if (prediction) hits.set(id, prediction);
          }
        }
      }
      return hits;
    },
    async set(input, context, prediction) { await cache.setMany!([{ input, prediction }], context); },
    async setMany(entries, context) {
      const rows = cacheRows(entries, context);
      if (!rows.length) return;
      await authoritativeWrite(await connection(), (tx) => writeCacheRows(tx, rows));
    },
  };
  return cache;
}

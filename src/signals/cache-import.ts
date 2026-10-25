import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ledger } from "@/ledger/db";
import { createPredictionCache, type CacheContext, type PredictionCache } from "./cache";
import { MIN_CONFIDENCE, PredictionSchema, PROMPT_VERSION, SCHEMA_VERSION, type Prediction } from "./contracts";
import { corpusVersion, feedbackCorpus, toModelInput } from "./corpus";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA } from "./prompt";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const contextSchema = z.object({ provider: z.enum(["gemini", "groq"]), model: z.string().regex(/^[a-zA-Z0-9_./-]{1,120}$/) });
const artifactSchema = z.object({ evaluation: z.object({
  provider: z.enum(["gemini", "groq"]), model: z.string(),
  dimensions: z.object({ corpusVersion: z.string(), promptVersion: z.string(), schemaVersion: z.string(), fixtureSha256: z.string(), inputSha256: z.string(), promptSha256: z.string(), schemaSha256: z.string(), hashEncoding: z.literal("JSON.stringify / UTF-8") }),
  cache: z.object({ enabled: z.literal(false), hits: z.literal(0) }),
  classification: z.object({ accepted: z.array(PredictionSchema), total: z.literal(200), schemaValidCount: z.literal(200), cacheHits: z.literal(0), stopped: z.literal(false), unclassified: z.array(z.unknown()).length(0), diagnostics: z.array(z.unknown()).length(0) }),
}) });
/** Pure validation: the source's scoring/truth fields are never read or imported. */
export function validateSignalCacheArtifact(source: unknown, context: CacheContext): Prediction[] {
  const configured = contextSchema.safeParse(context);
  const parsed = artifactSchema.safeParse(source);
  const fail = () => { throw new Error("Cache import rejected: a complete fresh evaluation matching the configured classifier and current fingerprints is required."); };
  if (!configured.success || !parsed.success) return fail();
  if ((context.promptVersion !== undefined && context.promptVersion !== PROMPT_VERSION) || (context.schemaVersion !== undefined && context.schemaVersion !== SCHEMA_VERSION)) return fail();
  const evaluation = parsed.data.evaluation;
  if (evaluation.provider !== configured.data.provider || evaluation.model !== configured.data.model) return fail();
  const expected = {
    corpusVersion, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION,
    fixtureSha256: hash(JSON.stringify({ corpusVersion, messages: feedbackCorpus })),
    inputSha256: hash(JSON.stringify(feedbackCorpus.map(toModelInput))),
    promptSha256: hash(CLASSIFICATION_INSTRUCTION), schemaSha256: hash(JSON.stringify(CLASSIFICATION_JSON_SCHEMA)),
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (evaluation.dimensions[key] !== expected[key]) return fail();
  const predictions = evaluation.classification.accepted;
  const expectedIds = new Set(feedbackCorpus.map(({ id }) => id));
  const seen = new Set<string>();
  if (expectedIds.size !== 200 || predictions.length !== 200) return fail();
  for (const prediction of predictions) {
    if (!expectedIds.has(prediction.id) || seen.has(prediction.id) || prediction.confidence < MIN_CONFIDENCE) return fail();
    seen.add(prediction.id);
  }
  return predictions;
}
/** Validate everything before any write; a failed insert rolls back the whole import. */
export function importSignalCache(source: unknown, context: CacheContext, options: { cache?: PredictionCache } = {}) {
  const predictions = validateSignalCacheArtifact(source, context);
  const inputs = new Map(feedbackCorpus.map(toModelInput).map((input) => [input.id, input]));
  const cache = options.cache ?? createPredictionCache();
  const db = ledger();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const prediction of predictions) cache.set(inputs.get(prediction.id)!, context, prediction);
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    throw new Error("Cache import failed; all writes rolled back.");
  }
  return { provider: context.provider, model: context.model, imported: predictions.length };
}

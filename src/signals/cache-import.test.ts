import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { importSignalCache, validateSignalCacheArtifact } from "./cache-import";
import { corpusVersion, feedbackCorpus, toModelInput } from "./corpus";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./contracts";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA } from "./prompt";
import { createPredictionCache } from "./cache";
import { ledger } from "@/ledger/db";
const context = { provider: "groq" as const, model: "openai/gpt-oss-120b" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function artifact() {
  return { evaluation: {
    ...context,
    dimensions: { corpusVersion, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, fixtureSha256: hash(JSON.stringify({ corpusVersion, messages: feedbackCorpus })), inputSha256: hash(JSON.stringify(feedbackCorpus.map(toModelInput))), promptSha256: hash(CLASSIFICATION_INSTRUCTION), schemaSha256: hash(JSON.stringify(CLASSIFICATION_JSON_SCHEMA)), hashEncoding: "JSON.stringify / UTF-8" },
    cache: { enabled: false, hits: 0 },
    classification: { accepted: feedbackCorpus.map((m) => ({ id: m.id, intent: "stay", reason: "other", confidence: .8 })), total: 200, schemaValidCount: 200, cacheHits: 0, stopped: false, unclassified: [], diagnostics: [] },
  } };
}
describe("explicit classifier cache import", () => {
  it("accepts a complete Gemini evaluation only under its actual selected provider and model", () => {
    const gemini = { provider: "gemini" as const, model: "gemini-3.5-flash-lite" };
    const source = artifact();
    Object.assign(source.evaluation, gemini);
    expect(importSignalCache(source, gemini)).toEqual({ ...gemini, imported: 200 });
    const cache = createPredictionCache();
    expect(cache.get(toModelInput(feedbackCorpus[0]), gemini)?.id).toBe(feedbackCorpus[0].id);
    const set = vi.fn();
    for (const configured of [context, { ...gemini, model: "other-model" }, { ...gemini, provider: "groq" as const }]) {
      expect(() => importSignalCache(source, configured, { cache: { get: () => undefined, set } })).toThrow();
    }
    expect(() => importSignalCache(artifact(), gemini, { cache: { get: () => undefined, set } })).toThrow();
    expect(set).not.toHaveBeenCalled();
  });
  it("validates the complete fresh evaluation and writes all 200 projected inputs", () => {
    const source = artifact();
    expect(validateSignalCacheArtifact(source, context)).toHaveLength(200);
    expect(importSignalCache(source, context)).toEqual({ ...context, imported: 200 });
    const cache = createPredictionCache();
    feedbackCorpus.forEach((m) => expect(cache.get(toModelInput(m), context)?.id).toBe(m.id));
  });
  it.each(["provider", "model", "corpusVersion", "promptVersion", "schemaVersion", "fixtureSha256", "inputSha256", "promptSha256", "schemaSha256", "hashEncoding"])("rejects changed %s before writing any cache entries", (field) => {
    const source = artifact();
    if (field === "provider" || field === "model") (source.evaluation as Record<string, unknown>)[field] = "wrong";
    else (source.evaluation.dimensions as Record<string, string>)[field] = "wrong";
    const set = vi.fn();
    expect(() => importSignalCache(source, context, { cache: { get: () => undefined, set } })).toThrow();
    expect(set).not.toHaveBeenCalled();
  });
  it.each(["cached", "hits", "wrong_id", "duplicate", "low_confidence", "unknown_field", "partial", "wrong_total", "stopped"])("rejects %s without partial inserts", (kind) => {
    const source = artifact();
    const c = source.evaluation.classification;
    if (kind === "cached") source.evaluation.cache.enabled = true;
    if (kind === "hits") c.cacheHits = 1;
    if (kind === "wrong_id") c.accepted[199].id = "unknown";
    if (kind === "duplicate") c.accepted[199].id = c.accepted[0].id;
    if (kind === "low_confidence") c.accepted[199].confidence = .69;
    if (kind === "unknown_field") Object.assign(c.accepted[199], { targets: ["I-UNKNOWN"] });
    if (kind === "partial") c.accepted.pop();
    if (kind === "wrong_total") c.total = 199;
    if (kind === "stopped") c.stopped = true;
    const set = vi.fn();
    expect(() => importSignalCache(source, context, { cache: { get: () => undefined, set } })).toThrow();
    expect(set).not.toHaveBeenCalled();
  });
  it("rolls back all persisted inserts when an insert fails", () => {
    const cache = createPredictionCache();
    ledger().exec("DELETE FROM feedback_prediction_cache");
    let writes = 0;
    expect(() => importSignalCache(artifact(), context, { cache: { get: cache.get, set(input, ctx, prediction) { cache.set(input, ctx, prediction); if (++writes === 2) throw new Error("disk failure"); } } })).toThrow();
    expect(ledger().prepare("SELECT COUNT(*) AS count FROM feedback_prediction_cache").get()?.count).toBe(0);
  });
  it("rejects cache contexts overriding the current prompt or schema versions", () => {
    expect(() => validateSignalCacheArtifact(artifact(), { ...context, promptVersion: "old" })).toThrow();
    expect(() => validateSignalCacheArtifact(artifact(), { ...context, schemaVersion: "old" })).toThrow();
  });
});

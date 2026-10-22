import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { DEFAULT_OPTIONS, type compareStrategies } from "@/twin/simulate";
import { feedbackCorpus, loadGroundTruth, toModelInput } from "./corpus";
import { evaluateComparison, evaluateProvider, parseEvaluationArgs, writeEvaluationArtifacts } from "./evaluate";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./contracts";
import type { ProviderConfig, ProviderName } from "./providers";

const labels = ["A", "B", "C", "D"];
const registryRows = labels.map((label, i) => ({ label, subscriptionId: `I-NEW${i}` }));
const tinyComparison: typeof compareStrategies = (twin, _strategies, options) => ({ merchantId: twin.merchant.id, options: { ...DEFAULT_OPTIONS, ...options }, baselineId: "baseline", strategies: [] });
async function fakeProvider(provider: ProviderName, failBatch?: number) {
  const truth = await loadGroundTruth();
  const bodies: Record<string, unknown>[] = [];
  let classifications = 0;
  const config: ProviderConfig = { provider, env: { GEMINI_API_KEY: "secret-test-key", GROQ_API_KEY: "secret-test-key", AI_PROVIDER: "groq" }, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const isClassification = provider === "gemini" ? !!body.systemInstruction : !!body.response_format;
    if (isClassification && ++classifications === failBatch) return new Response("secret-test-key raw error", { status: 429, headers: { "x-ratelimit-remaining-requests": "0" } });
    let payload: object;
    if (isClassification) {
      const inputs = JSON.parse(provider === "gemini" ? body.contents[0].parts[0].text : body.messages[1].content) as { id: string }[];
      const content = JSON.stringify({ items: inputs.map(({ id }) => ({ id, ...truth[id], confidence: 0.99 })) });
      payload = provider === "gemini" ? { candidates: [{ content: { parts: [{ text: content }] } }] } : { choices: [{ message: { content } }] };
    } else {
      const first = provider === "gemini" ? body.contents.length === 1 : body.messages.length === 1;
      const content = JSON.stringify({ merchant: "Evaluation Roasters", listPrice: 31.73 });
      payload = provider === "gemini"
        ? { candidates: [{ content: { role: "model", parts: first ? [{ functionCall: { name: "get_merchant_state", args: {} } }] : [{ text: content }] } }] }
        : { choices: [{ message: first ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "get_merchant_state", arguments: "{}" } }] } : { role: "assistant", content } }] };
    }
    return new Response(JSON.stringify({ ...payload, usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }));
  } };
  return { config, bodies };
}
describe("evaluation arguments", () => {
  it("defaults to fresh Gemini then Groq with proactive 30-second pacing", () => {
    expect(parseEvaluationArgs([])).toEqual({ providers: ["gemini", "groq"], useCache: false, batchDelayMs: 30_000 });
    expect(parseEvaluationArgs(["--provider=groq", "--use-cache", "--batch-delay-ms=0"])).toEqual({ providers: ["groq"], useCache: true, batchDelayMs: 0 });
  });
  it.each(["--provider=other", "--batch-delay-ms=60001", "--batch-delay-ms=-1", "--batch-delay-ms=NaN", "--unknown=secret-test-key"])("rejects unsupported flag %s without echoing values", (arg) => {
    expect(() => parseEvaluationArgs([arg])).toThrow("Invalid evaluation arguments");
  });
  it("requires an explicit single-provider diagnostic for cache reuse", () => {
    expect(() => parseEvaluationArgs(["--use-cache"])).toThrow("Cache reuse requires --provider");
  });
});
describe("provider evaluation", () => {
  it.each(["gemini", "groq"] as const)("scores %s, paces only between successful batches, maps current pilots and simulates copies", async (provider) => {
    const { config, bodies } = await fakeProvider(provider);
    const sleep = vi.fn(async () => {});
    const events: unknown[] = [];
    const twin = buildDemoTwin().twin;
    const before = structuredClone(twin);
    const simulate = vi.fn(tinyComparison);
    const result = await evaluateProvider(config, { registryRows, labels, twin, sleep, onProgress: (event) => { events.push(event); }, simulate });
    expect(result.score).toMatchObject({ suitable: true, acceptedCoverage: 1, wholeCorpusAgreement: { joint: 1 } });
    expect(result.classification.accepted).toHaveLength(200);
    expect(result.pilots.eligibleSubscriptionIds).toEqual(["I-NEW0", "I-NEW1"]);
    expect(result.tool.passed).toBe(true);
    expect(result.metrics.usage.totalTokens).toBe(60);
    expect(result.accountTier).toBe("unverified");
    expect(result.cache).toEqual({ enabled: false, hits: 0 });
    expect(result.dimensions).toMatchObject({ corpusVersion: "feedback-corpus-v1", promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, inputSha256: createHash("sha256").update(JSON.stringify(feedbackCorpus.map(toModelInput))).digest("hex") });
    expect(result.dimensions.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dimensions.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sleep.mock.calls).toEqual(Array.from({ length: 9 }, () => [30_000]));
    expect(events).toHaveLength(19);
    expect(events[1]).toMatchObject({ kind: "delay", delayMs: 30_000 });
    expect(bodies).toHaveLength(12);
    for (const body of bodies.slice(0, 10)) {
      const inputs = JSON.parse(provider === "gemini" ? (body.contents as { parts: { text: string }[] }[])[0].parts[0].text : (body.messages as { content: string }[])[1].content);
      expect(Object.keys(inputs[0]).sort()).toEqual(["id", "segment", "source", "text"]);
    }
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(simulate.mock.calls[0][2]).toEqual(DEFAULT_OPTIONS);
    expect(simulate.mock.calls[1][2]).toEqual(DEFAULT_OPTIONS);
    expect(simulate.mock.calls[1][0]).not.toBe(twin);
    expect(result.roundTrip).toMatchObject({ available: true, options: DEFAULT_OPTIONS, source: "AI-classified synthetic feedback", base: { strategies: [] }, updated: { strategies: [] } });
    expect(twin).toEqual(before);
  });
  it("keeps accepted evidence after quota, skips smoke and never delays after terminal failure", async () => {
    const { config, bodies } = await fakeProvider("gemini", 2);
    const sleep = vi.fn(async () => {});
    const result = await evaluateProvider(config, { registryRows, labels, sleep, simulate: tinyComparison });
    expect(bodies).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.classification.accepted).toHaveLength(20);
    expect(result.tool).toMatchObject({ passed: false, skipped: true, reason: "classification_stopped" });
    expect(result.roundTrip.available).toBe(true);
    expect(result.score.suitable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
  it("reports round trip unavailable without accepted evidence and exposes safe quota errors", async () => {
    const { config, bodies } = await fakeProvider("groq", 1);
    const sleep = vi.fn(async () => {});
    const simulate = vi.fn(tinyComparison);
    const result = await evaluateProvider(config, { registryRows, labels, sleep, simulate });
    expect(result.roundTrip).toEqual({ available: false, reason: "no_accepted_evidence" });
    expect(result.classification.batches[0].error?.category).toBe("quota");
    expect(simulate).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("forwards explicit cache use and marks hits", async () => {
    const first = await fakeProvider("groq");
    const initial = await evaluateProvider(first.config, { registryRows, labels, useCache: true, batchDelayMs: 0, simulate: tinyComparison });
    const second = await fakeProvider("groq");
    const reused = await evaluateProvider(second.config, { registryRows, labels, useCache: true, simulate: tinyComparison });
    expect(initial.cache.enabled).toBe(true);
    expect(reused.cache).toEqual({ enabled: true, hits: 200 });
    expect(second.bodies).toHaveLength(2);
    const fresh = await fakeProvider("groq");
    const rerun = await evaluateProvider(fresh.config, { registryRows, labels, batchDelayMs: 0, simulate: tinyComparison });
    expect(rerun.cache).toEqual({ enabled: false, hits: 0 });
    expect(fresh.bodies).toHaveLength(12);
  });
});
it("compares in explicit order after a first failure, ranks qualifying candidates and saves both unique artifacts", async () => {
  const order: string[] = [];
  const configs = [await fakeProvider("gemini", 1), await fakeProvider("groq")];
  const report = await evaluateComparison(parseEvaluationArgs(["--batch-delay-ms=0"]), async (provider, options) => {
    order.push(provider);
    expect(options.useCache).toBe(false);
    return evaluateProvider(configs.find((entry) => entry.config.provider === provider)!.config, { ...options, registryRows, labels, simulate: tinyComparison });
  });
  expect(order).toEqual(["gemini", "groq"]);
  expect(report.qualifyingCandidates).toEqual(["groq"]);
  expect(report.exitCode).toBe(0);
  expect(report.selection).toBe("pending_review");
  const directory = await mkdtemp(join(tmpdir(), "aurrery-evaluation-"));
  try {
    const first = await writeEvaluationArtifacts(report, directory);
    const second = await writeEvaluationArtifacts(report, directory);
    expect(new Set([...first, ...second]).size).toBe(4);
    expect(await readdir(directory)).toHaveLength(4);
    const text = await readFile(first[0], "utf8");
    expect(text).toContain('"provider": "gemini"');
    expect(text).not.toContain("secret-test-key");
    expect(JSON.parse(text).comparison.order).toEqual(["gemini", "groq"]);
    expect(first[0]).toMatch(/signals-eval-.*-[a-f0-9-]{36}\.json$/);
  } finally { await rm(directory, { recursive: true }); }
});
it("continues after an unexpected runner failure without exposing exceptions, and exits nonzero if neither qualifies", async () => {
  const config = (await fakeProvider("groq", 1)).config;
  const order: string[] = [];
  const report = await evaluateComparison(parseEvaluationArgs([]), async (provider, options) => {
    order.push(provider);
    if (provider === "gemini") throw new Error("secret-test-key request details");
    return evaluateProvider(config, { ...options, registryRows, labels, simulate: tinyComparison });
  });
  expect(order).toEqual(["gemini", "groq"]);
  expect(report.results[0]).toMatchObject({ provider: "gemini", failure: "evaluation_failed" });
  expect(report.exitCode).toBe(1);
  expect(JSON.stringify(report)).not.toContain("secret-test-key");
});

it("never ranks cached diagnostics as comparison candidates", async () => {
  const { config } = await fakeProvider("groq");
  const report = await evaluateComparison(parseEvaluationArgs(["--provider=groq", "--use-cache", "--batch-delay-ms=0"]), async (_provider, options) => evaluateProvider(config, { ...options, registryRows, labels, simulate: tinyComparison }));
  expect(report.diagnostic).toBe(true);
  expect(report.qualifyingCandidates).toEqual([]);
  expect(report.selection).toBe("pending_review");
});

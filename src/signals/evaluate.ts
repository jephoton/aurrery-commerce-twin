import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { compareStrategies, type ComparisonResult } from "@/twin/simulate";
import type { MerchantTwin } from "@/twin/types";
import { classifyFeedback, type BatchResult, type ClassificationResult } from "./classify";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./contracts";
import { corpusVersion, feedbackCorpus, loadGroundTruth, toModelInput } from "./corpus";
import { applyEvidence, pilotEligibility, summarizeEvidence, type PilotEligibilityReport } from "./evidence";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA } from "./prompt";
import { createProvider, emptyMetrics, type ProviderConfig, type ProviderMetrics, type ProviderName } from "./providers";
import { scoreClassification, type ClassificationScore } from "./score";
import { sumMetrics, toolSmoke, type ToolSmokeResult } from "./tool-smoke";

export interface EvaluationArgs { providers: ProviderName[]; useCache: boolean; batchDelayMs: number }
function checkDelay(delay: number): void {
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("Invalid evaluation arguments");
}
export function parseEvaluationArgs(args: string[]): EvaluationArgs {
  const options: EvaluationArgs = { providers: ["gemini", "groq"], useCache: false, batchDelayMs: 30_000 };
  const seen = new Set<string>();
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (seen.has(flag)) throw new Error("Invalid evaluation arguments");
    seen.add(flag);
    if (arg === "--use-cache") options.useCache = true;
    else if (arg === "--provider=gemini" || arg === "--provider=groq") options.providers = [arg.slice(11) as ProviderName];
    else if (/^--batch-delay-ms=\d+$/.test(arg)) options.batchDelayMs = Number(arg.slice(17));
    else throw new Error("Invalid evaluation arguments");
  }
  checkDelay(options.batchDelayMs);
  if (options.useCache && options.providers.length !== 1) throw new Error("Cache reuse requires --provider");
  return options;
}

export type EvaluationProgress = { kind: "batch"; provider: ProviderName; model: string; batch: BatchResult }
  | { kind: "delay"; provider: ProviderName; model: string; delayMs: number };
export interface ProviderEvaluationOptions {
  registryRows: readonly { label: string; subscriptionId: string }[];
  labels: readonly string[];
  useCache?: boolean;
  batchDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (event: EvaluationProgress) => void | Promise<void>;
  twin?: MerchantTwin;
  simulate?: typeof compareStrategies;
}
const simulationOptions = { runs: 1000, horizonMonths: 12, seed: 20261113 };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function compactComparison(comparison: ComparisonResult) {
  return {
    merchantId: comparison.merchantId, baselineId: comparison.baselineId,
    strategies: comparison.strategies.map(({ strategy, metrics, vsBaseline, probValueBelowBaseline, probProfitBelowBaseline }) => ({
      id: strategy.id, name: strategy.name, metrics, vsBaseline, probValueBelowBaseline, probProfitBelowBaseline,
    })),
  };
}
type RoundTrip = { available: false; reason: "no_accepted_evidence" } | {
  available: true;
  source: "AI-classified synthetic feedback";
  options: typeof simulationOptions;
  base: ReturnType<typeof compactComparison>;
  updated: ReturnType<typeof compactComparison>;
  changeInMedianTotalValue: { strategyId: string; delta: number }[];
  provenance: MerchantTwin["provenance"];
};
export interface ProviderEvaluation {
  provider: ProviderName;
  model: string;
  accountTier: "unverified";
  freeCapacityEvidence: "unverified";
  usageMeaning: "reported token totals; absent usage counts as zero, not proof of zero charge";
  dimensions: { corpusVersion: string; promptVersion: string; schemaVersion: string; fixtureSha256: string; inputSha256: string; truthSha256: string; promptSha256: string; schemaSha256: string; hashEncoding: "JSON.stringify / UTF-8" };
  cache: { enabled: boolean; hits: number };
  batchDelayMs: number;
  classification: ClassificationResult;
  score: ClassificationScore;
  evidence: ReturnType<typeof summarizeEvidence>;
  pilots: PilotEligibilityReport;
  tool: ToolSmokeResult;
  roundTrip: RoundTrip;
  metrics: ProviderMetrics;
  elapsedMs: number;
}

/** Hidden labels enter scoring only. Both providers receive the same allowlisted inputs. */
export async function evaluateProvider(config: ProviderConfig, options: ProviderEvaluationOptions): Promise<ProviderEvaluation> {
  const started = performance.now();
  const delayMs = options.batchDelayMs ?? 30_000;
  checkDelay(delayMs);
  const provider = createProvider(config);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let previousSucceeded = false;
  // Pace immediately before a subsequent batch, so no sleep follows the final batch or an error.
  const paced = { ...provider, async classify(inputs: Parameters<typeof provider.classify>[0]) {
    if (previousSucceeded && delayMs) {
      await options.onProgress?.({ kind: "delay", provider: provider.provider, model: provider.model, delayMs });
      await sleep(delayMs);
    }
    const result = await provider.classify(inputs);
    previousSucceeded = !result.error;
    return result;
  } };
  const inputs = feedbackCorpus.map(toModelInput);
  const classification = await classifyFeedback(inputs, {
    provider: paced, cache: options.useCache ?? false,
    onProgress: async (batch) => { await options.onProgress?.({ kind: "batch", provider: provider.provider, model: provider.model, batch }); },
  });
  const tool: ToolSmokeResult = classification.stopped
    ? { passed: false, skipped: true, reason: "classification_stopped", metrics: emptyMetrics() }
    : await toolSmoke(config);
  const truth = await loadGroundTruth();
  const score = scoreClassification(feedbackCorpus, truth, classification, tool.passed);
  const evidence = summarizeEvidence(feedbackCorpus, classification.accepted);
  const pilots = pilotEligibility(feedbackCorpus, classification.accepted, options.registryRows, options.labels);
  let roundTrip: RoundTrip = { available: false, reason: "no_accepted_evidence" };
  if (classification.accepted.length) {
    const twin = options.twin ?? buildDemoTwin().twin;
    const updated = applyEvidence(twin, feedbackCorpus, classification.accepted);
    const simulate = options.simulate ?? compareStrategies;
    const baseResult = simulate(twin, STARTER_STRATEGIES, { ...simulationOptions });
    const updatedResult = simulate(updated, STARTER_STRATEGIES, { ...simulationOptions });
    roundTrip = {
      available: true, source: "AI-classified synthetic feedback", options: { ...simulationOptions },
      base: compactComparison(baseResult), updated: compactComparison(updatedResult),
      changeInMedianTotalValue: updatedResult.strategies.map((strategy) => ({ strategyId: strategy.strategy.id, delta: strategy.metrics.totalValue.p50 - baseResult.strategies.find((base) => base.strategy.id === strategy.strategy.id)!.metrics.totalValue.p50 })),
      provenance: updated.provenance,
    };
  }
  return {
    provider: provider.provider, model: provider.model, accountTier: "unverified", freeCapacityEvidence: "unverified",
    usageMeaning: "reported token totals; absent usage counts as zero, not proof of zero charge",
    dimensions: {
      corpusVersion, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION,
      fixtureSha256: sha256(JSON.stringify({ corpusVersion, messages: feedbackCorpus })), inputSha256: sha256(JSON.stringify(inputs)),
      truthSha256: sha256(JSON.stringify(truth)), promptSha256: sha256(CLASSIFICATION_INSTRUCTION), schemaSha256: sha256(JSON.stringify(CLASSIFICATION_JSON_SCHEMA)), hashEncoding: "JSON.stringify / UTF-8",
    },
    cache: { enabled: options.useCache ?? false, hits: classification.cacheHits }, batchDelayMs: delayMs,
    classification, score, evidence, pilots, tool, roundTrip,
    metrics: sumMetrics(classification.metrics, tool.metrics), elapsedMs: performance.now() - started,
  };
}

export interface EvaluationFailure { provider: ProviderName; failure: "evaluation_failed"; accountTier: "unverified" }
export interface EvaluationComparison {
  order: ProviderName[];
  diagnostic: boolean;
  results: (ProviderEvaluation | EvaluationFailure)[];
  qualifyingCandidates: ProviderName[];
  rankingBasis: string;
  selection: "pending_review";
  exitCode: number;
}
export async function evaluateComparison(options: EvaluationArgs, runProvider: (provider: ProviderName, options: Pick<EvaluationArgs, "useCache" | "batchDelayMs">) => Promise<ProviderEvaluation>): Promise<EvaluationComparison> {
  if (options.useCache && options.providers.length !== 1) throw new Error("Cache reuse requires --provider");
  const results: EvaluationComparison["results"] = [];
  for (const provider of options.providers) {
    try { results.push(await runProvider(provider, { useCache: options.useCache, batchDelayMs: options.batchDelayMs })); }
    catch { results.push({ provider, failure: "evaluation_failed", accountTier: "unverified" }); }
  }
  const suitable = results.filter((result): result is ProviderEvaluation => "score" in result && result.score.suitable);
  // Available API metrics cannot establish account billing tier. Free capacity remains unverified;
  // qualifying fresh runs are therefore ordered by joint agreement, then HTTP latency.
  const ranked = options.useCache ? [] : [...suitable].sort((a, b) => b.score.wholeCorpusAgreement.joint - a.score.wholeCorpusAgreement.joint || a.metrics.latencyMs - b.metrics.latencyMs);
  return {
    order: [...options.providers], diagnostic: options.providers.length === 1 || options.useCache, results,
    qualifyingCandidates: ranked.map(({ provider }) => provider),
    rankingBasis: "Demonstrated free capacity first (unverified for all runs), then whole-corpus joint agreement, then HTTP latency. Cached diagnostics are excluded.",
    selection: "pending_review", exitCode: suitable.length ? 0 : 1,
  };
}

/** One artifact per attempted provider; exclusive writes and UUIDs prevent overwrites. */
export async function writeEvaluationArtifacts(comparison: EvaluationComparison, directory = "data"): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const { results, ...summary } = comparison;
  const paths: string[] = [];
  for (const evaluation of results) {
    const path = join(directory, `signals-eval-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify({ evaluation, comparison: summary }, null, 2) + "\n", { flag: "wx" });
    paths.push(path);
  }
  return paths;
}

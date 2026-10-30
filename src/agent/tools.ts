import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { currentMerchant } from "@/merchant";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { createProposal, listSandboxSubscribers, ProposalError, type CreateProposalInput, type Proposal, type SandboxSubscriber } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/setup";
import { feedbackCorpus, toModelInput } from "@/signals/corpus";
import { classifyFeedback, type ClassificationResult } from "@/signals/classify";
import { applyEvidence, pilotEligibility, summarizeEvidence } from "@/signals/evidence";
import { createProvider, type ClassificationProvider } from "@/signals/providers";
import { StrategySchema, BASELINE, type Strategy } from "@/twin/interventions";
import type { compareStrategies, ComparisonResult, StrategyResult } from "@/twin/simulate";
import type { stressTest, StressResult } from "@/twin/stress";
import { runComparison, runStress, WorkerTaskError } from "@/twin/worker-client";
import { SEGMENTS, type MerchantTwin } from "@/twin/types";
import { DEFAULT_DECISION_RULES, DecisionRulesSchema, type AgentEvent, type ClassificationFailure, type ClassificationSummary, type DecisionRules, type ToolResult } from "./contracts";
import { selectedProvider } from "./model";
import { simulationRuns } from "@/hosting/simulation-budget";

// Existing simulator schemas preserve manual API compatibility. Tighten recursively at the tool boundary.
const intervention = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("baseline") }),
  z.strictObject({ kind: z.literal("targeted_discount"), segment: z.enum(["new", "core", "price_sensitive", "at_risk", "cancel_intent"]), reason: z.enum(["price", "any"]), discountPct: z.number().min(5).max(50), months: z.number().int().min(1).max(12), campaignMonths: z.number().int().min(0).max(12) }),
  z.strictObject({ kind: z.literal("list_price_change"), newPrice: z.number().min(5).max(200) }),
  z.strictObject({ kind: z.literal("annual_plan"), discountPct: z.number().min(0).max(40), segments: z.array(z.enum(["new", "core", "price_sensitive", "at_risk", "cancel_intent"])).min(1).max(5) }),
]);
const strictStrategy = StrategySchema.strict().extend({ intervention });
const id = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const text = z.string().trim().min(1).max(2000);
const schemas = {
  get_merchant_state: z.strictObject({}), classify_feedback: z.strictObject({}),
  set_decision_rules: DecisionRulesSchema,
  simulate_strategies: z.strictObject({ strategies: z.array(strictStrategy).min(1).max(6) }),
  stress_test: z.strictObject({ strategyId: id }),
  draft_customer_message: z.strictObject({ strategyId: id, message: text }),
  recommend: z.strictObject({ strategyId: id, rationale: text, tradeoffs: text }),
};
export type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  get_merchant_state: "Read merchant estimates, visible default rules and run progress.",
  classify_feedback: "Classify synthetic feedback using the selected provider and cache; update reason estimates and pilot eligibility.",
  set_decision_rules: "Explicitly set the maximum discount cost, probability of worse value and simulation horizon.",
  simulate_strategies: "Compare candidates cumulatively. The server automatically adds the do-nothing baseline; submit intervention candidates only. Classify feedback and explicitly set rules first; either change invalidates comparisons and stress tests.",
  stress_test: "Test a previously simulated candidate with adverse assumption shifts.",
  draft_customer_message: "Display customer message copy for a simulated candidate. Does not send.",
  recommend: "Create one proposed action from a classified, simulated and stressed candidate within the rules. Merchant approval is separate.",
};
export const TOOL_DEFINITIONS = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  function: { name, description: descriptions[name as ToolName], parameters: z.toJSONSchema(schema) },
}));
class ToolFailure extends Error {
  constructor(readonly code: string, message: string, readonly terminal = false, readonly failure?: ClassificationFailure) { super(message); }
}
const safeClassificationFailure = z.object({ category: z.enum(["configuration", "auth", "model", "request", "quota", "network", "timeout", "server", "malformed_json", "envelope", "response_size"]), status: z.number().int().min(100).max(599).optional() });
export interface ToolContextOptions {
  env?: Record<string, string | undefined>;
  objective?: string;
  twin?: MerchantTwin;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
  registry?: () => SandboxSubscriber[] | Promise<SandboxSubscriber[]>;
  provider?: ClassificationProvider;
  classify?: typeof classifyFeedback;
  simulate?: (...args: Parameters<typeof compareStrategies>) => ComparisonResult | Promise<ComparisonResult>;
  stress?: (...args: Parameters<typeof stressTest>) => StressResult | Promise<StressResult>;
  propose?: (input: CreateProposalInput) => Proposal | Promise<Proposal>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface ToolState {
  twin: MerchantTwin; rules: DecisionRules; rulesExplicit: boolean; classified: boolean;
  revision: number; classification?: ClassificationSummary; comparison?: ComparisonResult;
  stresses: Record<string, StressResult>; proposal?: Proposal;
  terminalFailure?: ClassificationFailure;
}
/** A context is owned by one runner. Model callers only receive dispatch results, never this state. */
export function createToolContext(options: ToolContextOptions = {}) {
  const original = structuredClone(options.twin ?? currentMerchant().twin);
  const objective = text.parse(options.objective ?? "Improve subscription retention");
  const state: ToolState = { twin: structuredClone(original), rules: { ...DEFAULT_DECISION_RULES }, classified: false, rulesExplicit: false, revision: 0, stresses: {} };
  const emit = options.emit ?? (() => {});
  const registry = options.registry ?? listSandboxSubscribers;
  const labels = PILOT_COHORT.map(({ label }) => label);
  let accepted: ClassificationResult["accepted"] = [];
  let strategies = new Map<string, Strategy>();
  const strategyDefinitions = new Map<string, Strategy>([[BASELINE.id, BASELINE]]);
  function checkAbort() { if (options.signal?.aborted) throw new ToolFailure("ABORTED", "Run cancelled."); }
  function invalidate() { state.revision++; strategies = new Map(); state.comparison = undefined; state.stresses = {}; }
  function currentResult(strategyId: string) {
    const result = state.comparison?.strategies.find((r) => r.strategy.id === strategyId);
    if (!result) throw new ToolFailure("PREREQUISITE", "Simulate this strategy in the current context first.");
    return result;
  }
  const runs = simulationRuns(options.env ?? process.env);
  const simulationOptions = () => ({ runs, seed: 20261113, horizonMonths: state.rules.horizonMonths });
  function assumptions() {
    const p = state.twin.params;
    return [
      ...(["price", "other"] as const).map((reason) => ({ parameter: `offerChurnRelativeRisk.${reason}`, mean: p.offerChurnRelativeRisk[reason].shape / p.offerChurnRelativeRisk[reason].rate, source: (state.twin.provenance[`offerChurnRelativeRisk.${reason}`] ?? state.twin.provenance.offerChurnRelativeRisk)?.source ?? "assumption" })),
      { parameter: "postOfferChurnMultiplier", mean: p.postOfferChurnMultiplier.mean, source: state.twin.provenance.postOfferChurnMultiplier?.source ?? "assumption" },
    ];
  }
  function compactResult(result: StrategyResult) {
    const { p10, p50, p90 } = result.vsBaseline.totalValue;
    return { totalValueDelta: { p10, p50, p90 }, chanceWorse: result.probValueBelowBaseline, meanDiscountCost: result.metrics.discountCost.mean };
  }
  async function invoke(name: ToolName, args: unknown): Promise<unknown> {
    checkAbort();
    if (state.terminalFailure && name !== "get_merchant_state") throw new ToolFailure("CLASSIFICATION_FAILED", "Classification failed; start a new run before recommending.", true, state.terminalFailure);
    if (state.proposal && name !== "get_merchant_state") throw new ToolFailure("PROPOSAL_EXISTS", "This run already created a proposal. Review that proposal or start a new run.");
    switch (name) {
      case "get_merchant_state": {
        const active = Object.values(state.twin.initialActive).reduce((sum, count) => sum + count, 0);
        return {
          merchant: state.twin.merchant, asOfMonth: state.twin.asOfMonth,
          metrics: { currency: state.twin.params.currency, listPrice: state.twin.params.listPrice, active, monthlyListRevenue: active * state.twin.params.listPrice, unitFulfilmentCost: state.twin.params.unitCost + state.twin.params.shippingCost },
          segments: SEGMENTS.map((segment) => {
            const p = state.twin.params.segments[segment];
            return { segment, active: state.twin.initialActive[segment], monthlyChurnMean: p.monthlyChurn.alpha / (p.monthlyChurn.alpha + p.monthlyChurn.beta), priceReasonShareMean: p.priceReasonShare.alpha / (p.priceReasonShare.alpha + p.priceReasonShare.beta), reasonShareSource: state.twin.provenance[`segments.${segment}.priceReasonShare`]?.source ?? "assumption" };
          }),
          assumptions: assumptions(), evidenceNote: "Synthetic history estimates churn; classified feedback estimates leaving reasons. Intervention effects are uncertain and stress tested.",
          starterStrategies: STARTER_STRATEGIES,
          baseline: { strategy: BASELINE, automaticallyIncluded: true },
          rules: state.rules, rulesExplicit: state.rulesExplicit, classified: state.classified, classification: state.classification, terminalFailure: state.terminalFailure, revision: state.revision, comparedStrategyIds: [...strategies.keys()], proposalId: state.proposal?.id,
        };
      }
      case "classify_feedback": {
        state.classified = false; state.classification = undefined; invalidate();
        let provider: ClassificationProvider;
        try {
          provider = options.provider ?? createProvider({ ...selectedProvider(options.env ?? process.env), env: options.env });
          if (!z.object({ provider: z.enum(["gemini", "groq"]), model: z.string().regex(/^[a-zA-Z0-9_./-]{1,120}$/) }).safeParse(provider).success) throw new Error("configuration");
        } catch {
          state.terminalFailure = { category: "configuration" };
          throw new ToolFailure("CONFIGURATION", "Configure an explicit supported classifier, model and key.", true, state.terminalFailure);
        }
        let called = false;
        const paced: ClassificationProvider = { ...provider, async classify(inputs) {
          checkAbort();
          if (called) {
            emit({ type: "status", message: "Pacing fresh classification batches for 30 seconds." });
            await (options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(30000, options.signal);
            checkAbort();
          }
          called = true;
          const response = await provider.classify(inputs);
          checkAbort();
          return response;
        } };
        const result = await (options.classify ?? classifyFeedback)(feedbackCorpus.map(toModelInput), {
          provider: paced, cache: true,
          onProgress(batch) { checkAbort(); emit({ type: "status", message: `Classification batch ${batch.index + 1}: ${batch.accepted.length} accepted.` }); },
        });
        checkAbort();
        const evidence = summarizeEvidence(feedbackCorpus, result.accepted);
        const eligibility = pilotEligibility(feedbackCorpus, evidence.accepted, await registry(), labels);
        const updated = applyEvidence(original, feedbackCorpus, evidence.accepted);
        const error = result.batches.find((batch) => batch.error)?.error;
        const failed = result.stopped || !!error;
        checkAbort();
        accepted = evidence.accepted;
        state.twin = updated; state.classified = accepted.length > 0 && !failed;
        state.classification = { provider: provider.provider, model: provider.model, stopped: result.stopped, total: result.total, accepted: accepted.length, unclassified: result.unclassified.length, cacheHits: result.cacheHits, segments: evidence.segments, intents: evidence.intents, eligiblePilotCount: eligibility.eligibleSubscriptionIds.length, pilotCount: eligibility.pilots.length, mappingIssueCount: eligibility.issues.length, source: "AI-classified synthetic feedback" };
        emit({ type: "classification", summary: state.classification, hitmap: evidence.segments, provenance: state.twin.provenance });
        if (failed || accepted.length === 0) {
          const safe = safeClassificationFailure.safeParse(error);
          state.terminalFailure = safe.success ? safe.data : { category: "provider_error" };
          throw new ToolFailure(failed ? "CLASSIFICATION_FAILED" : "NO_ACCEPTED_EVIDENCE", failed ? "Classification failed. Partial evidence is visible, but this run cannot recommend an action." : "Classification produced no accepted evidence; this run cannot recommend an action.", true, state.terminalFailure);
        }
        return state.classification;
      }
      case "set_decision_rules":
        state.rules = DecisionRulesSchema.parse(args); state.rulesExplicit = true; invalidate();
        emit({ type: "rules", rules: state.rules }); return state.rules;
      case "simulate_strategies": {
        const { strategies: candidates } = schemas.simulate_strategies.parse(args);
        const next = new Map(strategies);
        for (const raw of candidates) {
          const candidate = StrategySchema.parse(raw);
          if ((candidate.id === BASELINE.id || candidate.intervention.kind === "baseline") && JSON.stringify(candidate) !== JSON.stringify(BASELINE)) throw new ToolFailure("STRATEGY_CONFLICT", "Server adds do nothing automatically; submit intervention candidates only, or use the exact baseline from get_merchant_state.");
          const existing = next.get(candidate.id) ?? strategyDefinitions.get(candidate.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new ToolFailure("STRATEGY_CONFLICT", "Strategy IDs must retain the same definition in a run.");
          next.set(candidate.id, candidate);
        }
        const comparison = await (options.simulate
          ? options.simulate(state.twin, [...next.values()], simulationOptions())
          : runComparison(state.twin, [...next.values()], simulationOptions(), { signal: options.signal }));
        checkAbort(); strategies = next; state.comparison = comparison;
        for (const [id, strategy] of next) strategyDefinitions.set(id, strategy);
        emit({ type: "comparison", comparison });
        return { options: comparison.options, baselineId: comparison.baselineId, strategies: comparison.strategies.map((result) => ({ strategy: result.strategy, ...compactResult(result) })), assumptions: assumptions() };
      }
      case "stress_test": {
        const { strategyId } = schemas.stress_test.parse(args);
        const result = currentResult(strategyId);
        const stress = await (options.stress
          ? options.stress(state.twin, result.strategy, simulationOptions())
          : runStress(state.twin, result.strategy, simulationOptions(), { signal: options.signal }));
        checkAbort(); state.stresses[strategyId] = stress;
        emit({ type: "stress", strategyId, stress });
        return { strategyId, shifted: stress.shifted, base: compactResult(stress.base), stressed: compactResult(stress.stressed), comparisonBasis: "Each paired total-value delta is relative to its own do-nothing baseline with the same simulation options." };
      }
      case "draft_customer_message": {
        const { strategyId, message } = schemas.draft_customer_message.parse(args);
        currentResult(strategyId); emit({ type: "draft", strategyId, message, displayOnly: true });
        return { strategyId, message, displayOnly: true };
      }
      case "recommend": {
        if (!state.classified || !state.rulesExplicit) throw new ToolFailure("PREREQUISITE", "Classify feedback and explicitly set decision rules before recommending.");
        const { strategyId, rationale, tradeoffs } = schemas.recommend.parse(args);
        const result = currentResult(strategyId);
        if (!state.stresses[strategyId]) throw new ToolFailure("PREREQUISITE", "Stress test this strategy in the current context first.");
        if (result.strategy.intervention.kind !== "targeted_discount") throw new ToolFailure("NOT_EXECUTABLE", "Only subscription price overrides are executable in this build.");
        if (result.metrics.discountCost.mean > state.rules.discountBudget || result.probValueBelowBaseline > state.rules.maxProbWorse) throw new ToolFailure("RULE_VIOLATION", "The base simulation exceeds the decision rules.");
        const eligibleTargetIds = pilotEligibility(feedbackCorpus, accepted, await registry(), labels).eligibleSubscriptionIds;
        checkAbort();
        const proposal = await (options.propose ?? createProposal)({ objective, strategy: result.strategy, result, listPrice: state.twin.params.listPrice, eligibleTargetIds });
        state.proposal = proposal;
        emit({ type: "proposal", proposal, rationale, tradeoffs });
        return { id: proposal.id, status: proposal.status, targetCount: proposal.action.targets.length, rationale, tradeoffs };
      }
    }
  }
  async function dispatch(name: string, args: unknown): Promise<ToolResult> {
    let result: ToolResult;
    try {
      checkAbort();
      if (!Object.hasOwn(schemas, name)) throw new ToolFailure("UNKNOWN_TOOL", "Unknown tool.");
      const schema = schemas[name as ToolName];
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments do not match the strict schema.");
      emit({ type: "tool_started", name });
      const data = await invoke(name as ToolName, parsed.data);
      result = { ok: true, data };
    } catch (error) {
      result = options.signal?.aborted ? { ok: false, code: "ABORTED", message: "Run cancelled." }
        : error instanceof ToolFailure ? { ok: false, code: error.code, message: error.message, ...(error.terminal ? { terminal: true as const } : {}), ...(error.failure ? { failure: error.failure } : {}) }
        : error instanceof ProposalError ? { ok: false, code: error.code, message: "A proposed action could not be created for the current eligible cohort." }
        : error instanceof WorkerTaskError ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: "TOOL_FAILED", message: "Tool could not complete. Details suppressed." };
    }
    emit({ type: "tool_result", name: Object.hasOwn(schemas, name) ? name : "unknown", result });
    return result;
  }
  return { dispatch, state, definitions: TOOL_DEFINITIONS };
}

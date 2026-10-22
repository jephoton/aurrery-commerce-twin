import { describe, expect, it, vi } from "vitest";
import { createToolContext, TOOL_DEFINITIONS } from "./tools";
import { currentMerchant } from "@/merchant";
import { feedbackCorpus } from "@/signals/corpus";
import { emptyMetrics } from "@/signals/providers";
import type { ClassificationResult } from "@/signals/classify";
import type { Prediction } from "@/signals/contracts";
import type { Strategy } from "@/twin/interventions";
import { compareStrategies } from "@/twin/simulate";
import { ledger } from "@/ledger/db";
import { listProposals, listSandboxSubscribers, registerSandboxSubscriber, replaceSandboxSubscription } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/setup";

const strategy: Strategy = { id: "save", name: "Save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 10, months: 1, campaignMonths: 0 } };
const predictions = (): Prediction[] => feedbackCorpus.map((m) => ({ id: m.id, intent: m.pilotIndex === 2 || m.pilotIndex === 3 ? "stay" : "cancel", reason: m.pilotIndex === 2 || m.pilotIndex === 3 ? "other" : "price", confidence: .9 }));
const classified = (): ClassificationResult => ({ accepted: predictions(), total: 200, cacheHits: 200, unclassified: [], diagnostics: [], schemaValidCount: 200, batches: [], metrics: emptyMetrics(), stopped: false });
function setup(options: Parameters<typeof createToolContext>[0] = {}) {
  ledger().exec("DELETE FROM sandbox_subscribers; DELETE FROM proposals;");
  PILOT_COHORT.forEach((pilot, i) => registerSandboxSubscriber({ ...pilot, subscriptionId: `I-PILOT${i}` }));
  return createToolContext({ objective: "Reduce churn", classify: vi.fn(async () => classified()), ...options });
}
const rules = { discountBudget: 100000, maxProbWorse: 1, horizonMonths: 1 };
async function ready(ctx: ReturnType<typeof setup>, candidate = strategy) {
  await ctx.dispatch("classify_feedback", {});
  await ctx.dispatch("set_decision_rules", rules);
  await ctx.dispatch("simulate_strategies", { strategies: [candidate] });
}
const recommend = (ctx: ReturnType<typeof setup>, id = "save") => ctx.dispatch("recommend", { strategyId: id, rationale: "A bounded offer", tradeoffs: "Discount costs and expiry risk" });

describe("agent tool boundary", () => {
  it("exposes exactly seven strict tools and returns safe errors for unknown tools and extra arguments", async () => {
    const ctx = setup();
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual(["get_merchant_state", "classify_feedback", "set_decision_rules", "simulate_strategies", "stress_test", "draft_customer_message", "recommend"]);
    expect(await ctx.dispatch("execute", {})).toMatchObject({ ok: false, code: "UNKNOWN_TOOL" });
    expect(await ctx.dispatch("get_merchant_state", { execute: true })).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(listProposals()).toEqual([]);
  });
  it.each([{ ...rules, discountBudget: -1 }, { ...rules, discountBudget: Infinity }, { ...rules, maxProbWorse: 1.1 }, { ...rules, horizonMonths: 13 }])("rejects invalid decision bounds %j", async (input) => {
    expect(await setup().dispatch("set_decision_rules", input)).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  });
  it("rejects nested argument injection and excessive strategy lists or text", async () => {
    const ctx = setup();
    expect(await ctx.dispatch("simulate_strategies", { strategies: [{ ...strategy, targets: ["I-CORE"] }] })).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(await ctx.dispatch("simulate_strategies", { strategies: Array(7).fill(strategy) })).toMatchObject({ ok: false });
    expect(await ctx.dispatch("recommend", { strategyId: "save", rationale: "a".repeat(2001), tradeoffs: "risk" })).toMatchObject({ ok: false });
  });
  it("requires classification, explicit rules, current simulation and stress before proposing", async () => {
    const ctx = setup();
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "PREREQUISITE" });
    await ctx.dispatch("classify_feedback", {});
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "PREREQUISITE" });
    await ctx.dispatch("set_decision_rules", rules);
    expect(await ctx.dispatch("stress_test", { strategyId: "save" })).toMatchObject({ ok: false, code: "PREREQUISITE" });
    await ctx.dispatch("simulate_strategies", { strategies: [strategy] });
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "PREREQUISITE" });
    expect(listProposals()).toEqual([]);
  });
  it("creates only a proposed action bound to classified A/B and excludes C/D", async () => {
    const events: unknown[] = [];
    const ctx = setup({ emit: (event) => events.push(event) });
    await ready(ctx);
    await ctx.dispatch("stress_test", { strategyId: "save" });
    expect(await recommend(ctx)).toMatchObject({ ok: true, data: { status: "proposed", targetCount: 2 } });
    expect(ctx.state.proposal?.action.targets).toEqual(["I-PILOT0", "I-PILOT1"]);
    expect(ctx.state.proposal?.status).toBe("proposed");
    expect(events).toContainEqual(expect.objectContaining({ type: "proposal" }));
    expect(JSON.stringify(await ctx.dispatch("get_merchant_state", {}))).not.toContain("I-PILOT");
  });
  it("maps replacement IDs using stable pilot labels at proposal creation", async () => {
    const ctx = setup(); await ready(ctx);
    replaceSandboxSubscription("I-PILOT0", PILOT_COHORT[0].label, "I-REPLACED");
    await ctx.dispatch("stress_test", { strategyId: "save" }); await recommend(ctx);
    expect(ctx.state.proposal?.action.targets).toEqual(["I-REPLACED", "I-PILOT1"]);
  });
  it("creates at most one durable proposal and freezes its context", async () => {
    const ctx = setup(); await ready(ctx); await ctx.dispatch("stress_test", { strategyId: "save" });
    await recommend(ctx);
    const proposal = structuredClone(ctx.state.proposal);
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "PROPOSAL_EXISTS" });
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: false, code: "PROPOSAL_EXISTS" });
    expect(await ctx.dispatch("set_decision_rules", rules)).toMatchObject({ ok: false, code: "PROPOSAL_EXISTS" });
    expect(ctx.state.proposal).toEqual(proposal);
    expect(listProposals()).toHaveLength(1);
  });
  it("does not accumulate repeated classification evidence or mutate the canonical twin", async () => {
    const before = structuredClone(currentMerchant().twin);
    const ctx = setup(); await ready(ctx);
    const first = structuredClone(ctx.state.twin);
    await ctx.dispatch("classify_feedback", {});
    expect(ctx.state.twin).toEqual(first);
    expect(currentMerchant().twin).toEqual(before);
    expect(ctx.state.comparison).toBeUndefined();
    expect(listProposals()).toEqual([]);
  });
  it("invalidates cumulative comparisons and stress on rules changes", async () => {
    const ctx = setup(); await ready(ctx);
    await ctx.dispatch("stress_test", { strategyId: "save" });
    await ctx.dispatch("set_decision_rules", { ...rules, horizonMonths: 2 });
    expect(ctx.state.comparison).toBeUndefined();
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "PREREQUISITE" });
  });
  it("keeps cumulative candidates with a baseline and refuses conflicting IDs", async () => {
    const ctx = setup(); await ready(ctx);
    await ctx.dispatch("simulate_strategies", { strategies: [{ ...strategy, id: "second" }] });
    expect(ctx.state.comparison?.strategies.map((r) => r.strategy.id)).toEqual(["baseline", "save", "second"]);
    expect(ctx.state.comparison?.options).toEqual({ runs: 1000, seed: 20261113, horizonMonths: 1 });
    expect(await ctx.dispatch("simulate_strategies", { strategies: [{ ...strategy, name: "conflict" }] })).toMatchObject({ ok: false, code: "STRATEGY_CONFLICT" });
  });
  it("returns compact merchant and paired comparison summaries while retaining full UI evidence", async () => {
    const events: unknown[] = [];
    const ctx = setup({ emit: (event) => events.push(event) });
    const merchant = await ctx.dispatch("get_merchant_state", {});
    expect(merchant).toMatchObject({ ok: true, data: { metrics: { listPrice: 24 }, segments: expect.any(Array), assumptions: expect.any(Array) } });
    expect(JSON.stringify(merchant)).not.toContain('"params"');
    expect(JSON.stringify(merchant)).not.toContain('"alpha"');
    await ready(ctx);
    const comparison = await ctx.dispatch("simulate_strategies", { strategies: [strategy] });
    expect(comparison).toMatchObject({ ok: true, data: { strategies: expect.arrayContaining([expect.objectContaining({ strategy, totalValueDelta: expect.objectContaining({ p10: expect.any(Number), p50: expect.any(Number), p90: expect.any(Number) }), meanDiscountCost: expect.any(Number), chanceWorse: expect.any(Number) })]) } });
    expect(JSON.stringify(comparison)).not.toContain('"metrics"');
    expect(JSON.stringify(comparison)).not.toContain('"activeBand"');
    expect(events).toContainEqual(expect.objectContaining({ type: "comparison", comparison: expect.objectContaining({ strategies: expect.arrayContaining([expect.objectContaining({ metrics: expect.any(Object), activeBand: expect.any(Object) })]) }) }));
  });
  it("enforces the base budget at proposal creation", async () => {
    const ctx = setup(); await ready(ctx);
    await ctx.dispatch("set_decision_rules", { ...rules, discountBudget: 0 });
    await ctx.dispatch("simulate_strategies", { strategies: [strategy] });
    await ctx.dispatch("stress_test", { strategyId: "save" });
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "RULE_VIOLATION" });
    expect(listProposals()).toEqual([]);
  });
  it("returns NOT_EXECUTABLE for an annual comparison", async () => {
    const annual: Strategy = { id: "annual", name: "Annual", intervention: { kind: "annual_plan", discountPct: 10, segments: ["core"] } };
    const ctx = setup(); await ready(ctx, annual);
    await ctx.dispatch("stress_test", { strategyId: "annual" });
    expect(await recommend(ctx, "annual")).toMatchObject({ ok: false, code: "NOT_EXECUTABLE" });
  });
  it("never falls back to registry targets when no classifier pilots qualify", async () => {
    const ctx = setup({ classify: async () => ({ ...classified(), accepted: predictions().map((p) => ({ ...p, intent: "stay" })) }) });
    await ready(ctx); await ctx.dispatch("stress_test", { strategyId: "save" });
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "NO_TARGETS" });
  });
  it("drafts display-only copy without proposals and rejects absent candidate IDs", async () => {
    const ctx = setup(); await ready(ctx);
    expect(await ctx.dispatch("draft_customer_message", { strategyId: "save", message: "An offer for you" })).toMatchObject({ ok: true });
    expect(listProposals()).toEqual([]);
    expect(await ctx.dispatch("draft_customer_message", { strategyId: "missing", message: "Hi" })).toMatchObject({ ok: false });
  });
  it("blocks aborted calls and cancellation after classification before state or proposal side effects", async () => {
    const controller = new AbortController();
    const ctx = setup({ signal: controller.signal, classify: async () => { controller.abort(); return classified(); } });
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: false, code: "ABORTED" });
    expect(ctx.state.classified).toBe(false);
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "ABORTED" });
    expect(listProposals()).toEqual([]);
  });
  it("checks cancellation immediately before persisting a recommendation", async () => {
    const controller = new AbortController();
    let reads = 0;
    const ctx = setup({ signal: controller.signal, registry: () => { if (++reads === 2) controller.abort(); return listSandboxSubscribers(); } });
    await ready(ctx); await ctx.dispatch("stress_test", { strategyId: "save" });
    expect(await recommend(ctx)).toMatchObject({ ok: false, code: "ABORTED" });
    expect(listProposals()).toEqual([]);
  });
  it("paces fresh batches, exposes progress, and then reports 200 cache hits without provider calls", async () => {
    const events: unknown[] = [];
    const sleep = vi.fn(async () => {});
    const classify = vi.fn(async (inputs: { id: string }[]) => ({ payload: { items: inputs.map(({ id }) => ({ id, intent: "cancel", reason: "price", confidence: .9 })) }, metrics: emptyMetrics(), terminal: false }));
    const ctx = setup({ classify: undefined, provider: { provider: "groq", model: "synthetic-tool-pacing", classify }, sleep, emit: (event) => events.push(event) });
    const fresh = await ctx.dispatch("classify_feedback", {});
    expect(fresh).toMatchObject({ ok: true, data: { accepted: 200, cacheHits: 0 } });
    expect(classify).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
    expect(sleep.mock.calls.every((args) => (args as unknown[])[0] === 30000)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("30 seconds") }));
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: true, data: { accepted: 200, cacheHits: 200 } });
    expect(classify).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(fresh)).not.toContain("I-PILOT");
    expect(JSON.stringify(fresh)).not.toContain(feedbackCorpus[0].id);
    expect(fresh).toMatchObject({ ok: true, data: { provider: "groq", model: "synthetic-tool-pacing" } });
    expect(ctx.state.classification).toMatchObject({ provider: "groq", model: "synthetic-tool-pacing" });
    expect(events).toContainEqual(expect.objectContaining({ type: "classification", summary: expect.objectContaining({ provider: "groq", model: "synthetic-tool-pacing" }) }));
  });
  it.each([{ category: "quota" as const, status: 429 }, { category: "auth" as const, status: 401 }, { category: "configuration" as const }])("marks terminal classification failures with partial accepted evidence as unsafe for proposals: %j", async (failure) => {
    const events: unknown[] = [];
    const partial = classified();
    const accepted = partial.accepted.slice(0, 20);
    const ctx = setup({ emit: (event) => events.push(event), classify: async () => ({ ...partial, accepted, stopped: failure.category === "quota", batches: [{ index: 1, inputIds: [], accepted: [], unclassified: [], schemaValidCount: 0, diagnostics: [], metrics: emptyMetrics(), error: { provider: "groq", model: "openai/gpt-oss-120b", retryCount: 0, quota: {}, ...failure } }] }) });
    const result = await ctx.dispatch("classify_feedback", {});
    expect(result).toMatchObject({ ok: false, terminal: true, code: "CLASSIFICATION_FAILED", failure });
    expect(ctx.state.classified).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "classification", summary: expect.objectContaining({ accepted: 20, provider: "groq", model: "openai/gpt-oss-120b" }) }));
    await ctx.dispatch("set_decision_rules", rules);
    await ctx.dispatch("simulate_strategies", { strategies: [strategy] });
    await ctx.dispatch("stress_test", { strategyId: "save" });
    expect(await recommend(ctx)).toMatchObject({ ok: false, terminal: true });
    expect(listProposals()).toEqual([]);
  });
  it("does not accept an empty classification as the evidence prerequisite", async () => {
    const ctx = setup({ classify: async () => ({ ...classified(), accepted: [], cacheHits: 0 }) });
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: false, code: "NO_ACCEPTED_EVIDENCE" });
    expect(ctx.state.classified).toBe(false);
    expect(await recommend(ctx)).toMatchObject({ ok: false });
    expect(listProposals()).toEqual([]);
  });
  it("keeps stressed losses visible without treating them as an automatic veto", async () => {
    const simulate = (twin: Parameters<typeof compareStrategies>[0], candidates: Strategy[], options: Parameters<typeof compareStrategies>[2]) => compareStrategies(twin, candidates, { ...options, runs: 10 });
    const ctx = setup({ simulate, stress: (twin, candidate, options) => {
      const base = simulate(twin, [candidate], options).strategies[1];
      return { base, stressed: { ...base, probValueBelowBaseline: 1, vsBaseline: { ...base.vsBaseline, totalValue: { ...base.vsBaseline.totalValue, p50: -100 } } }, stressedParams: twin.params, shifted: ["Adverse effect"] };
    } });
    await ready(ctx);
    expect(await ctx.dispatch("stress_test", { strategyId: "save" })).toMatchObject({ ok: true, data: { base: { totalValueDelta: expect.objectContaining({ p50: expect.any(Number) }) }, stressed: { totalValueDelta: { p50: -100 }, chanceWorse: 1 } } });
    expect(await recommend(ctx)).toMatchObject({ ok: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./contracts";
import { createToolContext, type ImportedContext } from "./tools";
import { buildImportedTwin, importedStarterStrategies } from "@/import/imported-twin";
import { DEMO_ONLY_MESSAGE, REASON_UNAVAILABLE_MESSAGE } from "@/import/messages";
import { SAMPLE_REASON_COUNTS } from "@/import/sample-merchant";
import { ledger } from "@/ledger/db";
import { listProposals } from "@/ledger/proposals";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { samplePayload } from "@/test/import-fixture";
import type { MerchantTwin } from "@/twin/types";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";

function build(feedback: boolean) {
  const built = buildImportedTwin(samplePayload({ feedback }));
  if (!built.ok) throw new Error("The sample must build.");
  return built;
}
// No tool may read Ridgeline's observed ledger evidence for an imported merchant.
const reads = vi.hoisted(() => ({ discount: 0, annual: 0 }));
vi.mock("@/ledger/discount-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/discount-outcomes")>();
  return { ...actual, readDiscountOutcomes: vi.fn(async (...args: Parameters<typeof actual.readDiscountOutcomes>) => { reads.discount++; return actual.readDiscountOutcomes(...args); }) };
});
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return { ...actual, readAnnualOfferEvidence: vi.fn(async (...args: Parameters<typeof actual.readAnnualOfferEvidence>) => { reads.annual++; return actual.readAnnualOfferEvidence(...args); }) };
});

const withFeedbackTwin = build(true);
const plainTwin = build(false);
const withFeedback: ImportedContext = { reasonCounts: SAMPLE_REASON_COUNTS, feedbackRows: 40, reasonTargeting: true };
const noFeedback: ImportedContext = { feedbackRows: 0, reasonTargeting: false };
const rules = { discountBudget: 100000, maxProbWorse: 1, horizonMonths: 1 };

function setup(imported: ImportedContext = withFeedback, twin: MerchantTwin = withFeedbackTwin.twin) {
  ledger().exec("DELETE FROM proposals;");
  const events: AgentEvent[] = [];
  const propose = vi.fn();
  const registry = vi.fn(async () => []);
  const classify = vi.fn();
  const providerClassify = vi.fn();
  const ctx = createToolContext({
    objective: "Reduce churn", twin, imported, propose, registry, classify,
    provider: { provider: "groq", model: "test-model", classify: providerClassify },
    emit: (event) => events.push(event),
    simulate: (t, candidates, options) => compareStrategies(t, candidates, { ...options, runs: 20 }),
    stress: (t, strategy, options) => stressTest(t, strategy, { ...options, runs: 20 }),
  });
  return { ctx, events, propose, registry, classify, providerClassify };
}

describe("imported merchant tools", () => {
  it("lists price-scaled starters and reports the pre-classified counts without a model call", async () => {
    const { ctx, classify, providerClassify, registry, events } = setup();
    const state = await ctx.dispatch("get_merchant_state", {});
    if (!state.ok) throw new Error("expected state");
    expect(state.data).toMatchObject({ simulateOnly: true, metrics: { listPrice: 20 } });
    const data = state.data as { starterStrategies: { id: string }[]; evidenceNote: string; segments: { segment: string; reasonShareSource: string }[] };
    expect(data.starterStrategies.map((s) => s.id)).toEqual(importedStarterStrategies(withFeedbackTwin).map((s) => s.id));
    expect(data.evidenceNote).toContain("Simulate only");
    expect(data.segments.every((s) => s.reasonShareSource === "estimated")).toBe(true);
    const classified = await ctx.dispatch("classify_feedback", {});
    expect(classified).toMatchObject({ ok: true, data: { feedbackRows: 40, segments: SAMPLE_REASON_COUNTS, reasonTargeting: true } });
    expect(classify).not.toHaveBeenCalled();
    expect(providerClassify).not.toHaveBeenCalled();
    expect(registry).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "classification")).toBe(false);
  });

  it("records a simulate-only recommendation for discounts and annual plans, never a proposal or offer", async () => {
    reads.discount = 0; reads.annual = 0;
    for (const candidate of [STARTER_STRATEGIES[0], STARTER_STRATEGIES[2]]) {
      const { ctx, events, propose, registry } = setup();
      await ctx.dispatch("classify_feedback", {});
      await ctx.dispatch("set_decision_rules", rules);
      await ctx.dispatch("simulate_strategies", { strategies: [candidate] });
      await ctx.dispatch("stress_test", { strategyId: candidate.id });
      const result = await ctx.dispatch("recommend", { strategyId: candidate.id, rationale: "Supported by the comparison", tradeoffs: "Discount cost and assumption risk" });
      expect(result).toMatchObject({ ok: true, data: { strategyId: candidate.id, simulateOnly: true, message: DEMO_ONLY_MESSAGE } });
      expect(events).toContainEqual({ type: "recommendation", strategy: candidate, rationale: "Supported by the comparison", tradeoffs: "Discount cost and assumption risk", simulateOnly: true });
      expect(events.some((e) => e.type === "proposal" || e.type === "observed_snapshot")).toBe(false);
      expect(propose).not.toHaveBeenCalled();
      expect(registry).not.toHaveBeenCalled();
      expect(ctx.state.proposal).toBeUndefined();
      expect(ctx.state.recommendation?.strategyId).toBe(candidate.id);
      expect(await listProposals()).toHaveLength(0);
      expect(await ctx.dispatch("simulate_strategies", { strategies: [candidate] })).toMatchObject({ ok: false, code: "RECOMMENDATION_EXISTS" });
      expect(await ctx.dispatch("get_merchant_state", {})).toMatchObject({ ok: true, data: { recommendedStrategyId: candidate.id } });
    }
    expect(reads).toEqual({ discount: 0, annual: 0 });
  });

  it("refuses price-reason strategies when no feedback was imported", async () => {
    const { ctx } = setup(noFeedback, plainTwin.twin);
    const state = await ctx.dispatch("get_merchant_state", {});
    if (!state.ok) throw new Error("expected state");
    const data = state.data as { starterStrategies: { id: string }[]; segments: { reasonShareSource: string }[] };
    expect(data.starterStrategies.map((s) => s.id)).toEqual(importedStarterStrategies(plainTwin).map((s) => s.id));
    expect(data.starterStrategies.map((s) => s.id)).not.toContain("cancel-price-25-3m");
    expect(data.segments.every((s) => s.reasonShareSource === "assumption")).toBe(true);
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: true, data: { reasonTargeting: false, segments: null, note: REASON_UNAVAILABLE_MESSAGE } });
    await ctx.dispatch("set_decision_rules", rules);
    expect(await ctx.dispatch("simulate_strategies", { strategies: [STARTER_STRATEGIES[1]] })).toMatchObject({ ok: false, code: "REASON_UNAVAILABLE", message: REASON_UNAVAILABLE_MESSAGE });
    expect(await ctx.dispatch("simulate_strategies", { strategies: [STARTER_STRATEGIES[0]] })).toMatchObject({ ok: true });
  });

  it("still requires classification and explicit rules before recommending", async () => {
    const { ctx } = setup();
    await ctx.dispatch("set_decision_rules", rules);
    await ctx.dispatch("simulate_strategies", { strategies: [STARTER_STRATEGIES[0]] });
    await ctx.dispatch("stress_test", { strategyId: STARTER_STRATEGIES[0].id });
    expect(await ctx.dispatch("recommend", { strategyId: STARTER_STRATEGIES[0].id, rationale: "Too early", tradeoffs: "Unclassified" })).toMatchObject({ ok: false, code: "PREREQUISITE" });
  });

  it("still refuses list-price changes and rule violations as recommendations", async () => {
    const { ctx } = setup();
    const rise = { id: "list-23", name: "Raise list price to $23", intervention: { kind: "list_price_change" as const, newPrice: 23 } };
    await ctx.dispatch("classify_feedback", {});
    await ctx.dispatch("set_decision_rules", rules);
    await ctx.dispatch("simulate_strategies", { strategies: [rise] });
    await ctx.dispatch("stress_test", { strategyId: "list-23" });
    expect(await ctx.dispatch("recommend", { strategyId: "list-23", rationale: "Highest median", tradeoffs: "Price response is assumed" })).toMatchObject({ ok: false, code: "NOT_EXECUTABLE" });

    await ctx.dispatch("set_decision_rules", { ...rules, discountBudget: 0 });
    await ctx.dispatch("simulate_strategies", { strategies: [STARTER_STRATEGIES[0]] });
    await ctx.dispatch("stress_test", { strategyId: STARTER_STRATEGIES[0].id });
    expect(await ctx.dispatch("recommend", { strategyId: STARTER_STRATEGIES[0].id, rationale: "Over budget", tradeoffs: "Cost" })).toMatchObject({ ok: false, code: "RULE_VIOLATION" });
    expect(ctx.state.recommendation).toBeUndefined();
  });
});

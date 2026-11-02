import { expect, it } from "vitest";
import { DEFAULT_DECISION_RULES } from "@/agent/contracts";
import { chooseHeadline, isRecommendableIntervention } from "@/components/headline";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { samplePayload } from "@/test/import-fixture";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies, type ComparisonResult } from "@/twin/simulate";
import { buildImportedTwin, importedStarterStrategies } from "./imported-twin";

// Decision 1 (M6 plan review): Hollowbrook's headline differs from Ridgeline's on history alone,
// with clear margin. Pinned at 200 futures with the default (deterministic) seed.
const options = { runs: 200 };

function build(feedback: boolean) {
  const built = buildImportedTwin(samplePayload({ feedback }));
  if (!built.ok) throw new Error("sample must build");
  return built;
}
const compare = (built: ReturnType<typeof build>) =>
  compareStrategies(built.twin, importedStarterStrategies(built), options);
/** Retention discounts and annual plans, best median first (list-price changes are never the pick). */
const recommendable = (c: ComparisonResult) =>
  c.strategies.filter((s) => s.strategy.id !== c.baselineId && isRecommendableIntervention(s.strategy.intervention)).sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);

it("gives the sample merchant a different headline from Ridgeline on history alone, with clear margin", () => {
  const ridgeline = buildDemoTwin().twin;
  const built = build(false);
  expect(built.reasonTargeting).toBe(false);
  const comparison = compare(built);
  expect(chooseHeadline(compareStrategies(ridgeline, STARTER_STRATEGIES, options))).toMatchObject({ selectedId: "annual-15", recommended: true });
  expect(chooseHeadline(comparison, DEFAULT_DECISION_RULES, { simulateOnly: true })).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true, simulateOnly: true, alsoExecutable: [] });
  // The pick rule is the same with or without simulate-only, so the comparison with Ridgeline is like-for-like.
  expect(chooseHeadline(comparison).selectedId).toBe("at-risk-20-3m");

  const [pick, runnerUp] = recommendable(comparison);
  expect(runnerUp.strategy.id).toBe("annual-15");
  expect(pick.vsBaseline.totalValue.p50).toBeGreaterThanOrEqual(1.1 * runnerUp.vsBaseline.totalValue.p50);
  expect(pick.metrics.discountCost.mean).toBeLessThanOrEqual(0.7 * DEFAULT_DECISION_RULES.discountBudget);

  // Why: Hollowbrook's at-risk subscribers churn several times faster than Ridgeline's but mostly
  // recover when they stay, while its core subscribers rarely cancel, so annual prepay buys little retention.
  const sample = built.twin.params.segments;
  const demo = ridgeline.params.segments;
  expect(betaMean(sample.at_risk.monthlyChurn)).toBeGreaterThan(0.4);
  expect(betaMean(demo.at_risk.monthlyChurn)).toBeLessThan(0.2);
  expect(betaMean(sample.core.monthlyChurn)).toBeLessThan(0.02);
  expect(betaMean(demo.core.monthlyChurn)).toBeGreaterThan(0.02);
}, 120_000);

it("keeps the same headline when its feedback is classified as labelled: at-risk leavers mostly cite price", () => {
  const built = build(true);
  expect(built.reasonTargeting).toBe(true);
  // Almost nobody starts in cancel intent, so the price-driven cancel save would be an empty row.
  expect(built.twin.initialActive.cancel_intent).toBeLessThan(5);
  expect(importedStarterStrategies(built).map((s) => s.id)).not.toContain("cancel-price-25-3m");
  expect(chooseHeadline(compare(built), DEFAULT_DECISION_RULES, { simulateOnly: true })).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true, simulateOnly: true, alsoExecutable: [] });
  expect(betaMean(built.twin.params.segments.at_risk.priceReasonShare)).toBeGreaterThan(0.7);
}, 120_000);

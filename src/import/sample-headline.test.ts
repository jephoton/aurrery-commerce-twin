import { expect, it } from "vitest";
import { DEFAULT_DECISION_RULES } from "@/agent/contracts";
import { chooseHeadline, isExecutable } from "@/components/headline";
import { STARTER_STRATEGIES, starterStrategiesFor } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { samplePayload } from "@/test/import-fixture";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies, type ComparisonResult } from "@/twin/simulate";
import { buildImportedTwin } from "./imported-twin";

// Decision 1 (M6 plan review): Hollowbrook's headline differs from Ridgeline's on history alone,
// with clear margin. Pinned at 200 futures with the default (deterministic) seed.
const options = { runs: 200 };

function build(feedback: boolean) {
  const built = buildImportedTwin(samplePayload({ feedback }));
  if (!built.ok) throw new Error("sample must build");
  return built;
}
const compare = (built: ReturnType<typeof build>) =>
  compareStrategies(built.twin, starterStrategiesFor(built.twin.params.listPrice, { reasonTargeting: built.reasonTargeting }), options);
/** Retention discounts and annual plans, best median first (list-price changes are never the pick). */
const recommendable = (c: ComparisonResult) =>
  c.strategies.filter((s) => s.strategy.id !== c.baselineId && isExecutable(s)).sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);

it("gives the sample merchant a different headline from Ridgeline on history alone, with clear margin", () => {
  const ridgeline = buildDemoTwin().twin;
  const built = build(false);
  expect(built.reasonTargeting).toBe(false);
  const comparison = compare(built);
  expect(chooseHeadline(compareStrategies(ridgeline, STARTER_STRATEGIES, options))).toMatchObject({ selectedId: "annual-15", recommended: true });
  expect(chooseHeadline(comparison)).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true });

  const [pick, runnerUp] = recommendable(comparison);
  expect(runnerUp.strategy.id).toBe("annual-15");
  expect(pick.vsBaseline.totalValue.p50).toBeGreaterThanOrEqual(1.1 * runnerUp.vsBaseline.totalValue.p50);
  expect(pick.metrics.discountCost.mean).toBeLessThanOrEqual(0.7 * DEFAULT_DECISION_RULES.discountBudget);

  // Why: Hollowbrook's at-risk subscribers churn several times faster than Ridgeline's, while its
  // settled core subscribers rarely cancel, so annual prepay buys little retention.
  const sample = built.twin.params.segments;
  const demo = ridgeline.params.segments;
  expect(betaMean(sample.at_risk.monthlyChurn)).toBeGreaterThan(0.5);
  expect(betaMean(demo.at_risk.monthlyChurn)).toBeLessThan(0.2);
  expect(betaMean(sample.core.monthlyChurn)).toBeLessThan(0.015);
  expect(betaMean(demo.core.monthlyChurn)).toBeGreaterThan(0.02);
}, 120_000);

it("keeps the same headline when its feedback is classified as labelled: at-risk leavers mostly cite price", () => {
  const built = build(true);
  expect(built.reasonTargeting).toBe(true);
  expect(chooseHeadline(compare(built))).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true });
  expect(betaMean(built.twin.params.segments.at_risk.priceReasonShare)).toBeGreaterThan(0.7);
}, 120_000);

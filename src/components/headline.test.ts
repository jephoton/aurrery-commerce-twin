import { describe, expect, it } from "vitest";
import { DEFAULT_DECISION_RULES } from "@/agent/contracts";
import type { Intervention } from "@/twin/interventions";
import { compareStrategies, type ComparisonResult, type StrategyResult } from "@/twin/simulate";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { chooseHeadline, isExecutableIntervention, whyNotExecutable } from "./headline";

const saveOffer: Intervention = { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 6 };
const priceRise: Intervention = { kind: "list_price_change", newPrice: 27 };
const annual: Intervention = { kind: "annual_plan", discountPct: 15, segments: ["core"] };

function result(id: string, intervention: Intervention, p50: number, probWorse: number, discountCost = 0): StrategyResult {
  return {
    strategy: { id, name: id, intervention },
    vsBaseline: { totalValue: { mean: p50, p10: p50, p50, p90: p50, probPositive: 1 - probWorse } },
    metrics: { discountCost: { mean: discountCost, p10: 0, p50: 0, p90: 0 } },
    probValueBelowBaseline: probWorse,
  } as unknown as StrategyResult;
}
const comparison = (...strategies: StrategyResult[]): ComparisonResult =>
  ({ baselineId: "baseline", strategies: [result("baseline", { kind: "baseline" }, 0, 0), ...strategies] }) as unknown as ComparisonResult;

describe("headline choice", () => {
  it("headlines the annual plan by default, lists the save offer as also executable and the price rise as the bigger lever", () => {
    const c = comparison(result("rise", priceRise, 61_792, .003), result("annual", annual, 10_268, 0, 8_866), result("save", saveOffer, 147, .385, 570), result("broad", { ...saveOffer, segment: "at_risk", reason: "any" }, -1_283, .738, 4_100));
    const headline = chooseHeadline(c);
    expect(headline).toMatchObject({ selectedId: "annual", recommended: true });
    expect(headline.biggerLevers.map((r) => r.strategy.id)).toEqual(["rise"]);
    expect(headline.alsoExecutable.map((r) => r.strategy.id)).toEqual(["save"]);
  });

  it("reaches that default from the real starter strategy simulation under the default rules", () => {
    const headline = chooseHeadline(compareStrategies(buildDemoTwin().twin, STARTER_STRATEGIES, { runs: 200 }));
    expect(headline).toMatchObject({ selectedId: "annual-15", recommended: true });
    expect(headline.biggerLevers.map((r) => r.strategy.id)).toEqual(["list-27"]);
    expect(headline.alsoExecutable.map((r) => r.strategy.id)).toEqual(["cancel-price-25-3m"]);
  });

  it("applies the discount budget to retention discounts only, and the chance-worse rule to every strategy", () => {
    const c = comparison(result("annual", annual, 500, .1, 9_000), result("risky-annual", annual, 900, .9), result("costly-save", saveOffer, 400, .1, 5_000), result("save", saveOffer, 100, .1, 200));
    const headline = chooseHeadline(c);
    expect(headline.selectedId).toBe("annual");
    expect(headline.alsoExecutable.map((r) => r.strategy.id)).toEqual(["save"]);
  });

  it("skips executable strategies that break the risk rule or the discount budget", () => {
    const c = comparison(result("risky", saveOffer, 900, .6), result("costly", saveOffer, 800, .1, 5_000), result("ok", saveOffer, 100, .4, 200));
    expect(chooseHeadline(c).selectedId).toBe("ok");
    expect(chooseHeadline(c, { ...DEFAULT_DECISION_RULES, maxProbWorse: .7, discountBudget: 10_000 }).selectedId).toBe("risky");
  });

  it("falls back to the highest simulated value without recommending it when nothing executable qualifies", () => {
    const headline = chooseHeadline(comparison(result("rise", priceRise, 61_792, .003), result("broad", saveOffer, -1_283, .738)));
    expect(headline).toEqual({ selectedId: "rise", recommended: false, biggerLevers: [], alsoExecutable: [] });
  });

  it("explains why the list price change is not executable and treats annual plans as executable", () => {
    expect(whyNotExecutable(priceRise)).toMatch(/every subscriber.*assumption/);
    expect(whyNotExecutable(annual)).toBeNull();
    expect(whyNotExecutable(saveOffer)).toBeNull();
    expect(isExecutableIntervention(annual)).toBe(true);
    expect(isExecutableIntervention(priceRise)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_DECISION_RULES } from "@/agent/contracts";
import type { Intervention } from "@/twin/interventions";
import type { ComparisonResult, StrategyResult } from "@/twin/simulate";
import { chooseHeadline, whyNotExecutable } from "./headline";

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
  it("headlines the best executable strategy within the rules and lists bigger simulate-only levers", () => {
    const c = comparison(result("rise", priceRise, 61_792, .003), result("annual", annual, 10_268, 0), result("save", saveOffer, 147, .385, 570), result("broad", { ...saveOffer, segment: "at_risk", reason: "any" }, -1_283, .738, 4_100));
    const headline = chooseHeadline(c);
    expect(headline).toMatchObject({ selectedId: "save", recommended: true });
    expect(headline.biggerLevers.map((r) => r.strategy.id)).toEqual(["rise", "annual"]);
  });

  it("skips executable strategies that break the risk rule or the discount budget", () => {
    const c = comparison(result("risky", saveOffer, 900, .6), result("costly", saveOffer, 800, .1, 5_000), result("ok", saveOffer, 100, .4, 200));
    expect(chooseHeadline(c).selectedId).toBe("ok");
    expect(chooseHeadline(c, { ...DEFAULT_DECISION_RULES, maxProbWorse: .7, discountBudget: 10_000 }).selectedId).toBe("risky");
  });

  it("falls back to the highest simulated value without recommending it when nothing executable qualifies", () => {
    const headline = chooseHeadline(comparison(result("rise", priceRise, 61_792, .003), result("broad", saveOffer, -1_283, .738)));
    expect(headline).toEqual({ selectedId: "rise", recommended: false, biggerLevers: [] });
  });

  it("explains why each simulate-only kind is not executable", () => {
    expect(whyNotExecutable(priceRise)).toMatch(/every subscriber.*assumption/);
    expect(whyNotExecutable(annual)).toMatch(/approve the switch in their own PayPal account/);
    expect(whyNotExecutable(saveOffer)).toBeNull();
  });
});

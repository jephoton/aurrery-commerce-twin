import { describe, expect, it } from "vitest";
import { buildDemoTwin, DEMO_TRUTH } from "@/merchant/demo";
import { betaMean, betaSd, updateDiscountEffect } from "./calibrate";
import { BASELINE, InterventionSchema, type Strategy } from "./interventions";
import { Rng } from "./rng";
import { compareStrategies } from "./simulate";
import { SEGMENTS } from "./types";

const { twin, history } = buildDemoTwin();
const FAST = { runs: 200, horizonMonths: 12, seed: 7 };

const discount: Strategy = {
  id: "at-risk-20",
  name: "20% off for at-risk, 3 months",
  intervention: { kind: "targeted_discount", segment: "at_risk", discountPct: 20, months: 3 },
};
const priceCut: Strategy = { id: "cut-20", name: "List price $20", intervention: { kind: "list_price_change", newPrice: 20 } };
const priceRise: Strategy = { id: "rise-28", name: "List price $28", intervention: { kind: "list_price_change", newPrice: 28 } };
const annual: Strategy = {
  id: "annual-15",
  name: "Annual plan 15% off",
  intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] },
};

describe("rng", () => {
  it("is reproducible for a seed", () => {
    const a = new Rng(1);
    const b = new Rng(1);
    expect([a.uniform(), a.uniform()]).toEqual([b.uniform(), b.uniform()]);
  });

  it("samples binomials with the right mean in both regimes", () => {
    const rng = new Rng(3);
    for (const [n, p] of [[40, 0.05], [2000, 0.16]] as const) {
      let total = 0;
      const draws = 20000;
      for (let i = 0; i < draws; i++) total += rng.binomial(n, p);
      const standardError = Math.sqrt((n * p * (1 - p)) / draws);
      expect(Math.abs(total / draws - n * p)).toBeLessThan(4 * standardError);
    }
  });
});

describe("calibration", () => {
  it("recovers the generating churn rates within the posterior uncertainty", () => {
    for (const s of SEGMENTS) {
      const d = twin.params.segments[s].monthlyChurn;
      expect(Math.abs(betaMean(d) - DEMO_TRUTH.churn[s])).toBeLessThan(4 * betaSd(d) + 0.002);
    }
  });

  it("recovers cancel-intent escalation and de-escalation rates", () => {
    const t = twin.params.transitions;
    const pairs = [
      [t.atRiskToCancelIntent, DEMO_TRUTH.atRiskToCancelIntent],
      [t.cancelIntentToAtRisk, DEMO_TRUTH.cancelIntentToAtRisk],
    ] as const;
    for (const [posterior, truth] of pairs) {
      expect(Math.abs(betaMean(posterior) - truth)).toBeLessThan(4 * betaSd(posterior) + 0.002);
    }
  });

  it("estimates transitions from exactly the right exposures", () => {
    const rows = (segment: string) => history.segments.filter((r) => r.segment === segment);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const postChurn = (r: (typeof history.segments)[number]) => r.activeAtStart - r.voluntaryChurn - r.involuntaryChurn;

    const escalation = twin.params.transitions.atRiskToCancelIntent;
    const atRisk = rows("at_risk");
    expect(escalation.alpha - 1).toBe(sum(atRisk.map((r) => r.movedTo.cancel_intent ?? 0)));
    expect(escalation.beta - 1).toBe(
      sum(atRisk.map((r) => postChurn(r) - (r.movedTo.core ?? 0) - (r.movedTo.cancel_intent ?? 0))),
    );

    const deescalation = twin.params.transitions.cancelIntentToAtRisk;
    const cancelIntent = rows("cancel_intent");
    expect(deescalation.alpha - 1).toBe(sum(cancelIntent.map((r) => r.movedTo.at_risk ?? 0)));
    expect(deescalation.beta - 1).toBe(sum(cancelIntent.map((r) => postChurn(r) - (r.movedTo.at_risk ?? 0))));
  });

  it("starts with subscribers in every segment, including cancel intent", () => {
    for (const s of SEGMENTS) expect(twin.initialActive[s]).toBeGreaterThan(0);
    expect(SEGMENTS).toContain("cancel_intent");
  });

  it("pulls the discount effect toward observed outcomes", () => {
    const before = twin.params.offerChurnRelativeRisk;
    const { change } = updateDiscountEffect(twin, [{ segment: "at_risk", subscriberMonths: 600, cancellations: 20 }]);
    // 600 months × ~16% ≈ 96 expected cancellations without discount; 20 observed → RR well below the prior.
    expect(change!.after.mean).toBeLessThan(before.shape / before.rate);
    expect(change!.after.sd).toBeLessThan(change!.before.sd);
  });
});

describe("simulation", () => {
  it("is deterministic for a seed", () => {
    const a = compareStrategies(twin, [discount], FAST);
    const b = compareStrategies(twin, [discount], FAST);
    expect(a.strategies[1].metrics.grossProfit).toEqual(b.strategies[1].metrics.grossProfit);
  });

  it("adds a baseline and gives it zero paired difference with itself", () => {
    const r = compareStrategies(twin, [discount], FAST);
    expect(r.strategies[0].strategy.id).toBe(BASELINE.id);
    expect(r.strategies[0].vsBaseline.grossProfit).toMatchObject({ mean: 0, p10: 0, p90: 0 });
  });

  it("keeps accounting identities and non-negative populations", () => {
    const r = compareStrategies(twin, [discount, priceCut, annual], FAST);
    for (const s of r.strategies) {
      const m = s.metrics;
      expect(m.grossProfit.mean).toBeCloseTo(m.revenue.mean - m.paymentFees.mean - m.fulfilmentCost.mean, 6);
      expect(Math.min(...s.activeBand.p10)).toBeGreaterThanOrEqual(0);
      expect(m.discountCost.mean).toBeGreaterThanOrEqual(0);
    }
  });

  it("retains subscribers and costs discount revenue for a targeted discount", () => {
    const r = compareStrategies(twin, [discount], FAST);
    const d = r.strategies[1].vsBaseline;
    expect(d.endingActive.mean).toBeGreaterThan(0);
    expect(r.strategies[1].metrics.discountCost.mean).toBeGreaterThan(0);
  });

  it("responds to list price in the expected directions", () => {
    const r = compareStrategies(twin, [priceCut, priceRise], FAST);
    const [, cut, rise] = r.strategies;
    expect(cut.vsBaseline.newSubscribers.mean).toBeGreaterThan(0);
    expect(rise.vsBaseline.newSubscribers.mean).toBeLessThan(0);
    expect(rise.vsBaseline.voluntaryChurn.mean).toBeGreaterThan(0);
  });

  it("collects annual prepayments up front", () => {
    const r = compareStrategies(twin, [annual], { ...FAST, horizonMonths: 1 });
    expect(r.strategies[1].vsBaseline.revenue.mean).toBeGreaterThan(0);
  });
});

describe("guardrails", () => {
  it("rejects discounts outside commercial bounds", () => {
    expect(InterventionSchema.safeParse({ kind: "targeted_discount", segment: "at_risk", discountPct: 80, months: 3 }).success).toBe(false);
    expect(InterventionSchema.safeParse({ kind: "targeted_discount", segment: "vip", discountPct: 20, months: 3 }).success).toBe(false);
  });
});

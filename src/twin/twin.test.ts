import { describe, expect, it } from "vitest";
import { buildDemoTwin, DEMO_TRUTH } from "@/merchant/demo";
import { betaMean, betaSd, updateDiscountEffect } from "./calibrate";
import { BASELINE, InterventionSchema, type Intervention, type Strategy } from "./interventions";
import { hashSeed, Rng } from "./rng";
import { compareStrategies, runOnce, sampleParams, tailValue, tailValuer, type TailCohort } from "./simulate";
import { REASONS, SEGMENTS, type SegmentId } from "./types";

const { twin, history } = buildDemoTwin();
const FAST = { runs: 200, horizonMonths: 12, seed: 7 };

const discount: Strategy = {
  id: "at-risk-20",
  name: "20% off for at-risk, 3 months",
  intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 0 },
};
const precision: Strategy = {
  id: "cancel-price-25",
  name: "25% off price-driven cancel intent, 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 },
};
const cancelAny: Strategy = {
  id: "cancel-any-25",
  name: "25% off all cancel intent, 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "any", discountPct: 25, months: 3, campaignMonths: 0 },
};
/** Same targeted discount with a different campaign window. */
const withCampaign = (st: Strategy, months: number, id = `${st.id}-c${months}`): Strategy => {
  if (st.intervention.kind !== "targeted_discount") throw new Error("withCampaign needs a targeted discount");
  return { ...st, id, intervention: { ...st.intervention, campaignMonths: months } };
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

  it("pulls the discount effect for a reason toward observed outcomes", () => {
    const { twin: updated, changes } = updateDiscountEffect(twin, [{ segment: "at_risk", reason: "price", subscriberMonths: 600, cancellations: 20 }]);
    // 600 months × ~16% ≈ 96 expected cancellations without discount; 20 observed → RR well below the prior.
    expect(changes).toHaveLength(1);
    expect(changes[0].parameter).toBe("offerChurnRelativeRisk.price");
    expect(changes[0].after.mean).toBeLessThan(changes[0].before.mean);
    expect(changes[0].after.sd).toBeLessThan(changes[0].before.sd);
    expect(updated.params.offerChurnRelativeRisk.other).toEqual(twin.params.offerChurnRelativeRisk.other);
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

  it("discounts only subscribers with the targeted reason", () => {
    const r = compareStrategies(twin, [precision, cancelAny], FAST);
    const [, onlyPrice, everyone] = r.strategies;
    expect(onlyPrice.metrics.discountCost.mean).toBeGreaterThan(0);
    expect(onlyPrice.metrics.discountCost.mean).toBeLessThan(everyone.metrics.discountCost.mean);
  });

  it("targets nobody when no cancel-intent subscriber is price-driven", () => {
    const s = sampleParams(twin.params, new Rng(11));
    const s0 = { ...s, priceReasonShare: Object.fromEntries(SEGMENTS.map((g) => [g, 0])) as typeof s.priceReasonShare };
    expect(runOnce(twin, s0, precision.intervention, 12, 99).totalValue).toBe(runOnce(twin, s0, BASELINE.intervention, 12, 99).totalValue);
  });

  it("targets everyone when every cancel-intent subscriber is price-driven", () => {
    const s = sampleParams(twin.params, new Rng(11));
    const s1 = { ...s, priceReasonShare: Object.fromEntries(SEGMENTS.map((g) => [g, 1])) as typeof s.priceReasonShare };
    expect(runOnce(twin, s1, precision.intervention, 12, 99)).toEqual(runOnce(twin, s1, cancelAny.intervention, 12, 99));
  });

  it("matches the baseline exactly under a campaign when nobody qualifies", () => {
    const s = sampleParams(twin.params, new Rng(11));
    const s0 = { ...s, priceReasonShare: Object.fromEntries(SEGMENTS.map((g) => [g, 0])) as typeof s.priceReasonShare };
    expect(runOnce(twin, s0, withCampaign(precision, 6).intervention, 12, 99)).toEqual(runOnce(twin, s0, BASELINE.intervention, 12, 99));
  });

  it("offers exactly today's segment when the campaign is 0", () => {
    const s = sampleParams(twin.params, new Rng(11));
    const iv = withCampaign({ ...cancelAny, id: "x" }, 0).intervention;
    expect(runOnce(twin, s, iv, 12, 99).discountedSubscribers).toBe(twin.initialActive.cancel_intent);
  });

  it("offers each subscriber at most once, even when they re-enter the segment", () => {
    // Close the loop between at_risk and cancel_intent (nobody enters from other segments or recovers), so
    // the distinct subscribers who can ever be in cancel_intent are today's cancel_intent plus at_risk.
    const s = {
      ...sampleParams(twin.params, new Rng(11)),
      cancelIntentToAtRisk: 0.9,
      atRiskToCancelIntent: 0.9,
      atRiskRecovery: 0,
      coreToAtRisk: 0,
      priceSensitiveToAtRisk: 0,
    };
    const iv: Intervention = { kind: "targeted_discount", segment: "cancel_intent", reason: "any", discountPct: 25, months: 1, campaignMonths: 12 };
    const discounted = runOnce(twin, s, iv, 12, 99).discountedSubscribers;
    expect(discounted).toBeGreaterThan(twin.initialActive.cancel_intent);
    expect(discounted).toBeLessThanOrEqual(twin.initialActive.cancel_intent + twin.initialActive.at_risk);
  });

  it("includes entrants billed in the last campaign month and none after", () => {
    const s = sampleParams(twin.params, new Rng(11));
    const newAny = (months: number): Intervention => ({ kind: "targeted_discount", segment: "new", reason: "any", discountPct: 20, months: 3, campaignMonths: months });
    const discounted = (months: number) => runOnce(twin, s, newAny(months), 12, 99).discountedSubscribers;
    // Month-0 acquisitions use the same keyed stream as runOnce; list price equals the reference price at month 0.
    const acquiredInMonth0 = new Rng(hashSeed(99, "m0:acq", 0)).poisson(s.acquisition);
    expect(discounted(0)).toBe(twin.initialActive.new);
    expect(discounted(1)).toBe(twin.initialActive.new + acquiredInMonth0);
    expect(discounted(2)).toBeGreaterThan(discounted(1));
  });

  it("responds to list price in the expected directions", () => {
    const r = compareStrategies(twin, [priceCut, priceRise], FAST);
    const [, cut, rise] = r.strategies;
    expect(cut.vsBaseline.newSubscribers.mean).toBeGreaterThan(0);
    expect(rise.vsBaseline.newSubscribers.mean).toBeLessThan(0);
    expect(rise.vsBaseline.voluntaryChurn.mean).toBeGreaterThan(0);
  });

  it("reaches campaign entrants as well as today's segment", () => {
    const r = compareStrategies(twin, [precision, withCampaign(precision, 6)], FAST);
    const [, oneOff, ongoing] = r.strategies;
    expect(ongoing.metrics.discountedSubscribers.mean).toBeGreaterThan(2 * oneOff.metrics.discountedSubscribers.mean);
  });

  it("values the precision campaign above the broad campaign", () => {
    const r = compareStrategies(twin, [withCampaign(discount, 6, "broad-c6"), withCampaign(precision, 6, "precise-c6")], FAST);
    const [, broad, precise] = r.strategies;
    expect(precise.vsBaseline.totalValue.p50).toBeGreaterThan(broad.vsBaseline.totalValue.p50);
  });

  it("collects annual prepayments up front", () => {
    const r = compareStrategies(twin, [annual], { ...FAST, horizonMonths: 1 });
    expect(r.strategies[1].vsBaseline.revenue.mean).toBeGreaterThan(0);
  });
});

describe("guardrails", () => {
  it("rejects discounts outside commercial bounds", () => {
    const ok = { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 0 };
    expect(InterventionSchema.safeParse(ok).success).toBe(true);
    expect(InterventionSchema.safeParse({ ...ok, discountPct: 80 }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, campaignMonths: 13 }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, segment: "vip" }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, reason: "loyalty" }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, reason: "price" }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, segment: "cancel_intent", reason: "price" }).success).toBe(true);
  });
});

describe("tail value", () => {
  const s = sampleParams(twin.params, new Rng(1));
  const list = twin.params.listPrice;
  const cohort = (segment: SegmentId): TailCohort => ({ segment, reason: "other", plan: "monthly", monthsLeft: 0, offer: false, price: list, rebound: false });

  it("counts the recovery a cancel-intent subscriber may make after the horizon", () => {
    const withMoves = tailValue(twin.params, s, cohort("cancel_intent"), list);
    const stuck = tailValue(twin.params, { ...s, cancelIntentToAtRisk: 0 }, cohort("cancel_intent"), list);
    expect(withMoves).toBeGreaterThan(stuck);
  });

  it("values a core subscriber above a cancel-intent subscriber", () => {
    expect(tailValue(twin.params, s, cohort("core"), list)).toBeGreaterThan(tailValue(twin.params, s, cohort("cancel_intent"), list));
  });

  it("charges fulfilment without revenue for prepaid annual months", () => {
    const annual: TailCohort = { ...cohort("core"), plan: "annual", monthsLeft: 6, price: list * 12 };
    expect(tailValue(twin.params, s, annual, list)).toBeLessThan(tailValue(twin.params, s, cohort("core"), list));
  });

  it("values an offer cohort lower when the post-offer churn spike is larger", () => {
    const offer: TailCohort = { ...cohort("at_risk"), offer: true, monthsLeft: 3, price: list * 0.8 };
    const calm = tailValue(twin.params, { ...s, postOfferMultiplier: 1 }, offer, list);
    const spike = tailValue(twin.params, { ...s, postOfferMultiplier: 2 }, offer, list);
    expect(spike).toBeLessThan(calm);
  });

  it("per-run valuer matches the reference implementation", () => {
    for (const seed of [1, 2, 3]) {
      const sp = sampleParams(twin.params, new Rng(seed));
      for (const listPrice of [20, 24, 27]) {
        const valuer = tailValuer(twin.params, sp, listPrice);
        for (const segment of SEGMENTS) {
          for (const reason of REASONS) {
            const base = { segment, reason, plan: "monthly", monthsLeft: 0, offer: false, price: listPrice, rebound: false } as const;
            const shapes: TailCohort[] = [
              base,
              { ...base, plan: "annual", monthsLeft: 6, price: listPrice * 12 },
              { ...base, offer: true, monthsLeft: 2, price: 18 },
              { ...base, rebound: true },
            ];
            for (const shape of shapes) {
              const expected = tailValue(twin.params, sp, shape, listPrice);
              expect(Math.abs(valuer(shape) - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
            }
          }
        }
      }
    }
  });
});

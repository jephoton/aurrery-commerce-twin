import { describe, expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { betaMean, betaSd, gammaMean, gammaSd, updateDiscountEffect } from "./calibrate";
import { BASELINE, type Strategy } from "./interventions";
import { compareStrategies } from "./simulate";
import { stressParams, stressTest } from "./stress";
import { REASONS, SEGMENTS } from "./types";

const { twin } = buildDemoTwin();
const precision: Strategy = {
  id: "precision", name: "Cancel-flow save offer",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 6 },
};
const annual: Strategy = {
  id: "annual", name: "Annual prepay",
  intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] },
};
const price = (newPrice: number): Strategy => ({
  id: "price", name: "Change price", intervention: { kind: "list_price_change", newPrice },
});
const options = { runs: 100, horizonMonths: 12, seed: 7 };

describe("stress parameters", () => {
  it("leaves the baseline and a price held constant unchanged", () => {
    for (const strategy of [BASELINE, price(twin.params.listPrice)]) {
      expect(stressParams(twin.params, strategy.intervention)).toEqual({ params: twin.params, shifted: [] });
    }
  });

  it("weakens both reason-specific discount effects and raises rebound by 0.8416 standard deviations", () => {
    const { params, shifted } = stressParams(twin.params, precision.intervention);
    for (const reason of REASONS) {
      const before = twin.params.offerChurnRelativeRisk[reason];
      const after = params.offerChurnRelativeRisk[reason];
      expect(gammaMean(after)).toBeCloseTo(gammaMean(before) + 0.8416 * gammaSd(before), 12);
      expect(gammaSd(after)).toBeCloseTo(gammaSd(before), 12);
    }
    expect(params.postOfferChurnMultiplier).toEqual({
      mean: twin.params.postOfferChurnMultiplier.mean + 0.8416 * twin.params.postOfferChurnMultiplier.sd,
      sd: twin.params.postOfferChurnMultiplier.sd,
    });
    expect(shifted).toHaveLength(3);
    expect(shifted.join(" ")).toMatch(/discount/i);
  });

  it("lowers annual uptake means while preserving Beta concentration and clamping away from zero", () => {
    const input = structuredClone(twin.params);
    input.segments.new.annualUptake = { alpha: 0.001, beta: 0.999 };
    const { params } = stressParams(input, annual.intervention);
    for (const segment of SEGMENTS) {
      const before = input.segments[segment].annualUptake;
      const after = params.segments[segment].annualUptake;
      expect(betaMean(after)).toBeCloseTo(Math.max(0.001, betaMean(before) - 0.8416 * betaSd(before)), 12);
      expect(after.alpha + after.beta).toBeCloseTo(before.alpha + before.beta, 12);
    }
    expect(betaMean(params.segments.new.annualUptake)).toBeCloseTo(0.001, 12);
  });

  it.each([[27, 1], [22, -1]])("shifts price sensitivity adversely for price %s", (newPrice, direction) => {
    const { params, shifted } = stressParams(twin.params, price(newPrice).intervention);
    const before = twin.params.acquisitionPriceElasticity;
    expect(params.acquisitionPriceElasticity).toEqual({ mean: before.mean + direction * 0.8416 * before.sd, sd: before.sd });
    for (const segment of SEGMENTS) {
      const before = twin.params.segments[segment].churnPriceElasticity;
      expect(params.segments[segment].churnPriceElasticity).toEqual({ mean: before.mean + direction * 0.8416 * before.sd, sd: before.sd });
    }
    expect(shifted).toHaveLength(SEGMENTS.length + 1);
  });

  it("does not mutate inputs or alter history estimates and unrelated assumptions", () => {
    const snapshot = structuredClone(twin.params);
    for (const strategy of [precision, annual, price(27), price(22)]) {
      const { params } = stressParams(twin.params, strategy.intervention);
      expect(params.transitions).toEqual(snapshot.transitions);
      expect(params.monthlyAcquisition).toEqual(snapshot.monthlyAcquisition);
      expect(params.involuntaryChurn).toEqual(snapshot.involuntaryChurn);
      for (const segment of SEGMENTS) {
        expect(params.segments[segment].monthlyChurn).toEqual(snapshot.segments[segment].monthlyChurn);
        expect(params.segments[segment].priceReasonShare).toEqual(snapshot.segments[segment].priceReasonShare);
      }
    }
    expect(twin.params).toEqual(snapshot);
  });
});

describe("stress comparison", () => {
  it("completes the three-segment annual stress at the production seed and run count", () => {
    const strategy: Strategy = {
      id: "annual-all",
      name: "Annual plan 15% off for eligible segments",
      intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive", "at_risk"] },
    };
    const result = stressTest(twin, strategy, { runs: 1000, horizonMonths: 12, seed: 20261113 });
    const allNumbersFinite = (value: unknown): boolean => {
      if (typeof value === "number") return Number.isFinite(value);
      if (value !== null && typeof value === "object") return Object.values(value).every(allNumbersFinite);
      return true;
    };

    expect(result.shifted).toHaveLength(SEGMENTS.length);
    expect(allNumbersFinite(result)).toBe(true);
  }, 30_000);

  it("compares base and stressed parameters with the supplied options and seed", () => {
    const result = stressTest(twin, precision, options);
    expect(result.base).toEqual(compareStrategies(twin, [precision], options).strategies[1]);
    expect(result.stressed).toEqual(compareStrategies({ ...twin, params: result.stressedParams }, [precision], options).strategies[1]);
    expect(result.stressed.vsBaseline.totalValue.p50).toBeLessThanOrEqual(result.base.vsBaseline.totalValue.p50);
  });

  it("reduces the price-rise median value gain", () => {
    const result = stressTest(twin, price(27), options);
    expect(result.stressed.vsBaseline.totalValue.p50).toBeLessThan(result.base.vsBaseline.totalValue.p50);
  });

  it("returns equal baseline results without shifts", () => {
    const result = stressTest(twin, BASELINE, { runs: 2, horizonMonths: 2 });
    expect(result.stressed).toEqual(result.base);
    expect(result.stressedParams).toEqual(twin.params);
    expect(result.shifted).toEqual([]);
  });

  it("preserves observed discount evidence while stressing the remaining assumptions", () => {
    const { twin: calibrated } = updateDiscountEffect(twin, [{ segment: "cancel_intent", reason: "price", subscriberMonths: 100, cancellations: 4 }]);
    const snapshot = structuredClone(calibrated);
    const result = stressTest(calibrated, precision, { runs: 2, horizonMonths: 2 });
    expect(result.stressedParams.offerChurnRelativeRisk.price).toEqual(calibrated.params.offerChurnRelativeRisk.price);
    expect(result.stressedParams.offerChurnRelativeRisk.other).not.toEqual(calibrated.params.offerChurnRelativeRisk.other);
    expect(result.shifted).toHaveLength(2);
    expect(calibrated).toEqual(snapshot);
  });

  it("honours exact segment provenance ahead of group provenance", () => {
    const withEvidence = {
      ...twin,
      provenance: { ...twin.provenance, "segments.core.annualUptake": { source: "estimated" as const, note: "From annual-plan trials" } },
    };
    const result = stressTest(withEvidence, annual, { runs: 2, horizonMonths: 2 });
    expect(result.stressedParams.segments.core.annualUptake).toEqual(twin.params.segments.core.annualUptake);
    expect(result.stressedParams.segments.price_sensitive.annualUptake).not.toEqual(twin.params.segments.price_sensitive.annualUptake);
  });
});

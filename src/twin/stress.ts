import type { Intervention, Strategy } from "./interventions";
import { betaMean, betaSd, gammaMean, gammaSd } from "./calibrate";
import { compareStrategies, type SimulationOptions, type StrategyResult } from "./simulate";
import { REASONS, SEGMENTS, type BetaDist, type GammaDist, type MerchantTwin, type NormalDist, type TwinParams } from "./types";

// Mean ± 0.8416 SD approximates an adverse 80th/20th percentile scenario;
// for Gamma and Beta distributions this is not an exact quantile.
const Z80 = 0.8416;
const shiftNormal = (d: NormalDist, direction: number): NormalDist => ({ ...d, mean: d.mean + direction * Z80 * d.sd });
function shiftGamma(d: GammaDist): GammaDist {
  const sd = gammaSd(d);
  const mean = Math.max(0.001, gammaMean(d) + Z80 * sd);
  return { shape: (mean / sd) ** 2, rate: mean / sd ** 2 };
}
function lowerBeta(d: BetaDist): BetaDist {
  const n = d.alpha + d.beta;
  const mean = Math.max(0.001, Math.min(0.999, betaMean(d) - Z80 * betaSd(d)));
  return { alpha: mean * n, beta: (1 - mean) * n };
}

/** Pure adverse shifts for intervention assumptions, without changing history estimates. */
export function stressParams(params: TwinParams, intervention: Intervention): { params: TwinParams; shifted: string[] } {
  return shiftAssumptions(params, intervention, () => true);
}

function shiftAssumptions(
  input: TwinParams,
  intervention: Intervention,
  canShift: (key: string, group?: string) => boolean,
): { params: TwinParams; shifted: string[] } {
  const params = structuredClone(input);
  const shifted: string[] = [];
  switch (intervention.kind) {
    case "baseline":
      break;
    case "targeted_discount":
      for (const reason of REASONS) {
        if (!canShift(`offerChurnRelativeRisk.${reason}`, "offerChurnRelativeRisk")) continue;
        params.offerChurnRelativeRisk[reason] = shiftGamma(input.offerChurnRelativeRisk[reason]);
        shifted.push(`The discount prevents fewer cancellations among ${reason === "price" ? "price-driven" : "other-reason"} leavers.`);
      }
      if (canShift("postOfferChurnMultiplier")) {
        params.postOfferChurnMultiplier = shiftNormal(input.postOfferChurnMultiplier, 1);
        shifted.push("More subscribers cancel when the discount expires.");
      }
      break;
    case "annual_plan":
      for (const segment of SEGMENTS) {
        if (!canShift(`segments.${segment}.annualUptake`, "annualUptake")) continue;
        params.segments[segment].annualUptake = lowerBeta(input.segments[segment].annualUptake);
        shifted.push(`Fewer ${input.segments[segment].label} subscribers take up the annual plan.`);
      }
      break;
    case "list_price_change": {
      const direction = Math.sign(intervention.newPrice - input.listPrice);
      if (direction === 0) break;
      if (canShift("acquisitionPriceElasticity")) {
        params.acquisitionPriceElasticity = shiftNormal(input.acquisitionPriceElasticity, direction);
        shifted.push(direction > 0 ? "The higher price deters more new subscribers." : "The lower price attracts fewer extra new subscribers.");
      }
      for (const segment of SEGMENTS) {
        if (!canShift(`segments.${segment}.churnPriceElasticity`, "churnPriceElasticity")) continue;
        params.segments[segment].churnPriceElasticity = shiftNormal(input.segments[segment].churnPriceElasticity, direction);
        shifted.push(direction > 0
          ? `More ${input.segments[segment].label} subscribers cancel after the price increase.`
          : `The price cut prevents fewer cancellations among ${input.segments[segment].label} subscribers.`);
      }
      break;
    }
  }
  return { params, shifted };
}

export interface StressResult {
  base: StrategyResult;
  stressed: StrategyResult;
  stressedParams: TwinParams;
  shifted: string[];
}

/** Compare the same strategy and seed under base assumptions and an adverse scenario. */
export function stressTest(twin: MerchantTwin, strategy: Strategy, options: Partial<SimulationOptions> = {}): StressResult {
  const { params, shifted } = shiftAssumptions(twin.params, strategy.intervention, (key, group) => {
    const provenance = twin.provenance[key] ?? (group ? twin.provenance[group] : undefined);
    return provenance?.source === "assumption";
  });
  // Each call includes its own do-nothing baseline; both reuse the identical options/seed.
  const ownResult = (candidate: MerchantTwin) => compareStrategies(candidate, [strategy], options).strategies
    .find((result) => result.strategy === strategy)!;
  return { base: ownResult(twin), stressed: ownResult({ ...twin, params }), stressedParams: params, shifted };
}

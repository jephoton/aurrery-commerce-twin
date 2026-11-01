import type { AcquisitionRecord } from "./calibrate";
import { monthOffset, type HistoryRecord, type TwinHistory } from "./history";
import { Rng } from "./rng";
import { SEGMENTS, type SegmentId } from "./types";

// Synthetic history: generated once from fixed "true" rates with a fixed seed. The twin then
// estimates its parameters from the history exactly as it would from real data.

export interface SyntheticTruth {
  churn: Record<SegmentId, number>;
  involuntary: number;
  newGraduation: number;
  newToPriceSensitive: number;
  coreToAtRisk: number;
  priceSensitiveToAtRisk: number;
  atRiskRecovery: number;
  atRiskToCancelIntent: number;
  cancelIntentToAtRisk: number;
  acquisitionMean: number;
  acquisitionSd: number;
}

export interface SyntheticHistorySpec {
  truth: SyntheticTruth;
  startActive: Record<SegmentId, number>;
  months: number;
  seed: number;
  /** The month after the last generated month. */
  asOfMonth: string;
}

/** Signups join `new` at the start of their month and are exposed to that month's churn. */
export function generateSyntheticHistory(spec: SyntheticHistorySpec): { history: TwinHistory; endActive: Record<SegmentId, number> } {
  const rng = new Rng(spec.seed);
  const t = spec.truth;
  const active = { ...spec.startActive };
  const segments: HistoryRecord[] = [];
  const acquisition: AcquisitionRecord[] = [];

  for (let i = 0; i < spec.months; i++) {
    const month = monthOffset(spec.asOfMonth, i - spec.months);
    const signups = Math.max(0, Math.round(rng.normal(t.acquisitionMean, t.acquisitionSd)));
    acquisition.push({ month, newSubscribers: signups });
    active.new += signups;

    const inflow = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<SegmentId, number>;
    for (const segment of SEGMENTS) {
      const start = active[segment];
      const voluntary = rng.binomial(start, t.churn[segment]);
      const involuntary = rng.binomial(start - voluntary, t.involuntary);
      const remaining = start - voluntary - involuntary;
      const movedTo: Partial<Record<SegmentId, number>> = {};
      if (segment === "new") {
        const graduated = rng.binomial(remaining, t.newGraduation);
        movedTo.price_sensitive = rng.binomial(graduated, t.newToPriceSensitive);
        movedTo.core = graduated - movedTo.price_sensitive;
      } else if (segment === "core") {
        movedTo.at_risk = rng.binomial(remaining, t.coreToAtRisk);
      } else if (segment === "price_sensitive") {
        movedTo.at_risk = rng.binomial(remaining, t.priceSensitiveToAtRisk);
      } else if (segment === "at_risk") {
        movedTo.core = rng.binomial(remaining, t.atRiskRecovery);
        movedTo.cancel_intent = rng.binomial(remaining - movedTo.core, t.atRiskToCancelIntent);
      } else if (segment === "cancel_intent") {
        movedTo.at_risk = rng.binomial(remaining, t.cancelIntentToAtRisk);
      } else {
        const unreachable: never = segment;
        throw new Error(`Unhandled segment: ${unreachable}`);
      }
      let out = 0;
      for (const [to, n] of Object.entries(movedTo) as [SegmentId, number][]) {
        inflow[to] += n;
        out += n;
      }
      segments.push({ month, segment, activeAtStart: start, voluntaryChurn: voluntary, involuntaryChurn: involuntary, movedTo });
      active[segment] = remaining - out;
    }
    for (const segment of SEGMENTS) active[segment] += inflow[segment];
  }
  return { history: { segments, acquisition }, endActive: active };
}

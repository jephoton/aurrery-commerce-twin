import { SEGMENTS, type BetaDist, type GammaDist, type MerchantTwin, type NormalDist, type SegmentId } from "./types";

// Conjugate Bayesian estimation: builds twin parameters from history and folds observed
// outcomes back in. Simple on purpose, so every update can be explained in one sentence.

/** One segment-month of subscriber history. */
export interface SegmentMonthRecord {
  month: string;
  segment: SegmentId;
  activeAtStart: number;
  voluntaryChurn: number;
  involuntaryChurn: number;
}

export interface AcquisitionRecord {
  month: string;
  newSubscribers: number;
}

export const betaMean = (d: BetaDist) => d.alpha / (d.alpha + d.beta);
export const betaSd = (d: BetaDist) => {
  const n = d.alpha + d.beta;
  return Math.sqrt((d.alpha * d.beta) / (n * n * (n + 1)));
};
export const gammaMean = (d: GammaDist) => d.shape / d.rate;
export const gammaSd = (d: GammaDist) => Math.sqrt(d.shape) / d.rate;

export function betaPosterior(prior: BetaDist, events: number, trials: number): BetaDist {
  return { alpha: prior.alpha + events, beta: prior.beta + Math.max(0, trials - events) };
}

export interface ChurnEstimate {
  posterior: BetaDist;
  events: number;
  exposure: number;
}

/** Monthly churn hazard per segment, from subscriber-months at risk and churn events. */
export function estimateChurn(
  records: SegmentMonthRecord[],
  prior: BetaDist,
  kind: "voluntary" | "involuntary",
): Record<SegmentId, ChurnEstimate> {
  const out = {} as Record<SegmentId, ChurnEstimate>;
  for (const segment of SEGMENTS) {
    const rows = records.filter((r) => r.segment === segment);
    const exposure = rows.reduce((s, r) => s + (kind === "voluntary" ? r.activeAtStart : r.activeAtStart - r.voluntaryChurn), 0);
    const events = rows.reduce((s, r) => s + (kind === "voluntary" ? r.voluntaryChurn : r.involuntaryChurn), 0);
    out[segment] = { posterior: betaPosterior(prior, events, exposure), events, exposure };
  }
  return out;
}

/** Pooled involuntary churn across segments (payment failures are not segment-specific here). */
export function estimatePooledInvoluntary(records: SegmentMonthRecord[], prior: BetaDist): ChurnEstimate {
  const exposure = records.reduce((s, r) => s + r.activeAtStart - r.voluntaryChurn, 0);
  const events = records.reduce((s, r) => s + r.involuntaryChurn, 0);
  return { posterior: betaPosterior(prior, events, exposure), events, exposure };
}

/** Predictive distribution for next month's signups: sample mean and month-to-month spread. */
export function estimateAcquisition(records: AcquisitionRecord[]): NormalDist & { months: number } {
  const xs = records.map((r) => r.newSubscribers);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, sd: Math.sqrt(variance), months: xs.length };
}

/** An observed outcome for subscribers who received a retention discount, e.g. read back from PayPal. */
export interface DiscountOutcomeObservation {
  segment: SegmentId;
  /** Subscriber-months observed while the discount was active. */
  subscriberMonths: number;
  /** Cancellations observed during those months. */
  cancellations: number;
}

export interface ParameterChange {
  parameter: string;
  before: { mean: number; sd: number };
  after: { mean: number; sd: number };
  evidence: string;
}

/**
 * Update the discount relative-risk posterior from observed cancellations, treating them as
 * Poisson with mean RR × (expected cancellations without the discount). Gamma prior → Gamma posterior.
 */
export function updateDiscountEffect(
  twin: MerchantTwin,
  observations: DiscountOutcomeObservation[],
): { twin: MerchantTwin; change: ParameterChange | null } {
  const expected = observations.reduce(
    (s, o) => s + o.subscriberMonths * betaMean(twin.params.segments[o.segment].monthlyChurn),
    0,
  );
  const observed = observations.reduce((s, o) => s + o.cancellations, 0);
  if (expected <= 0) return { twin, change: null };

  const before = twin.params.offerChurnRelativeRisk;
  const after: GammaDist = { shape: before.shape + observed, rate: before.rate + expected };
  const months = observations.reduce((s, o) => s + o.subscriberMonths, 0);
  const evidence = `${observed} cancellation(s) in ${months} discounted subscriber-month(s); ${expected.toFixed(2)} expected without discount`;
  return {
    twin: {
      ...twin,
      params: { ...twin.params, offerChurnRelativeRisk: after },
      provenance: {
        ...twin.provenance,
        offerChurnRelativeRisk: { source: "observed", note: `Prior assumption updated with ${evidence}.`, evidenceCount: months },
      },
    },
    change: {
      parameter: "offerChurnRelativeRisk",
      before: { mean: gammaMean(before), sd: gammaSd(before) },
      after: { mean: gammaMean(after), sd: gammaSd(after) },
      evidence,
    },
  };
}

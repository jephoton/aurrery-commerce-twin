// Domain types for the subscription-merchant digital twin.

export const SEGMENTS = ["new", "core", "price_sensitive", "at_risk", "cancel_intent"] as const;
export type SegmentId = (typeof SEGMENTS)[number];

/** Main reason a subscriber would leave. Affects how they respond to a discount, not their baseline churn. */
export const REASONS = ["price", "other"] as const;
export type ReasonId = (typeof REASONS)[number];

/** Uncertain rate in [0, 1]. Posterior or prior over a monthly probability. */
export interface BetaDist {
  alpha: number;
  beta: number;
}

export interface NormalDist {
  mean: number;
  sd: number;
}

/** Positive quantity with Gamma(shape, rate) uncertainty; conjugate for Poisson rate ratios. */
export interface GammaDist {
  shape: number;
  rate: number;
}

/** Where a parameter came from, so the UI can separate evidence from assumption. */
export interface Provenance {
  source: "estimated" | "assumption" | "observed";
  note: string;
  /** Number of observations behind an estimate, if any. */
  evidenceCount?: number;
}

export interface SegmentParams {
  label: string;
  /** Voluntary monthly churn hazard at the reference price. */
  monthlyChurn: BetaDist;
  /** Churn multiplier exponent: hazard × (price / referencePrice) ^ elasticity. */
  churnPriceElasticity: NormalDist;
  /** Probability a subscriber in this segment switches to a discounted annual prepay plan when offered. */
  annualUptake: BetaDist;
  /** Share of this segment whose main reason to leave is price. From classified feedback when available. */
  priceReasonShare: BetaDist;
}

export interface TwinParams {
  currency: "USD";
  /** Price customers are anchored to; elasticity is measured relative to it. */
  referencePrice: number;
  listPrice: number;
  /** Cost of goods and packaging per monthly box. */
  unitCost: number;
  shippingCost: number;
  /** Payment processing fee per charge: rate × amount + fixed. Assumed, not read from PayPal. */
  paymentFeeRate: number;
  paymentFeeFixed: number;
  monthlyAcquisition: NormalDist;
  acquisitionPriceElasticity: NormalDist;
  /** Monthly involuntary churn after dunning (failed payments not recovered). */
  involuntaryChurn: BetaDist;
  transitions: {
    /** Share of the `new` segment that matures each month. */
    newGraduation: BetaDist;
    /** Of matured subscribers, the share that becomes price sensitive rather than core. */
    newToPriceSensitive: BetaDist;
    coreToAtRisk: BetaDist;
    priceSensitiveToAtRisk: BetaDist;
    atRiskRecovery: BetaDist;
    /** at_risk → cancel_intent, drawn from at-risk subscribers who did not recover that month. */
    atRiskToCancelIntent: BetaDist;
    /** cancel_intent → at_risk (they stepped back from cancelling). */
    cancelIntentToAtRisk: BetaDist;
  };
  /** Churn multiplier while on a retention discount, by leaving reason. */
  offerChurnRelativeRisk: Record<ReasonId, GammaDist>;
  /** Churn multiplier in the month after a retention discount expires (price snaps back). */
  postOfferChurnMultiplier: NormalDist;
  segments: Record<SegmentId, SegmentParams>;
}

export interface MerchantProfile {
  id: string;
  name: string;
  description: string;
  planName: string;
}

export interface MerchantTwin {
  merchant: MerchantProfile;
  asOfMonth: string;
  initialActive: Record<SegmentId, number>;
  params: TwinParams;
  provenance: Record<string, Provenance>;
}

/** One draw of every uncertain parameter, used for a single Monte Carlo run. */
export interface SampledParams {
  churn: Record<SegmentId, number>;
  elasticity: Record<SegmentId, number>;
  annualUptake: Record<SegmentId, number>;
  involuntaryChurn: number;
  acquisition: number;
  acquisitionElasticity: number;
  newGraduation: number;
  newToPriceSensitive: number;
  coreToAtRisk: number;
  priceSensitiveToAtRisk: number;
  atRiskRecovery: number;
  atRiskToCancelIntent: number;
  cancelIntentToAtRisk: number;
  offerRelativeRisk: Record<ReasonId, number>;
  priceReasonShare: Record<SegmentId, number>;
  postOfferMultiplier: number;
}

export interface RunMetrics {
  revenue: number;
  paymentFees: number;
  fulfilmentCost: number;
  grossProfit: number;
  /** Revenue forgone versus list price on discounted subscribers. */
  discountCost: number;
  endingActive: number;
  voluntaryChurn: number;
  involuntaryChurn: number;
  newSubscribers: number;
  /** Expected discounted margin of the subscribers still active at the horizon. */
  endingBaseValue: number;
  /** grossProfit + endingBaseValue: the default decision metric, so short-term wins that shrink the base are penalised. */
  totalValue: number;
  activeByMonth: number[];
  cumulativeProfitByMonth: number[];
}

export interface Summary {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface Band {
  p10: number[];
  p50: number[];
  p90: number[];
}

export const METRIC_KEYS = [
  "totalValue",
  "endingBaseValue",
  "revenue",
  "grossProfit",
  "endingActive",
  "voluntaryChurn",
  "involuntaryChurn",
  "discountCost",
  "paymentFees",
  "fulfilmentCost",
  "newSubscribers",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

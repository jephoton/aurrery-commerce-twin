import { betaPosterior, estimateAcquisition, estimateChurn, estimatePooledInvoluntary } from "./calibrate";
import type { HistoryRecord, TwinHistory } from "./history";
import { SEGMENTS, type MerchantProfile, type MerchantTwin, type Provenance, type SegmentId } from "./types";

// Shared estimation: builds a twin from segment-month history, merchant-entered economics and,
// optionally, classified feedback counts. Used by the synthetic demo merchant and by CSV imports.
// Object keys keep a fixed order: Ridgeline's golden fixture compares bytes and the UI lists
// provenance in key order.

export interface TwinEconomics {
  listPrice: number;
  unitCost: number;
  shippingCost: number;
  paymentFeeRate: number;
  paymentFeeFixed: number;
}

/** Accepted classifier labels per segment. Counts within each segment, not cancellation rates. */
export type ReasonCounts = Record<SegmentId, { price: number; other: number }>;

export interface BuildTwinInput {
  history: TwinHistory;
  economics: TwinEconomics;
  profile: MerchantProfile;
  asOfMonth: string;
  /** Selects the provenance wording: the demo's synthetic history or a merchant's CSV. */
  source: "synthetic" | "csv";
  reasonCounts?: ReasonCounts;
}

const WEAK_RATE_PRIOR = { alpha: 1, beta: 19 };
const FLAT_PRIOR = { alpha: 1, beta: 1 };
/** Prior share of price-driven leavers per segment, used until customer feedback is classified. */
const PRICE_REASON_PRIOR: Record<SegmentId, number> = { new: 0.3, core: 0.2, price_sensitive: 0.65, at_risk: 0.45, cancel_intent: 0.6 };
const reasonPrior = (segment: SegmentId) => ({ alpha: PRICE_REASON_PRIOR[segment] * 10, beta: (1 - PRICE_REASON_PRIOR[segment]) * 10 });
const SEGMENT_LABELS: Record<SegmentId, string> = {
  new: "New (first 3 months)",
  core: "Core",
  price_sensitive: "Price sensitive",
  at_risk: "At risk (skipped or paused recently)",
  cancel_intent: "Cancel intent (opened cancel flow)",
};

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** Backstop to the import payload schema: the builder never estimates from empty or malformed input. */
function assertBuildable(history: TwinHistory, reasonCounts: ReasonCounts | undefined): void {
  if (history.segments.length === 0) throw new RangeError("Twin history needs at least one segment-month row.");
  if (history.acquisition.length === 0) throw new RangeError("Twin history needs at least one month of signups.");
  if (!reasonCounts) return;
  for (const segment of SEGMENTS) {
    const c = reasonCounts[segment];
    if (!c || !isCount(c.price) || !isCount(c.other)) throw new RangeError(`Reason counts for ${segment} must be non-negative integers.`);
  }
}

/** Each segment's state after the last history month: start − cancels − moves out + moves in. */
export function startingActives(rows: HistoryRecord[]): Record<SegmentId, number> {
  const last = rows.reduce((max, r) => (r.month > max ? r.month : max), rows[0]?.month ?? "");
  const active = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<SegmentId, number>;
  for (const r of rows.filter((x) => x.month === last)) {
    const out = Object.values(r.movedTo).reduce((s, n) => s + (n ?? 0), 0);
    active[r.segment] += r.activeAtStart - r.voluntaryChurn - r.involuntaryChurn - out;
    for (const [to, n] of Object.entries(r.movedTo) as [SegmentId, number | undefined][]) active[to] += n ?? 0;
  }
  return active;
}

export function buildTwinFromHistory(input: BuildTwinInput): MerchantTwin {
  const { history, economics, profile, asOfMonth, source, reasonCounts } = input;
  assertBuildable(history, reasonCounts);
  const rows = history.segments;
  const voluntary = estimateChurn(rows, WEAK_RATE_PRIOR, "voluntary");
  const involuntary = estimatePooledInvoluntary(rows, WEAK_RATE_PRIOR);
  const acquisition = estimateAcquisition(history.acquisition);

  const segmentRows = (segment: SegmentId) => rows.filter((x) => x.segment === segment);
  const survivedChurn = (segment: SegmentId) =>
    segmentRows(segment).reduce((s, x) => s + x.activeAtStart - x.voluntaryChurn - x.involuntaryChurn, 0);
  const moved = (from: SegmentId, to: SegmentId) => segmentRows(from).reduce((s, x) => s + (x.movedTo[to] ?? 0), 0);
  const graduated = moved("new", "core") + moved("new", "price_sensitive");
  const recovered = moved("at_risk", "core");

  const months = acquisition.months;
  const csv = source === "csv";
  const fromCsv = `estimated from your CSV (${months} months)`;
  const feedbackRows = reasonCounts ? SEGMENTS.reduce((s, seg) => s + reasonCounts[seg].price + reasonCounts[seg].other, 0) : 0;
  const feedbackBySegment = SEGMENTS.flatMap((seg) => {
    const c = reasonCounts?.[seg];
    return c && c.price + c.other > 0 ? [`${SEGMENT_LABELS[seg]} ${c.price} price / ${c.other} other`] : [];
  }).join("; ");
  const noExposure = SEGMENTS.filter((seg) => voluntary[seg].exposure === 0)
    .map((seg) => ` ${SEGMENT_LABELS[seg]} uses the prior because ${csv ? "your CSV" : "the history"} has no exposure for that segment.`)
    .join("");
  const est = (note: string, evidenceCount: number): Provenance => ({ source: "estimated", note, evidenceCount });
  const assume = (note: string): Provenance => ({ source: "assumption", note });
  const provenance: Record<string, Provenance> = {
    monthlyChurn: est((csv ? `Beta posterior per segment, ${fromCsv}.` : `Beta posterior per segment from ${months} months of synthetic subscriber history.`) + noExposure, rows.reduce((s, r) => s + r.activeAtStart, 0)),
    involuntaryChurn: est(csv ? `Pooled Beta posterior of unrecovered failed payments, ${fromCsv}.` : "Pooled Beta posterior of unrecovered failed payments.", involuntary.exposure),
    monthlyAcquisition: est(csv ? `Mean and spread of monthly signups, ${fromCsv}.` : `Mean and spread of ${months} months of signups.`, months),
    transitions: est(csv ? `Beta posteriors of segment moves, ${fromCsv}.` : "Beta posteriors of observed segment moves.", rows.length),
    churnPriceElasticity: assume(csv ? "Your CSV has no price changes, so price sensitivity is a prior, not an estimate." : "No price changes in history, so price sensitivity is a prior, not an estimate."),
    acquisitionPriceElasticity: assume("Prior on how signups respond to list price."),
    annualUptake: assume(csv ? "Prior on annual-plan uptake when offered, per segment; no annual plan has been tried." : "Prior on annual-plan uptake when offered, per segment. Segments with resolved sandbox offers show their own observed row."),
    "offerChurnRelativeRisk.price": assume("Prior that a retention discount cuts churn to ~45% of normal for price-driven leavers (wide); updated from observed outcomes. The modelled effect does not scale with discount depth: deeper discounts cost more without retaining more."),
    "offerChurnRelativeRisk.other": assume("Prior that a retention discount cuts churn to ~85% of normal for other leavers (sd 0.10, allowing a small chance of no benefit); updated from observed outcomes. The modelled effect does not scale with discount depth: deeper discounts cost more without retaining more."),
    priceReasonShare: feedbackRows > 0
      ? est(`AI-classified from ${feedbackRows} feedback rows (${feedbackBySegment}), each updating its segment's prior: reason counts within each segment, not cancellation rates or causal discount effects. Segments without feedback keep the prior.`, feedbackRows)
      : assume("Prior share of price-driven leavers per segment; replaced by classified customer feedback when available. Sets the initial split and acquisitions; only cancel intent is re-split on entry, so other segments drift."),
    postOfferChurnMultiplier: assume("Prior on extra churn in the month a discount expires."),
    unitEconomics: assume(csv ? "Merchant-entered assumptions from the import form (list price, unit and shipping cost, payment fees); verify them for your account." : "Merchant-entered costs. Payment fee approximates a standard PayPal rate; verify for your account."),
  };
  // Classified counts update the segment's own prior (strength 10), so a handful of rows cannot swing it far.
  const priceReasonShare = (segment: SegmentId) => {
    const prior = reasonPrior(segment);
    const c = reasonCounts?.[segment];
    return c && c.price + c.other > 0 ? { alpha: prior.alpha + c.price, beta: prior.beta + c.other } : prior;
  };

  return {
    merchant: { ...profile },
    asOfMonth,
    initialActive: startingActives(rows),
    params: {
      currency: "USD",
      referencePrice: economics.listPrice,
      listPrice: economics.listPrice,
      unitCost: economics.unitCost,
      shippingCost: economics.shippingCost,
      paymentFeeRate: economics.paymentFeeRate,
      paymentFeeFixed: economics.paymentFeeFixed,
      monthlyAcquisition: { mean: acquisition.mean, sd: acquisition.sd },
      acquisitionPriceElasticity: { mean: 1.2, sd: 0.6 },
      involuntaryChurn: involuntary.posterior,
      transitions: {
        newGraduation: betaPosterior(FLAT_PRIOR, graduated, survivedChurn("new")),
        newToPriceSensitive: betaPosterior(FLAT_PRIOR, moved("new", "price_sensitive"), graduated),
        coreToAtRisk: betaPosterior(FLAT_PRIOR, moved("core", "at_risk"), survivedChurn("core")),
        priceSensitiveToAtRisk: betaPosterior(FLAT_PRIOR, moved("price_sensitive", "at_risk"), survivedChurn("price_sensitive")),
        atRiskRecovery: betaPosterior(FLAT_PRIOR, recovered, survivedChurn("at_risk")),
        atRiskToCancelIntent: betaPosterior(FLAT_PRIOR, moved("at_risk", "cancel_intent"), survivedChurn("at_risk") - recovered),
        cancelIntentToAtRisk: betaPosterior(FLAT_PRIOR, moved("cancel_intent", "at_risk"), survivedChurn("cancel_intent")),
      },
      offerChurnRelativeRisk: { price: { shape: 9, rate: 20 }, other: { shape: 72.25, rate: 85 } },
      postOfferChurnMultiplier: { mean: 1.25, sd: 0.15 },
      segments: {
        new: { label: SEGMENT_LABELS.new, monthlyChurn: voluntary.new.posterior, churnPriceElasticity: { mean: 1.5, sd: 0.7 }, annualUptake: { alpha: 2, beta: 38 }, priceReasonShare: priceReasonShare("new") },
        core: { label: SEGMENT_LABELS.core, monthlyChurn: voluntary.core.posterior, churnPriceElasticity: { mean: 1.0, sd: 0.5 }, annualUptake: { alpha: 3, beta: 22 }, priceReasonShare: priceReasonShare("core") },
        price_sensitive: { label: SEGMENT_LABELS.price_sensitive, monthlyChurn: voluntary.price_sensitive.posterior, churnPriceElasticity: { mean: 2.5, sd: 1.0 }, annualUptake: { alpha: 2, beta: 23 }, priceReasonShare: priceReasonShare("price_sensitive") },
        at_risk: { label: SEGMENT_LABELS.at_risk, monthlyChurn: voluntary.at_risk.posterior, churnPriceElasticity: { mean: 1.8, sd: 0.8 }, annualUptake: { alpha: 1, beta: 39 }, priceReasonShare: priceReasonShare("at_risk") },
        cancel_intent: { label: SEGMENT_LABELS.cancel_intent, monthlyChurn: voluntary.cancel_intent.posterior, churnPriceElasticity: { mean: 2.0, sd: 0.8 }, annualUptake: { alpha: 1, beta: 49 }, priceReasonShare: priceReasonShare("cancel_intent") },
      },
    },
    provenance,
  };
}

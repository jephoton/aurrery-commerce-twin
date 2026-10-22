import {
  betaPosterior,
  estimateAcquisition,
  estimateChurn,
  estimatePooledInvoluntary,
  type AcquisitionRecord,
  type SegmentMonthRecord,
} from "@/twin/calibrate";
import { Rng } from "@/twin/rng";
import { SEGMENTS, type MerchantTwin, type Provenance, type SegmentId } from "@/twin/types";

// Ridgeline Roasters: a fictional specialty-coffee subscription used for the demo.
// Its history is SYNTHETIC: generated once from fixed "true" rates with a fixed seed, then the
// twin estimates its parameters from that history exactly as it would from real data.

export interface DemoHistoryRow extends SegmentMonthRecord {
  /** Subscribers who moved from this segment to another this month, by destination. */
  movedTo: Partial<Record<SegmentId, number>>;
}

export interface DemoHistory {
  segments: DemoHistoryRow[];
  acquisition: AcquisitionRecord[];
}

const HISTORY_MONTHS = 18;
const HISTORY_SEED = 4242;
const AS_OF_MONTH = "2026-10";

/** Hidden generating rates. The twin never reads these directly; tests use them to check recovery. */
export const DEMO_TRUTH = {
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16, cancel_intent: 0.35 } as Record<SegmentId, number>,
  involuntary: 0.015,
  newGraduation: 0.33,
  newToPriceSensitive: 0.35,
  coreToAtRisk: 0.02,
  priceSensitiveToAtRisk: 0.035,
  atRiskRecovery: 0.12,
  atRiskToCancelIntent: 0.1,
  cancelIntentToAtRisk: 0.2,
  acquisitionMean: 190,
  acquisitionSd: 22,
};

const START_ACTIVE: Record<SegmentId, number> = { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 };

function monthLabel(offsetFromAsOf: number): string {
  const [y, m] = AS_OF_MONTH.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offsetFromAsOf, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function generateDemoHistory(): { history: DemoHistory; endActive: Record<SegmentId, number> } {
  const rng = new Rng(HISTORY_SEED);
  const t = DEMO_TRUTH;
  const active = { ...START_ACTIVE };
  const segments: DemoHistoryRow[] = [];
  const acquisition: AcquisitionRecord[] = [];

  for (let i = 0; i < HISTORY_MONTHS; i++) {
    const month = monthLabel(i - HISTORY_MONTHS);
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
      } else {
        movedTo.at_risk = rng.binomial(remaining, t.cancelIntentToAtRisk);
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

const WEAK_RATE_PRIOR = { alpha: 1, beta: 19 };
const FLAT_PRIOR = { alpha: 1, beta: 1 };

export function buildDemoTwin(): { twin: MerchantTwin; history: DemoHistory } {
  const { history, endActive } = generateDemoHistory();
  const rows = history.segments;
  const voluntary = estimateChurn(rows, WEAK_RATE_PRIOR, "voluntary");
  const involuntary = estimatePooledInvoluntary(rows, WEAK_RATE_PRIOR);
  const acquisition = estimateAcquisition(history.acquisition);

  const segmentRows = (segment: SegmentId) => rows.filter((x) => x.segment === segment);
  const stayed = (segment: SegmentId) =>
    segmentRows(segment).reduce((s, x) => s + x.activeAtStart - x.voluntaryChurn - x.involuntaryChurn, 0);
  const moved = (from: SegmentId, to: SegmentId) => segmentRows(from).reduce((s, x) => s + (x.movedTo[to] ?? 0), 0);
  const graduated = moved("new", "core") + moved("new", "price_sensitive");
  const recovered = moved("at_risk", "core");

  const est = (note: string, evidenceCount: number): Provenance => ({ source: "estimated", note, evidenceCount });
  const assume = (note: string): Provenance => ({ source: "assumption", note });
  const provenance: Record<string, Provenance> = {
    monthlyChurn: est(`Beta posterior per segment from ${HISTORY_MONTHS} months of synthetic subscriber history.`, rows.reduce((s, r) => s + r.activeAtStart, 0)),
    involuntaryChurn: est("Pooled Beta posterior of unrecovered failed payments.", involuntary.exposure),
    monthlyAcquisition: est(`Mean and spread of ${acquisition.months} months of signups.`, acquisition.months),
    transitions: est("Beta posteriors of observed segment moves.", rows.length),
    churnPriceElasticity: assume("No price changes in history, so price sensitivity is a prior, not an estimate."),
    acquisitionPriceElasticity: assume("Prior on how signups respond to list price."),
    annualUptake: assume("Prior on annual-plan uptake when offered; no annual plan has been tried."),
    offerChurnRelativeRisk: assume("Prior that a retention discount cuts churn to ~60% of normal (wide); updated from observed outcomes."),
    postOfferChurnMultiplier: assume("Prior on extra churn in the month a discount expires."),
    unitEconomics: assume("Merchant-entered costs. Payment fee approximates a standard PayPal rate; verify for your account."),
  };

  const twin: MerchantTwin = {
    merchant: {
      id: "ridgeline-roasters",
      name: "Ridgeline Roasters",
      description: "Specialty coffee subscription: one 340g bag of single-origin coffee shipped monthly.",
      planName: "Roaster's Choice (monthly)",
    },
    asOfMonth: AS_OF_MONTH,
    initialActive: endActive,
    params: {
      currency: "USD",
      referencePrice: 24,
      listPrice: 24,
      unitCost: 9.2,
      shippingCost: 4.1,
      paymentFeeRate: 0.0349,
      paymentFeeFixed: 0.49,
      monthlyAcquisition: { mean: acquisition.mean, sd: acquisition.sd },
      acquisitionPriceElasticity: { mean: 1.2, sd: 0.6 },
      involuntaryChurn: involuntary.posterior,
      transitions: {
        newGraduation: betaPosterior(FLAT_PRIOR, graduated, stayed("new")),
        newToPriceSensitive: betaPosterior(FLAT_PRIOR, moved("new", "price_sensitive"), graduated),
        coreToAtRisk: betaPosterior(FLAT_PRIOR, moved("core", "at_risk"), stayed("core")),
        priceSensitiveToAtRisk: betaPosterior(FLAT_PRIOR, moved("price_sensitive", "at_risk"), stayed("price_sensitive")),
        atRiskRecovery: betaPosterior(FLAT_PRIOR, recovered, stayed("at_risk")),
        atRiskToCancelIntent: betaPosterior(FLAT_PRIOR, moved("at_risk", "cancel_intent"), stayed("at_risk") - recovered),
        cancelIntentToAtRisk: betaPosterior(FLAT_PRIOR, moved("cancel_intent", "at_risk"), stayed("cancel_intent")),
      },
      offerChurnRelativeRisk: { shape: 6, rate: 10 },
      postOfferChurnMultiplier: { mean: 1.25, sd: 0.15 },
      segments: {
        new: {
          label: "New (first 3 months)",
          monthlyChurn: voluntary.new.posterior,
          churnPriceElasticity: { mean: 1.5, sd: 0.7 },
          annualUptake: { alpha: 2, beta: 38 },
        },
        core: {
          label: "Core",
          monthlyChurn: voluntary.core.posterior,
          churnPriceElasticity: { mean: 1.0, sd: 0.5 },
          annualUptake: { alpha: 3, beta: 22 },
        },
        price_sensitive: {
          label: "Price sensitive",
          monthlyChurn: voluntary.price_sensitive.posterior,
          churnPriceElasticity: { mean: 2.5, sd: 1.0 },
          annualUptake: { alpha: 2, beta: 23 },
        },
        at_risk: {
          label: "At risk (skipped or paused recently)",
          monthlyChurn: voluntary.at_risk.posterior,
          churnPriceElasticity: { mean: 1.8, sd: 0.8 },
          annualUptake: { alpha: 1, beta: 39 },
        },
        cancel_intent: {
          label: "Cancel intent (opened cancel flow)",
          monthlyChurn: voluntary.cancel_intent.posterior,
          churnPriceElasticity: { mean: 2.0, sd: 0.8 },
          annualUptake: { alpha: 1, beta: 49 },
        },
      },
    },
    provenance,
  };
  return { twin, history };
}

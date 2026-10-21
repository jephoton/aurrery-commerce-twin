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
  /** Subscribers leaving this segment for another (maturing, drifting at-risk, or recovering). */
  transitionedOut: number;
  /** For the `new` segment: matured subscribers who became price sensitive. */
  toPriceSensitive: number;
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
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16 } as Record<SegmentId, number>,
  involuntary: 0.015,
  newGraduation: 0.33,
  newToPriceSensitive: 0.35,
  coreToAtRisk: 0.02,
  priceSensitiveToAtRisk: 0.035,
  atRiskRecovery: 0.12,
  acquisitionMean: 190,
  acquisitionSd: 22,
};

const START_ACTIVE: Record<SegmentId, number> = { new: 380, core: 1180, price_sensitive: 470, at_risk: 230 };

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

    const inflow: Record<SegmentId, number> = { new: 0, core: 0, price_sensitive: 0, at_risk: 0 };
    for (const segment of SEGMENTS) {
      const start = active[segment];
      const voluntary = rng.binomial(start, t.churn[segment]);
      const involuntary = rng.binomial(start - voluntary, t.involuntary);
      const remaining = start - voluntary - involuntary;
      let transitionedOut = 0;
      let toPriceSensitive = 0;
      if (segment === "new") {
        transitionedOut = rng.binomial(remaining, t.newGraduation);
        toPriceSensitive = rng.binomial(transitionedOut, t.newToPriceSensitive);
        inflow.price_sensitive += toPriceSensitive;
        inflow.core += transitionedOut - toPriceSensitive;
      } else if (segment === "core") {
        transitionedOut = rng.binomial(remaining, t.coreToAtRisk);
        inflow.at_risk += transitionedOut;
      } else if (segment === "price_sensitive") {
        transitionedOut = rng.binomial(remaining, t.priceSensitiveToAtRisk);
        inflow.at_risk += transitionedOut;
      } else {
        transitionedOut = rng.binomial(remaining, t.atRiskRecovery);
        inflow.core += transitionedOut;
      }
      segments.push({ month, segment, activeAtStart: start, voluntaryChurn: voluntary, involuntaryChurn: involuntary, transitionedOut, toPriceSensitive });
      active[segment] = remaining - transitionedOut;
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

  const transitionPosterior = (segment: SegmentId) => {
    const r = rows.filter((x) => x.segment === segment);
    const exposure = r.reduce((s, x) => s + x.activeAtStart - x.voluntaryChurn - x.involuntaryChurn, 0);
    const events = r.reduce((s, x) => s + x.transitionedOut, 0);
    return betaPosterior(FLAT_PRIOR, events, exposure);
  };
  const newRows = rows.filter((x) => x.segment === "new");
  const graduated = newRows.reduce((s, x) => s + x.transitionedOut, 0);
  const toPriceSensitive = newRows.reduce((s, x) => s + x.toPriceSensitive, 0);

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
        newGraduation: transitionPosterior("new"),
        newToPriceSensitive: betaPosterior(FLAT_PRIOR, toPriceSensitive, graduated),
        coreToAtRisk: transitionPosterior("core"),
        priceSensitiveToAtRisk: transitionPosterior("price_sensitive"),
        atRiskRecovery: transitionPosterior("at_risk"),
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
      },
    },
    provenance,
  };
  return { twin, history };
}

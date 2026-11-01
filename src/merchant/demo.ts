import { buildTwinFromHistory, type TwinEconomics } from "@/twin/build-twin";
import type { HistoryRecord, TwinHistory } from "@/twin/history";
import { generateSyntheticHistory, type SyntheticTruth } from "@/twin/synthetic-history";
import type { MerchantProfile, MerchantTwin, SegmentId } from "@/twin/types";

// Ridgeline Roasters: a fictional specialty-coffee subscription used for the demo.
// Its history is SYNTHETIC: generated once from fixed "true" rates with a fixed seed, then the
// twin estimates its parameters from that history exactly as it would from real data
// (the same builder imported CSVs use).

export type DemoHistoryRow = HistoryRecord;
export type DemoHistory = TwinHistory;

const HISTORY_MONTHS = 18;
const HISTORY_SEED = 4242;
const AS_OF_MONTH = "2026-10";

/** Hidden generating rates. The twin never reads these directly; tests use them to check recovery. */
export const DEMO_TRUTH: SyntheticTruth = {
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16, cancel_intent: 0.35 },
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

export const RIDGELINE_PROFILE: MerchantProfile = {
  id: "ridgeline-roasters",
  name: "Ridgeline Roasters",
  description: "Specialty coffee subscription: one 340g bag of single-origin coffee shipped monthly.",
  planName: "Roaster's Choice (monthly)",
};

export const RIDGELINE_ECONOMICS: TwinEconomics = { listPrice: 24, unitCost: 9.2, shippingCost: 4.1, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

export function generateDemoHistory(): { history: DemoHistory; endActive: Record<SegmentId, number> } {
  return generateSyntheticHistory({ truth: DEMO_TRUTH, startActive: START_ACTIVE, months: HISTORY_MONTHS, seed: HISTORY_SEED, asOfMonth: AS_OF_MONTH });
}

export function buildDemoTwin(): { twin: MerchantTwin; history: DemoHistory } {
  const { history } = generateDemoHistory();
  const twin = buildTwinFromHistory({ history, economics: RIDGELINE_ECONOMICS, profile: RIDGELINE_PROFILE, asOfMonth: AS_OF_MONTH, source: "synthetic" });
  return { twin, history };
}

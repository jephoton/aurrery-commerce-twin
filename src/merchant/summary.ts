import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { AnnualEvidence } from "@/merchant/observed-snapshot";
import type { ReasonCounts } from "@/twin/build-twin";
import { betaMean, type ParameterChange } from "@/twin/calibrate";
import type { TwinHistory } from "@/twin/history";
import { SEGMENTS, type MerchantTwin, type Provenance, type SegmentId } from "@/twin/types";

/** Present only for a merchant imported from CSV in this browser tab. */
export interface ImportedDetails {
  months: number;
  firstMonth: string;
  lastMonth: string;
  feedbackRows: number;
  reasonCounts?: ReasonCounts;
}

export interface MerchantSummary {
  name: string;
  description: string;
  planName: string;
  asOfMonth: string;
  listPrice: number;
  active: number;
  mrr: number;
  lastMonthChurnRate: number;
  segments: { id: SegmentId; label: string; active: number; churn: number }[];
  provenance: Record<string, Provenance>;
  observedEvidence?: DiscountEvidence;
  parameterChanges?: ParameterChange[];
  annualEvidence?: AnnualEvidence;
  imported?: ImportedDetails;
}

/** The overview the page (Ridgeline) and the import validation route (imports) both show. */
export function summarizeMerchant(
  twin: MerchantTwin,
  history: TwinHistory,
  extra: Pick<MerchantSummary, "observedEvidence" | "parameterChanges" | "annualEvidence" | "imported"> = {},
): MerchantSummary {
  const lastMonth = history.segments.at(-1)!.month;
  const recent = history.segments.filter((r) => r.month === lastMonth);
  const startActive = recent.reduce((s, r) => s + r.activeAtStart, 0);
  const churned = recent.reduce((s, r) => s + r.voluntaryChurn + r.involuntaryChurn, 0);
  const active = SEGMENTS.reduce((s, seg) => s + twin.initialActive[seg], 0);
  return {
    name: twin.merchant.name,
    description: twin.merchant.description,
    planName: twin.merchant.planName,
    asOfMonth: twin.asOfMonth,
    listPrice: twin.params.listPrice,
    active,
    mrr: active * twin.params.listPrice,
    lastMonthChurnRate: startActive > 0 ? churned / startActive : 0,
    segments: SEGMENTS.map((s) => ({ id: s, label: twin.params.segments[s].label, active: twin.initialActive[s], churn: betaMean(twin.params.segments[s].monthlyChurn) })),
    provenance: twin.provenance,
    ...extra,
  };
}

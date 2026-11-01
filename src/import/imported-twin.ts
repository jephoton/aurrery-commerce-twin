import { buildTwinFromHistory } from "@/twin/build-twin";
import type { TwinHistory } from "@/twin/history";
import type { Strategy } from "@/twin/interventions";
import { SEGMENTS, type MerchantTwin } from "@/twin/types";
import { MOVE_COLUMNS, SUPPORTED_MOVES, validateHistoryRows, type HistoryRow } from "./history-csv";
import { fromTuple, type ImportPayload } from "./import-payload";
import { capErrors, type RowError } from "./row-error";

export const IMPORTED_MERCHANT_ID = "imported-csv";

export type ImportedTwin =
  | { ok: true; twin: MerchantTwin; history: TwinHistory; reasonTargeting: boolean; feedbackRows: number; months: number; firstMonth: string; lastMonth: string }
  | { ok: false; errors: RowError[] };

/** CSV rows → the builder's history, sorted by month then segment. A `new` row's exposure includes that month's signups. */
export function toTwinHistory(rows: HistoryRow[]): TwinHistory {
  const order = (r: HistoryRow) => `${r.month}|${SEGMENTS.indexOf(r.segment)}`;
  const sorted = [...rows].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return {
    segments: sorted.map((r) => ({
      month: r.month,
      segment: r.segment,
      activeAtStart: r.active_start + (r.segment === "new" ? r.new_signups : 0),
      voluntaryChurn: r.voluntary_cancels,
      involuntaryChurn: r.involuntary_cancels,
      movedTo: Object.fromEntries(SUPPORTED_MOVES[r.segment].map((to) => [to, r[MOVE_COLUMNS[to]]])),
    })),
    acquisition: [...new Map(sorted.map((r) => [r.month, r.new_signups]))].map(([month, newSubscribers]) => ({ month, newSubscribers })),
  };
}

/**
 * Re-validates a payload that already passed `ImportPayloadSchema` (cells parsed and bounded) and
 * builds the imported twin for one request. Nothing is stored.
 */
export function buildImportedTwin(payload: ImportPayload): ImportedTwin {
  const rows = payload.rows.map(fromTuple);
  const errors = validateHistoryRows(rows);
  if (errors.length) return { ok: false, errors: capErrors(errors) };
  const history = toTwinHistory(rows);
  const months = history.acquisition.map((a) => a.month);
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  const counts = payload.reasonCounts;
  const feedbackRows = counts ? SEGMENTS.reduce((s, seg) => s + counts[seg].price + counts[seg].other, 0) : 0;
  const e = payload.economics;
  const twin = buildTwinFromHistory({
    history,
    economics: { listPrice: e.listPrice, unitCost: e.unitCost, shippingCost: e.shippingCost, paymentFeeRate: e.paymentFeeRate, paymentFeeFixed: e.paymentFeeFixed },
    profile: { id: IMPORTED_MERCHANT_ID, name: e.merchantName, description: "Imported from your CSV for simulation only.", planName: e.planName },
    asOfMonth: lastMonth,
    source: "csv",
    ...(counts && feedbackRows > 0 ? { reasonCounts: counts } : {}),
  });
  return { ok: true, twin, history, reasonTargeting: feedbackRows > 0, feedbackRows, months: months.length, firstMonth, lastMonth };
}

/** Leaving reasons are only known from classified feedback. */
export const usesReasonTargeting = (strategy: Strategy) =>
  strategy.intervention.kind === "targeted_discount" && strategy.intervention.reason === "price";

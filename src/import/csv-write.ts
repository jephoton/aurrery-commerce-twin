import type { TwinHistory } from "@/twin/history";
import { HISTORY_COLUMNS, type HistoryRow } from "./history-csv";

/** Twin history → CSV rows. `active_start` excludes the month's signups (they are listed in `new_signups`). */
export function historyRowsFromTwin(history: TwinHistory): HistoryRow[] {
  const signups = new Map(history.acquisition.map((a) => [a.month, a.newSubscribers]));
  return history.segments.map((r) => {
    const joined = signups.get(r.month) ?? 0;
    return {
      month: r.month,
      segment: r.segment,
      active_start: r.activeAtStart - (r.segment === "new" ? joined : 0),
      voluntary_cancels: r.voluntaryChurn,
      involuntary_cancels: r.involuntaryChurn,
      moved_to_core: r.movedTo.core ?? 0,
      moved_to_price_sensitive: r.movedTo.price_sensitive ?? 0,
      moved_to_at_risk: r.movedTo.at_risk ?? 0,
      moved_to_cancel_intent: r.movedTo.cancel_intent ?? 0,
      new_signups: joined,
    };
  });
}

/** Quotes a field that contains a quote, comma or line break, or that has surrounding spaces. */
const field = (value: string | number) => {
  const s = String(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return `${[header.join(","), ...rows.map((r) => r.map(field).join(","))].join("\n")}\n`;
}

export function historyCsv(rows: HistoryRow[]): string {
  return toCsv(HISTORY_COLUMNS, rows.map((r) => HISTORY_COLUMNS.map((c) => r[c])));
}

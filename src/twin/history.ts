import type { AcquisitionRecord, SegmentMonthRecord } from "./calibrate";
import type { SegmentId } from "./types";

/**
 * One segment-month of subscriber history with the moves out of the segment, by destination.
 * For `new`, `activeAtStart` includes that month's signups (they are exposed to its churn).
 */
export interface HistoryRecord extends SegmentMonthRecord {
  /** Subscribers who moved from this segment to another this month, by destination. */
  movedTo: Partial<Record<SegmentId, number>>;
}

export interface TwinHistory {
  segments: HistoryRecord[];
  acquisition: AcquisitionRecord[];
}

/** The `YYYY-MM` month `offset` months after `month` (negative for earlier months). */
export function monthOffset(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

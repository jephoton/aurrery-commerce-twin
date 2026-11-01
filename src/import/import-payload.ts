import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import { EconomicsSchema } from "./economics";
import { MAX_FEEDBACK_ROWS } from "./feedback-csv";
import { MAX_COUNT, MAX_HISTORY_ROWS, MIN_HISTORY_MONTHS, MONTH_PATTERN, type HistoryRow } from "./history-csv";

// What the browser sends with validate, simulate and agent requests. The server parses it with this
// strict, bounded schema first, then re-validates the cross-row rules (`validateHistoryRows`) and
// rebuilds the twin for that request only; nothing is stored.

const count = z.number().int().min(0).max(MAX_COUNT);
const month = z.string().regex(MONTH_PATTERN);
/** One history row in header order: month, segment, then the eight counts. */
export const HistoryTupleSchema = z.tuple([month, z.enum(SEGMENTS), count, count, count, count, count, count, count, count]);
export type HistoryTuple = z.infer<typeof HistoryTupleSchema>;

const reasonCount = z.number().int().min(0).max(MAX_FEEDBACK_ROWS);
const pair = z.strictObject({ price: reasonCount, other: reasonCount });
export const ReasonCountsSchema = z.strictObject({ new: pair, core: pair, price_sensitive: pair, at_risk: pair, cancel_intent: pair })
  .refine((c) => SEGMENTS.reduce((s, k) => s + c[k].price + c[k].other, 0) <= MAX_FEEDBACK_ROWS, { message: `at most ${MAX_FEEDBACK_ROWS} classified feedback rows` });

export const ImportPayloadSchema = z.strictObject({
  rows: z.array(HistoryTupleSchema).min(MIN_HISTORY_MONTHS * SEGMENTS.length).max(MAX_HISTORY_ROWS),
  economics: EconomicsSchema,
  reasonCounts: ReasonCountsSchema.optional(),
});
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

export function toTuple(r: HistoryRow): HistoryTuple {
  return [r.month, r.segment, r.active_start, r.voluntary_cancels, r.involuntary_cancels, r.moved_to_core, r.moved_to_price_sensitive, r.moved_to_at_risk, r.moved_to_cancel_intent, r.new_signups];
}

export function fromTuple([month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups]: HistoryTuple): HistoryRow {
  return { month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups };
}

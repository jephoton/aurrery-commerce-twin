import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import { EconomicsSchema } from "./economics";
import { CONTROL_CHARACTER_MESSAGE, hasControlCharacters, MAX_FEEDBACK_ROWS, MAX_FEEDBACK_TEXT } from "./feedback-csv";
import { HISTORY_COLUMNS, MAX_COUNT, MAX_HISTORY_ROWS, MIN_HISTORY_MONTHS, MONTH_PATTERN, type HistoryRow } from "./history-csv";
import { capErrors, type RowError } from "./row-error";

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

/**
 * Schema issues as row errors: `rows[i][j]` is CSV row i + 2 and column j (a history tuple index, or a feedback
 * field name); other paths are named as dotted
 * paths. Unknown keys get a fixed message, because Zod's default one would echo the key the client sent.
 */
export function payloadIssues(error: z.ZodError): RowError[] {
  return capErrors(error.issues.map((issue): RowError => {
    const message = issue.code === "unrecognized_keys" ? "unexpected field" : issue.message;
    const [head, index, field] = issue.path;
    if (head === "rows" && typeof index === "number") {
      const column = typeof field === "number" ? HISTORY_COLUMNS[field] ?? null : typeof field === "string" ? field : null;
      return { row: index + 2, column, message };
    }
    return { row: null, column: issue.path.map(String).join(".") || null, message };
  }));
}

/** One parsed feedback row as the browser sends it for classification. */
export const FeedbackRowSchema = z.strictObject({
  segment: z.enum(SEGMENTS),
  text: z.string().trim().min(1).max(MAX_FEEDBACK_TEXT).refine((text) => !hasControlCharacters(text), CONTROL_CHARACTER_MESSAGE),
});

/** Body of `POST /api/import/classify`. The rows are classified and dropped; nothing is stored. */
export const ClassifyRequestSchema = z.strictObject({ rows: z.array(FeedbackRowSchema).min(1).max(MAX_FEEDBACK_ROWS) });

import "server-only";
import { MAX_FEEDBACK_ROWS, type FeedbackRow } from "@/import/feedback-csv";
import type { ReasonCounts } from "@/twin/build-twin";
import type { PredictionCache } from "./cache";
import { classifyFeedback } from "./classify";
import type { FeedbackMessage } from "./contracts";
import { summarizeEvidence } from "./evidence";
import type { ClassificationProvider } from "./providers";

export interface ImportedClassification {
  reasonCounts: ReasonCounts;
  total: number;
  accepted: number;
  unclassified: number;
  cacheHits: number;
  stopped: boolean;
  notes: string[];
}

/**
 * Classifies uploaded feedback rows into per-segment reason counts. Text goes to the classifier only and is never
 * returned, stored or logged; the cache (which must be memory-only, never the persistent ledger cache) keeps hashed
 * keys and labels. The CSV has no source column, so every row is a cancellation-flow message (decision 17).
 */
export async function classifyImportedFeedback(rows: FeedbackRow[], options: { provider: ClassificationProvider; cache: PredictionCache }): Promise<ImportedClassification> {
  if (rows.length > MAX_FEEDBACK_ROWS) throw new Error(`at most ${MAX_FEEDBACK_ROWS} feedback rows are allowed`);
  const messages: FeedbackMessage[] = rows.map((row, i) => ({ id: `f${i + 1}`, text: row.text, source: "cancel_flow", segment: row.segment }));
  const result = await classifyFeedback(messages, { provider: options.provider, cache: options.cache });
  const evidence = summarizeEvidence(messages, result.accepted);
  const accepted = evidence.accepted.length;
  const unclassified = result.total - accepted;
  const notes = [`${accepted} of ${result.total} rows classified with confidence of at least 0.70; ${unclassified} left unclassified and not counted.`];
  if (result.cacheHits) notes.push(`${result.cacheHits} reused from this server's in-memory cache (labels only).`);
  if (result.stopped) notes.push("Classification stopped before every row was classified (time, token or provider limit), so these counts are partial.");
  notes.push("Counts are leaving reasons within each segment, not cancellation rates or causal discount effects.");
  return { reasonCounts: evidence.segments, total: result.total, accepted, unclassified, cacheHits: result.cacheHits, stopped: result.stopped, notes };
}

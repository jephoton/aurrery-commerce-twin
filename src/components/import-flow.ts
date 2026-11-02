import { z } from "zod";
import { EconomicsSchema, economicsErrors } from "@/import/economics";
import { parseFeedbackCsv } from "@/import/feedback-csv";
import { parseHistoryCsv } from "@/import/history-csv";
import { ReasonCountsSchema, toTuple, type ImportPayload } from "@/import/import-payload";
import { capErrors, formatRowError, MAX_REPORTED_ERRORS, type RowError } from "@/import/row-error";
import { starterStrategiesFor } from "@/merchant/candidates";
import type { MerchantSummary } from "@/merchant/summary";
import type { ReasonCounts } from "@/twin/build-twin";
import type { Strategy } from "@/twin/interventions";
import { SEGMENTS } from "@/twin/types";

// Browser side of a CSV import: parse locally for instant per-row errors, then classify feedback (optional) and let the
// server re-validate. Nothing changes unless every step succeeds; the session lives only in this tab's memory.

export interface ImportSession {
  /** Changes on every successful import, so the workspace remounts. */
  id: number;
  payload: ImportPayload;
  summary: MerchantSummary;
  starterStrategies: Strategy[];
  reasonTargeting: boolean;
  classifierNotes: string[];
}
/** `import` is the combined list's "more errors not shown" line, which can span files. */
export interface ImportError extends RowError { source: "history" | "feedback" | "economics" | "server" | "import" }
export interface ImportFiles { history: string; feedback: string | null; economics: unknown }
/** `aborted`: the caller cancelled (unmount, a newer build); nothing should be shown or applied. */
export type ImportResult = { ok: true; session: ImportSession } | { ok: false; errors: ImportError[]; aborted?: true };
export interface LoadedFile { name: string; text: string }
type FileSource = "history" | "feedback";

const LABELS: Record<ImportError["source"], string> = { history: "History file", feedback: "Feedback file", economics: "Economics", server: "Server check", import: "Import" };
export const formatImportError = (error: ImportError) => `${LABELS[error.source]} · ${formatRowError(error)}`;

const UNEXPECTED_REPLY = "The server sent an unexpected reply. Nothing was changed.";
/** Bounds on what a server reply may put on screen. */
const MAX_NOTES = 10;
const MAX_TEXT = 500;

let nextSessionId = 1;
const tag = (source: ImportError["source"], errors: RowError[]): ImportError[] => capErrors(errors).map((error) => ({ ...error, source }));
const failure = (source: ImportError["source"], message: string): ImportResult => ({ ok: false, errors: [{ source, row: null, column: null, message }] });
const ABORTED: ImportResult = { ok: false, aborted: true, errors: [] };

/** Checks the size before reading, so an oversized file is never loaded into memory. */
export async function readLimitedFile(file: Pick<File, "name" | "size" | "text">, maxBytes: number, source: FileSource): Promise<LoadedFile | ImportError> {
  if (file.size > maxBytes) return { source, row: null, column: null, message: `${file.name} is larger than ${maxBytes / 1024} KiB` };
  try {
    return { name: file.name, text: await file.text() };
  } catch {
    return { source, row: null, column: null, message: `${file.name} could not be read. Choose it again.` };
  }
}

/** Only the newest read of each file may be applied; a newer pick, the sample, Remove or Build makes older reads stale. */
export function createReadGuard() {
  const latest: Record<FileSource, number> = { history: 0, feedback: 0 };
  return {
    begin: (source: FileSource) => ({ source, seq: ++latest[source] }),
    isCurrent: (token: { source: FileSource; seq: number }) => latest[token.source] === token.seq,
    invalidate(source?: FileSource) {
      if (source !== "feedback") latest.history++;
      if (source !== "history") latest.feedback++;
    },
  };
}

const OMITTED = /^(\d+) more errors not shown$/;
const omittedCount = (e: RowError) => (e.row === null && e.column === null ? Number(OMITTED.exec(e.message)?.[1] ?? 0) : 0);
/** One cap for the whole list; each file's own "N more" line is folded into the total. */
function capCombined(errors: ImportError[]): ImportError[] {
  const shown = errors.filter((e) => omittedCount(e) === 0);
  const total = shown.length + errors.reduce((n, e) => n + omittedCount(e), 0);
  if (total <= MAX_REPORTED_ERRORS) return shown;
  const kept = shown.slice(0, MAX_REPORTED_ERRORS);
  return [...kept, { source: "import", row: null, column: null, message: `${total - kept.length} more errors not shown` }];
}

async function post(fetcher: typeof fetch, url: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, data: { message: "Network error. Nothing was changed." } };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shortText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

/** Server errors are untrusted input: keep only well-formed entries, cap them, and fall back to one message. */
function serverErrors(source: ImportError["source"], response: { status: number; data: unknown }): ImportError[] {
  const body = isRecord(response.data) ? response.data : {};
  const errors = Array.isArray(body.errors)
    ? body.errors.filter((e): e is RowError => isRecord(e) && shortText(e.message)
      && (e.row === null || e.row === undefined || Number.isInteger(e.row)) && (e.column === null || e.column === undefined || shortText(e.column)))
      .map((e) => ({ row: e.row ?? null, column: e.column ?? null, message: e.message }))
    : [];
  if (errors.length) return tag(source, errors);
  const message = shortText(body.message) ? body.message : response.status === 429 ? "Too many requests. Try again later." : `Request failed (${response.status}).`;
  return [{ source, row: null, column: null, message }];
}

function classification(data: unknown): { reasonCounts: ReasonCounts; notes: string[] } | null {
  if (!isRecord(data)) return null;
  const counts = ReasonCountsSchema.safeParse(data.reasonCounts);
  if (!counts.success || !Array.isArray(data.notes) || !data.notes.every(shortText)) return null;
  return { reasonCounts: counts.data, notes: data.notes.slice(0, MAX_NOTES) };
}

const text = z.string().max(MAX_TEXT);
const finite = z.number().finite();
/**
 * The summary fields an imported workspace renders. Unknown fields are stripped, so Ridgeline-only evidence
 * (observed, annual, parameter changes) can never ride along on an imported summary.
 */
const ImportedSummarySchema = z.object({
  name: text.min(1), description: text, planName: text, asOfMonth: text,
  listPrice: finite, active: finite, mrr: finite, lastMonthChurnRate: finite,
  segments: z.array(z.object({ id: z.enum(SEGMENTS), label: text, active: finite, churn: finite })).length(SEGMENTS.length),
  provenance: z.record(z.string().max(80), z.object({ source: z.enum(["estimated", "assumption", "observed"]), note: text, evidenceCount: finite.optional() })),
  imported: z.object({ months: finite, firstMonth: text, lastMonth: text, feedbackRows: finite, reasonCounts: ReasonCountsSchema.optional() }),
});
const ValidateReplySchema = z.object({ summary: ImportedSummarySchema, reasonTargeting: z.boolean() });

function validation(data: unknown): { summary: MerchantSummary; reasonTargeting: boolean } | null {
  const parsed = ValidateReplySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Blank or non-numeric form fields arrive as NaN; say so instead of Zod's type message. */
function economicsMessages(input: unknown, errors: RowError[]): RowError[] {
  const nan = (column: string | null) => column !== null && isRecord(input) && Number.isNaN(input[column]);
  return errors.map((e) => (nan(e.column) ? { ...e, message: "must be a number" } : e));
}

export async function buildImport(files: ImportFiles, fetcher: typeof fetch = fetch, options: { signal?: AbortSignal } = {}): Promise<ImportResult> {
  const { signal } = options;
  if (signal?.aborted) return ABORTED;
  const history = parseHistoryCsv(files.history);
  const economics = EconomicsSchema.safeParse(files.economics);
  const feedback = files.feedback === null ? null : parseFeedbackCsv(files.feedback);
  if (!history.ok || !economics.success || (feedback && !feedback.ok)) {
    return { ok: false, errors: capCombined([
      ...(history.ok ? [] : tag("history", history.errors)),
      ...(economics.success ? [] : tag("economics", economicsMessages(files.economics, economicsErrors(economics.error)))),
      ...(feedback && !feedback.ok ? tag("feedback", feedback.errors) : []),
    ]) };
  }
  let reasonCounts: ReasonCounts | undefined;
  let classifierNotes: string[] = [];
  if (feedback) {
    const classified = await post(fetcher, "/api/import/classify", { rows: feedback.rows }, signal);
    if (signal?.aborted) return ABORTED;
    if (!classified.ok) return { ok: false, errors: serverErrors("feedback", classified) };
    const data = classification(classified.data);
    if (!data) return failure("feedback", UNEXPECTED_REPLY);
    reasonCounts = data.reasonCounts;
    classifierNotes = data.notes;
  }
  const payload: ImportPayload = { rows: history.rows.map(toTuple), economics: economics.data, ...(reasonCounts ? { reasonCounts } : {}) };
  const validated = await post(fetcher, "/api/import/validate", payload, signal);
  if (signal?.aborted) return ABORTED;
  if (!validated.ok) return { ok: false, errors: serverErrors("server", validated) };
  const data = validation(validated.data);
  if (!data) return failure("server", UNEXPECTED_REPLY);
  const { summary, reasonTargeting } = data;
  // Same starter set as the server's `importedStarterStrategies`: an empty cancel-intent save is dropped too.
  const cancelIntentActive = summary.segments.find((s) => s.id === "cancel_intent")?.active;
  const starterStrategies = starterStrategiesFor(summary.listPrice, { reasonTargeting, ...(cancelIntentActive === undefined ? {} : { cancelIntentActive }) });
  return { ok: true, session: { id: nextSessionId++, payload, summary, reasonTargeting, classifierNotes, starterStrategies } };
}

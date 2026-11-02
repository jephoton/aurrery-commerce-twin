import { EconomicsSchema, economicsErrors } from "@/import/economics";
import { parseFeedbackCsv } from "@/import/feedback-csv";
import { parseHistoryCsv } from "@/import/history-csv";
import { ReasonCountsSchema, toTuple, type ImportPayload } from "@/import/import-payload";
import { capErrors, formatRowError, type RowError } from "@/import/row-error";
import { starterStrategiesFor } from "@/merchant/candidates";
import type { MerchantSummary } from "@/merchant/summary";
import type { ReasonCounts } from "@/twin/build-twin";
import type { Strategy } from "@/twin/interventions";

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
export interface ImportError extends RowError { source: "history" | "feedback" | "economics" | "server" }
export interface ImportFiles { history: string; feedback: string | null; economics: unknown }
export type ImportResult = { ok: true; session: ImportSession } | { ok: false; errors: ImportError[] };
export interface LoadedFile { name: string; text: string }

const LABELS: Record<ImportError["source"], string> = { history: "History file", feedback: "Feedback file", economics: "Economics", server: "Server check" };
export const formatImportError = (error: ImportError) => `${LABELS[error.source]} · ${formatRowError(error)}`;

const UNEXPECTED_REPLY = "The server sent an unexpected reply. Nothing was changed.";
/** Bounds on what a server reply may put on screen. */
const MAX_NOTES = 10;
const MAX_TEXT = 500;

let nextSessionId = 1;
const tag = (source: ImportError["source"], errors: RowError[]): ImportError[] => capErrors(errors).map((error) => ({ ...error, source }));
const failure = (source: ImportError["source"], message: string): ImportResult => ({ ok: false, errors: [{ source, row: null, column: null, message }] });

/** Checks the size before reading, so an oversized file is never loaded into memory. */
export async function readLimitedFile(file: Pick<File, "name" | "size" | "text">, maxBytes: number, source: "history" | "feedback"): Promise<LoadedFile | ImportError> {
  if (file.size > maxBytes) return { source, row: null, column: null, message: `${file.name} is larger than ${maxBytes / 1024} KiB` };
  return { name: file.name, text: await file.text() };
}

async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function validation(data: unknown): { summary: MerchantSummary; reasonTargeting: boolean } | null {
  if (!isRecord(data) || typeof data.reasonTargeting !== "boolean" || !isRecord(data.summary)) return null;
  const summary = data.summary;
  if (!shortText(summary.name) || typeof summary.listPrice !== "number" || !Array.isArray(summary.segments) || !isRecord(summary.imported)) return null;
  return { summary: summary as unknown as MerchantSummary, reasonTargeting: data.reasonTargeting };
}

export async function buildImport(files: ImportFiles, fetcher: typeof fetch = fetch): Promise<ImportResult> {
  const history = parseHistoryCsv(files.history);
  const economics = EconomicsSchema.safeParse(files.economics);
  const feedback = files.feedback === null ? null : parseFeedbackCsv(files.feedback);
  if (!history.ok || !economics.success || (feedback && !feedback.ok)) {
    return { ok: false, errors: [
      ...(history.ok ? [] : tag("history", history.errors)),
      ...(economics.success ? [] : tag("economics", economicsErrors(economics.error))),
      ...(feedback && !feedback.ok ? tag("feedback", feedback.errors) : []),
    ] };
  }
  let reasonCounts: ReasonCounts | undefined;
  let classifierNotes: string[] = [];
  if (feedback) {
    const classified = await post(fetcher, "/api/import/classify", { rows: feedback.rows });
    if (!classified.ok) return { ok: false, errors: serverErrors("feedback", classified) };
    const data = classification(classified.data);
    if (!data) return failure("feedback", UNEXPECTED_REPLY);
    reasonCounts = data.reasonCounts;
    classifierNotes = data.notes;
  }
  const payload: ImportPayload = { rows: history.rows.map(toTuple), economics: economics.data, ...(reasonCounts ? { reasonCounts } : {}) };
  const validated = await post(fetcher, "/api/import/validate", payload);
  if (!validated.ok) return { ok: false, errors: serverErrors("server", validated) };
  const data = validation(validated.data);
  if (!data) return failure("server", UNEXPECTED_REPLY);
  const { summary, reasonTargeting } = data;
  // Same starter set as the server's `importedStarterStrategies`: an empty cancel-intent save is dropped too.
  const cancelIntentActive = summary.segments.find((s) => s.id === "cancel_intent")?.active;
  const starterStrategies = starterStrategiesFor(summary.listPrice, { reasonTargeting, ...(typeof cancelIntentActive === "number" ? { cancelIntentActive } : {}) });
  return { ok: true, session: { id: nextSessionId++, payload, summary, reasonTargeting, classifierNotes, starterStrategies } };
}

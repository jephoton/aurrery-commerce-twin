import { SEGMENTS, type SegmentId } from "@/twin/types";
import { checkHeader, readCsv } from "./csv";
import { capErrors, type ParseResult, type RowError } from "./row-error";

export const FEEDBACK_COLUMNS = ["segment", "text"] as const;
export const MAX_FEEDBACK_BYTES = 256 * 1024;
export const MAX_FEEDBACK_ROWS = 200;
export const MAX_FEEDBACK_TEXT = 1000;
export interface FeedbackRow { segment: SegmentId; text: string }
export const CONTROL_CHARACTER_MESSAGE = "must not contain control characters other than tab and line breaks";

/** C0 and C1 control characters, except tab, CR and LF (multi-line quoted cells are allowed). */
export function hasControlCharacters(text: string): boolean {
  for (const c of text) {
    const n = c.codePointAt(0)!;
    if ((n < 0x20 && c !== "\t" && c !== "\n" && c !== "\r") || (n >= 0x7f && n < 0xa0)) return true;
  }
  return false;
}

export function parseFeedbackCsv(text: string): ParseResult<FeedbackRow> {
  const file = (message: string): ParseResult<FeedbackRow> => ({ ok: false, errors: [{ row: null, column: null, message }] });
  if (text.length > MAX_FEEDBACK_BYTES || new TextEncoder().encode(text).byteLength > MAX_FEEDBACK_BYTES) return file("feedback file is larger than 256 KiB");
  const csv = readCsv(text);
  if (!csv.ok) return { ok: false, errors: [{ row: csv.line, column: null, message: csv.message }] };
  const [header, ...records] = csv.records;
  if (!header) return file("feedback file is empty");
  const headerErrors = checkHeader(header.fields, FEEDBACK_COLUMNS, header.line);
  if (headerErrors.length) return { ok: false, errors: headerErrors };
  if (records.length === 0) return file("feedback file has no rows");
  if (records.length > MAX_FEEDBACK_ROWS) return file(`at most ${MAX_FEEDBACK_ROWS} feedback rows are allowed (found ${records.length})`);
  const index = new Map(header.fields.map((name, i) => [name, i]));
  const errors: RowError[] = [];
  const rows: FeedbackRow[] = [];
  for (const record of records) {
    if (record.fields.length !== FEEDBACK_COLUMNS.length) {
      errors.push({ row: record.line, column: null, message: `expected ${FEEDBACK_COLUMNS.length} columns, found ${record.fields.length}` });
      continue;
    }
    const segment = record.fields[index.get("segment")!];
    const body = record.fields[index.get("text")!].trim();
    const length = [...body].length;
    let valid = true;
    if (!(SEGMENTS as readonly string[]).includes(segment)) { errors.push({ row: record.line, column: "segment", message: `must be one of ${SEGMENTS.join(", ")}` }); valid = false; }
    if (length < 1 || length > MAX_FEEDBACK_TEXT) {
      errors.push({ row: record.line, column: "text", message: `must be 1–${MAX_FEEDBACK_TEXT.toLocaleString("en-US")} characters after trimming (found ${length})` });
      valid = false;
    } else if (hasControlCharacters(body)) {
      errors.push({ row: record.line, column: "text", message: CONTROL_CHARACTER_MESSAGE });
      valid = false;
    }
    if (valid) rows.push({ segment: segment as SegmentId, text: body });
  }
  return errors.length ? { ok: false, errors: capErrors(errors) } : { ok: true, rows };
}

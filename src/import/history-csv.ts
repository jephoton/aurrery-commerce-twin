import { SEGMENTS, type SegmentId } from "@/twin/types";
import { checkHeader, readCsv } from "./csv";
import { capErrors, type ParseResult, type RowError } from "./row-error";

// History CSV: one row per month × segment. `active_start` counts subscribers at the start of the
// month BEFORE that month's signups; `new_signups` join `new` at the start of their month and can
// cancel or graduate in the same month (as in Ridgeline's generator).

export const COUNT_COLUMNS = [
  "active_start", "voluntary_cancels", "involuntary_cancels",
  "moved_to_core", "moved_to_price_sensitive", "moved_to_at_risk", "moved_to_cancel_intent",
  "new_signups",
] as const;
export type CountColumn = (typeof COUNT_COLUMNS)[number];
export const HISTORY_COLUMNS = ["month", "segment", ...COUNT_COLUMNS] as const;
export type HistoryColumn = (typeof HISTORY_COLUMNS)[number];
export type HistoryRow = { month: string; segment: SegmentId } & Record<CountColumn, number>;

export const MAX_HISTORY_BYTES = 256 * 1024;
export const MAX_HISTORY_ROWS = 300;
export const MIN_HISTORY_MONTHS = 6;
export const MAX_HISTORY_MONTHS = 60;
/** The spec's bound on `active_start`; also the safety bound on every other count. */
export const MAX_COUNT = 10_000_000;

type MoveTarget = "core" | "price_sensitive" | "at_risk" | "cancel_intent";
export const MOVE_COLUMNS: Record<MoveTarget, CountColumn> = {
  core: "moved_to_core", price_sensitive: "moved_to_price_sensitive", at_risk: "moved_to_at_risk", cancel_intent: "moved_to_cancel_intent",
};
/** The segment moves the twin models; any other non-zero move is rejected. */
export const SUPPORTED_MOVES: Record<SegmentId, readonly MoveTarget[]> = {
  new: ["core", "price_sensitive"],
  core: ["at_risk"],
  price_sensitive: ["at_risk"],
  at_risk: ["core", "cancel_intent"],
  cancel_intent: ["at_risk"],
};
/** A `YYYY-MM` month. Shared with the import payload schema. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Non-negative integer without leading zeros. */
const INTEGER = /^(0|[1-9]\d*)$/;

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function parseHistoryCsv(text: string): ParseResult<HistoryRow> {
  const file = (message: string): ParseResult<HistoryRow> => ({ ok: false, errors: [{ row: null, column: null, message }] });
  if (text.length > MAX_HISTORY_BYTES || new TextEncoder().encode(text).byteLength > MAX_HISTORY_BYTES) return file("history file is larger than 256 KiB");
  const csv = readCsv(text);
  if (!csv.ok) return { ok: false, errors: [{ row: csv.line, column: null, message: csv.message }] };
  const [header, ...records] = csv.records;
  if (!header) return file("history file is empty");
  const headerErrors = checkHeader(header.fields, HISTORY_COLUMNS, header.line);
  if (headerErrors.length) return { ok: false, errors: headerErrors };
  if (records.length > MAX_HISTORY_ROWS) return file(`at most ${MAX_HISTORY_ROWS} history rows are allowed (found ${records.length})`);
  const index = new Map(header.fields.map((name, i) => [name, i]));
  const errors: RowError[] = [];
  const rows: HistoryRow[] = [];
  const lines: number[] = [];
  for (const record of records) {
    if (record.fields.length !== HISTORY_COLUMNS.length) {
      errors.push({ row: record.line, column: null, message: `expected ${HISTORY_COLUMNS.length} columns, found ${record.fields.length}` });
      continue;
    }
    const cell = (column: HistoryColumn) => record.fields[index.get(column)!];
    let valid = true;
    const month = cell("month");
    if (!MONTH_PATTERN.test(month)) { errors.push({ row: record.line, column: "month", message: "must be YYYY-MM" }); valid = false; }
    const segment = cell("segment");
    if (!(SEGMENTS as readonly string[]).includes(segment)) { errors.push({ row: record.line, column: "segment", message: `must be one of ${SEGMENTS.join(", ")}` }); valid = false; }
    const counts = {} as Record<CountColumn, number>;
    for (const column of COUNT_COLUMNS) {
      const raw = cell(column);
      if (!INTEGER.test(raw)) { errors.push({ row: record.line, column, message: "must be a non-negative integer" }); valid = false; continue; }
      const value = Number(raw);
      if (value > MAX_COUNT) { errors.push({ row: record.line, column, message: `must be at most ${MAX_COUNT.toLocaleString("en-US")}` }); valid = false; continue; }
      counts[column] = value;
    }
    if (valid) { rows.push({ month, segment: segment as SegmentId, ...counts }); lines.push(record.line); }
  }
  if (errors.length) return { ok: false, errors: capErrors(errors) };
  const semantic = validateHistoryRows(rows, (i) => lines[i]);
  return semantic.length ? { ok: false, errors: capErrors(semantic) } : { ok: true, rows };
}

/**
 * Cross-row rules, shared by the client parse and the server's re-validation of the payload.
 * Assumes every cell already passed the schema (month format, segment, bounded integers); never call it on
 * unparsed input.
 * `rowNumber` maps a row index to its CSV row; the server's default is index + 2 (header = row 1).
 */
export function validateHistoryRows(rows: HistoryRow[], rowNumber: (index: number) => number = (i) => i + 2): RowError[] {
  if (rows.length > MAX_HISTORY_ROWS) return [{ row: null, column: null, message: `at most ${MAX_HISTORY_ROWS} history rows are allowed (found ${rows.length})` }];
  const errors: RowError[] = [];
  const firstOfKey = new Map<string, number>();
  const firstOfMonth = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = rowNumber(i);
    for (const [to, column] of Object.entries(MOVE_COLUMNS) as [MoveTarget, CountColumn][]) {
      if (r[column] === 0) continue;
      if (to === r.segment) errors.push({ row, column, message: "a segment cannot move to itself; must be 0" });
      else if (!SUPPORTED_MOVES[r.segment].includes(to)) errors.push({ row, column, message: `unsupported move ${r.segment} → ${to}` });
    }
    const out = r.voluntary_cancels + r.involuntary_cancels + Object.values(MOVE_COLUMNS).reduce((sum, column) => sum + r[column], 0);
    const isNew = r.segment === "new";
    if (out > r.active_start + (isNew ? r.new_signups : 0)) {
      errors.push({ row, column: "voluntary_cancels", message: `voluntary + involuntary cancels + moves exceed ${isNew ? "active_start + new_signups" : "active_start"}` });
    }
    const key = `${r.month}|${r.segment}`;
    const first = firstOfKey.get(key);
    if (first !== undefined) errors.push({ row, column: "segment", message: `duplicate row for ${r.month} ${r.segment} (first at row ${rowNumber(first)})` });
    else firstOfKey.set(key, i);
    const monthStart = firstOfMonth.get(r.month);
    if (monthStart === undefined) firstOfMonth.set(r.month, i);
    else if (rows[monthStart].new_signups !== r.new_signups) {
      errors.push({ row, column: "new_signups", message: `must equal row ${rowNumber(monthStart)} (${rows[monthStart].new_signups}) for ${r.month}` });
    }
  });
  const months = [...firstOfMonth.keys()].sort();
  for (const month of months) {
    const missing = SEGMENTS.filter((s) => !firstOfKey.has(`${month}|${s}`));
    if (missing.length) errors.push({ row: rowNumber(firstOfMonth.get(month)!), column: "segment", message: `${month} is missing ${missing.join(", ")}; every month needs one row per segment` });
  }
  for (let i = 1; i < months.length; i++) {
    const expected = nextMonth(months[i - 1]);
    if (months[i] !== expected) errors.push({ row: rowNumber(firstOfMonth.get(months[i])!), column: "month", message: `gap: ${expected} is missing before ${months[i]}` });
  }
  const lastMonth = months[months.length - 1];
  // The twin's starting actives come from the last month, so it needs subscribers to start from.
  if (lastMonth !== undefined && rows.every((r) => r.month !== lastMonth || r.active_start === 0)) {
    errors.push({ row: null, column: "active_start", message: `${lastMonth} has no active subscribers (active_start is 0 in every segment); the twin starts from the last month` });
  }
  if (months.length < MIN_HISTORY_MONTHS) errors.push({ row: null, column: "month", message: `at least ${MIN_HISTORY_MONTHS} consecutive months are required (found ${months.length})` });
  if (months.length > MAX_HISTORY_MONTHS) errors.push({ row: null, column: "month", message: `at most ${MAX_HISTORY_MONTHS} months are allowed (found ${months.length})` });
  return errors;
}

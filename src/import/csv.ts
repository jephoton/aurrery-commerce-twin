import type { RowError } from "./row-error";

// Minimal CSV reader for merchant uploads: comma-separated, double-quoted fields with "" escapes,
// CRLF, LF or CR line endings, UTF-8 BOM stripped. Unquoted fields are trimmed; blank lines are
// skipped. No dependency: the toolchain has no CSV parser.

export interface CsvRecord { line: number; fields: string[] }
export type CsvResult = { ok: true; records: CsvRecord[] } | { ok: false; line: number; message: string };

export function readCsv(text: string): CsvResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let recordLine = 1;
  const endField = () => { fields.push(wasQuoted ? field : field.trim()); field = ""; wasQuoted = false; };
  const endRecord = () => {
    endField();
    if (!(fields.length === 1 && fields[0] === "")) records.push({ line: recordLine, fields });
    fields = [];
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (wasQuoted || field.trim() !== "") return { ok: false, line, message: "a quote may only start a field" };
      field = "";
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || (c === "\r" && input[i + 1] !== "\n")) {
      endRecord();
      line++;
      recordLine = line;
    } else if (c === "\r") {
      // The LF of this CRLF ends the record.
    } else if (wasQuoted) {
      if (c.trim() !== "") return { ok: false, line, message: "unexpected text after a closing quote" };
    } else {
      field += c;
    }
  }
  if (quoted) return { ok: false, line: recordLine, message: "unterminated quoted field" };
  if (field !== "" || fields.length > 0 || wasQuoted) endRecord();
  return { ok: true, records };
}

/** Column names must match exactly; order is free; no duplicates or extras. */
export function checkHeader(fields: string[], expected: readonly string[], line: number): RowError[] {
  const errors: RowError[] = [];
  const seen = new Set<string>();
  for (const name of fields) {
    if (!expected.includes(name)) errors.push({ row: line, column: name || "(blank)", message: "unknown column" });
    else if (seen.has(name)) errors.push({ row: line, column: name, message: "duplicate column" });
    seen.add(name);
  }
  for (const name of expected) if (!seen.has(name)) errors.push({ row: line, column: name, message: "missing column" });
  return errors;
}

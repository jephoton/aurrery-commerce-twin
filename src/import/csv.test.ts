import { describe, expect, it } from "vitest";
import { checkHeader, readCsv } from "./csv";
import { capErrors, formatRowError, MAX_REPORTED_ERRORS } from "./row-error";

describe("readCsv", () => {
  it("reads LF and CRLF records with trimmed unquoted fields", () => {
    expect(readCsv("a, b\n1 ,2\n")).toEqual({ ok: true, records: [{ line: 1, fields: ["a", "b"] }, { line: 2, fields: ["1", "2"] }] });
    expect(readCsv("a,b\r\n1,2\r\n")).toEqual(readCsv("a,b\n1,2\n"));
  });
  it("strips a UTF-8 byte order mark", () => {
    expect(readCsv("\uFEFFa,b\n1,2")).toEqual({ ok: true, records: [{ line: 1, fields: ["a", "b"] }, { line: 2, fields: ["1", "2"] }] });
  });
  it("keeps commas, doubled quotes and newlines inside quoted fields", () => {
    expect(readCsv('segment,text\ncore,"Too pricey, honestly ""meh""\nsecond line"\nnew,ok\n')).toEqual({ ok: true, records: [
      { line: 1, fields: ["segment", "text"] },
      { line: 2, fields: ["core", 'Too pricey, honestly "meh"\nsecond line'] },
      { line: 4, fields: ["new", "ok"] },
    ] });
  });
  it("skips blank lines but keeps physical line numbers", () => {
    expect(readCsv("a\n\n  \nb\n")).toEqual({ ok: true, records: [{ line: 1, fields: ["a"] }, { line: 4, fields: ["b"] }] });
  });
  it("rejects an unterminated quote and stray quotes with the line number", () => {
    expect(readCsv('a,b\n1,"open\n')).toEqual({ ok: false, line: 2, message: "unterminated quoted field" });
    expect(readCsv('a,b\n1,x"y\n')).toEqual({ ok: false, line: 2, message: "a quote may only start a field" });
    expect(readCsv('a,b\n1,"x"y\n')).toEqual({ ok: false, line: 2, message: "unexpected text after a closing quote" });
  });
});

describe("checkHeader", () => {
  const expected = ["segment", "text"] as const;
  it("accepts the exact names in any order", () => {
    expect(checkHeader(["text", "segment"], expected, 1)).toEqual([]);
  });
  it("reports duplicate, unknown and missing columns", () => {
    expect(checkHeader(["segment", "segment", "notes"], expected, 1)).toEqual([
      { row: 1, column: "segment", message: "duplicate column" },
      { row: 1, column: "notes", message: "unknown column" },
      { row: 1, column: "text", message: "missing column" },
    ]);
  });
});

describe("row errors", () => {
  it("formats row, column and file-level errors", () => {
    expect(formatRowError({ row: 14, column: "voluntary_cancels", message: "too many" })).toBe("row 14, voluntary_cancels: too many");
    expect(formatRowError({ row: null, column: "month", message: "too few months" })).toBe("month: too few months");
    expect(formatRowError({ row: null, column: null, message: "file too large" })).toBe("file too large");
  });
  it("caps long error lists with a count of the rest", () => {
    const errors = Array.from({ length: MAX_REPORTED_ERRORS + 3 }, (_, i) => ({ row: i + 2, column: null, message: "bad" }));
    const capped = capErrors(errors);
    expect(capped).toHaveLength(MAX_REPORTED_ERRORS + 1);
    expect(capped.at(-1)).toEqual({ row: null, column: null, message: "3 more errors not shown" });
  });
});

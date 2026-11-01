import { expect, it } from "vitest";
import { hasControlCharacters, parseFeedbackCsv } from "./feedback-csv";
import { formatRowError } from "./row-error";

const messages = (text: string) => {
  const result = parseFeedbackCsv(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map(formatRowError);
};

it("parses quoted text with commas and trims it", () => {
  expect(parseFeedbackCsv('text,segment\n"  Too pricey, sorry  ",at_risk\nMoving abroad,core\n')).toEqual({ ok: true, rows: [
    { segment: "at_risk", text: "Too pricey, sorry" },
    { segment: "core", text: "Moving abroad" },
  ] });
});
it("reports bad segments and empty or long text per row", () => {
  expect(messages(`segment,text\nvip,hello\ncore,\ncore,"${"x".repeat(1001)}"\n`)).toEqual([
    "row 2, segment: must be one of new, core, price_sensitive, at_risk, cancel_intent",
    "row 3, text: must be 1–1,000 characters after trimming (found 0)",
    "row 4, text: must be 1–1,000 characters after trimming (found 1001)",
  ]);
});
it("keeps tabs and line breaks but rejects other control characters", () => {
  expect(parseFeedbackCsv('segment,text\ncore,"line one\nline\ttwo"\n').ok).toBe(true);
  expect(messages("segment,text\ncore,bell\u0007here\n")).toEqual(["row 2, text: must not contain control characters other than tab and line breaks"]);
  expect(hasControlCharacters("a\u0085b")).toBe(true);
  expect(hasControlCharacters("tab\tCR\rLF\n")).toBe(false);
});
it("caps rows at 200 and files at 256 KiB, and needs the exact header", () => {
  expect(messages(`segment,text\n${"core,ok\n".repeat(201)}`)).toEqual(["at most 200 feedback rows are allowed (found 201)"]);
  expect(messages("x".repeat(256 * 1024 + 1))).toEqual(["feedback file is larger than 256 KiB"]);
  expect(messages("segment,comment\ncore,ok\n")).toEqual(["row 1, comment: unknown column", "row 1, text: missing column"]);
  expect(messages("segment,text\n")).toEqual(["feedback file has no rows"]);
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { betaMean, betaSd } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";
import { samplePayload } from "@/test/import-fixture";
import { parseFeedbackCsv } from "./feedback-csv";
import { parseHistoryCsv } from "./history-csv";
import { buildImportedTwin } from "./imported-twin";
import { formatRowError } from "./row-error";
import { SAMPLE_FILES } from "./sample-files";
import { SAMPLE_FEEDBACK, SAMPLE_REASON_COUNTS, SAMPLE_TRUTH, sampleMerchantFiles } from "./sample-merchant";

const files = sampleMerchantFiles();

it("commits exactly what the generator produces", () => {
  for (const key of Object.keys(SAMPLE_FILES) as (keyof typeof SAMPLE_FILES)[]) {
    expect(readFileSync(join(process.cwd(), "public", SAMPLE_FILES[key]), "utf8")).toBe(files[key]);
  }
});
it("is a valid 12-month history and a valid 40-row feedback file", () => {
  const history = parseHistoryCsv(files.history);
  expect(history.ok && history.rows.length).toBe(60);
  const feedback = parseFeedbackCsv(files.feedback);
  expect(feedback.ok && feedback.rows.length).toBe(40);
});
it("labels its feedback with the intended counts per segment", () => {
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, { price: 0, other: 0 }]));
  for (const f of SAMPLE_FEEDBACK) counts[f.segment][f.reason]++;
  expect(counts).toEqual(SAMPLE_REASON_COUNTS);
});
it("re-estimates churn close to its generating rates", () => {
  const built = buildImportedTwin(samplePayload());
  if (!built.ok) throw new Error("sample must build");
  for (const s of SEGMENTS) {
    const d = built.twin.params.segments[s].monthlyChurn;
    expect(Math.abs(betaMean(d) - SAMPLE_TRUTH.churn[s])).toBeLessThan(4 * betaSd(d) + 0.002);
  }
});
it("ships a template of the header plus one example month", () => {
  const lines = files.template.trim().split("\n");
  expect(lines).toHaveLength(6);
  const result = parseHistoryCsv(files.template);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.map(formatRowError)).toEqual(["month: at least 6 consecutive months are required (found 1)"]);
});

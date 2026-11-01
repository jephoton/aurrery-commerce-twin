import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { historyCsv, historyRowsFromTwin, toCsv } from "./csv-write";
import { DEFAULT_ECONOMICS } from "./economics";
import { parseHistoryCsv } from "./history-csv";
import { toTuple } from "./import-payload";
import { buildImportedTwin, IMPORTED_MERCHANT_ID, importedStarterStrategies, usesReasonTargeting } from "./imported-twin";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { formatRowError } from "./row-error";

const demo = buildDemoTwin();
const rows = historyRowsFromTwin(demo.history);
const payload = () => ({ rows: rows.map(toTuple), economics: { ...DEFAULT_ECONOMICS } });
const zero = { price: 0, other: 0 };

it("re-estimates Ridgeline exactly from its own history exported as CSV rows", () => {
  const built = buildImportedTwin(payload());
  if (!built.ok) throw new Error(built.errors.map(formatRowError).join("; "));
  expect(built.twin.params).toEqual(demo.twin.params);
  expect(built.twin.initialActive).toEqual(demo.twin.initialActive);
  expect(built.twin.merchant).toMatchObject({ id: IMPORTED_MERCHANT_ID, name: "Your merchant", planName: "Monthly plan" });
  expect(built).toMatchObject({ months: 18, firstMonth: "2025-04", lastMonth: "2026-09", reasonTargeting: false, feedbackRows: 0 });
  expect(built.twin.asOfMonth).toBe("2026-09");
  expect(built.twin.provenance.monthlyChurn.note).toContain("estimated from your CSV (18 months)");
});
it("does not depend on row order", () => {
  const shuffled = { ...payload(), rows: [...payload().rows].reverse() };
  const a = buildImportedTwin(payload()), b = buildImportedTwin(shuffled);
  expect(a.ok && b.ok && b.twin).toEqual(a.ok && a.twin);
});
it("returns per-row errors and no twin for an invalid history", () => {
  const broken = payload();
  broken.rows[12][3] = 999_999;
  const built = buildImportedTwin(broken);
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
});
it("enables reason targeting only when classified feedback exists", () => {
  const none = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: zero } });
  expect(none.ok && none.reasonTargeting).toBe(false);
  const some = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: { price: 4, other: 1 } } });
  expect(some.ok && [some.reasonTargeting, some.feedbackRows, some.twin.params.segments.cancel_intent.priceReasonShare]).toEqual([true, 5, { alpha: 10, beta: 5 }]);
});
it("writes CSV that parses back to the same rows", () => {
  const parsed = parseHistoryCsv(historyCsv(rows));
  expect(parsed.ok && parsed.rows).toEqual(rows);
});
it("quotes CSV fields that need it", () => {
  expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], [" pad", 3]])).toBe('a,b\n"x,y","say ""hi"""\n" pad",3\n');
});
it("recognises price-reason strategies", () => {
  expect(usesReasonTargeting({ id: "a", name: "a", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } })).toBe(true);
  expect(usesReasonTargeting({ id: "b", name: "b", intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 6 } })).toBe(false);
});
it("turns a builder RangeError into a file-level error instead of throwing", () => {
  // Bypasses the payload schema on purpose: the builder is the backstop for malformed reason counts.
  const built = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: { price: 1.5, other: 0 } } });
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.errors).toEqual([{ row: null, column: null, message: "Reason counts for cancel_intent must be non-negative integers." }]);
});
it("rejects an all-zero history without building a twin", () => {
  const empty = payload();
  for (const t of empty.rows) for (let i = 2; i < t.length; i++) t[i] = 0;
  const built = buildImportedTwin(empty);
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.errors.map(formatRowError)).toEqual(["active_start: 2026-09 has no active subscribers (active_start is 0 in every segment); the twin starts from the last month"]);
});
it("builds an import's starters from its list price, feedback and starting cancel-intent actives", () => {
  const built = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: { price: 3, other: 1 }, cancel_intent: zero } });
  if (!built.ok) throw new Error("must build");
  expect(importedStarterStrategies(built)).toEqual(STARTER_STRATEGIES);
  const plain = buildImportedTwin(payload());
  if (!plain.ok) throw new Error("must build");
  expect(importedStarterStrategies(plain).map((s) => s.id)).not.toContain("cancel-price-25-3m");
  const empty = { ...built, twin: { ...built.twin, initialActive: { ...built.twin.initialActive, cancel_intent: 2 } } };
  expect(importedStarterStrategies(empty).map((s) => s.id)).not.toContain("cancel-price-25-3m");
});

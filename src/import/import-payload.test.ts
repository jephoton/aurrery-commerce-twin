import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { historyRowsFromTwin } from "./csv-write";
import { DEFAULT_ECONOMICS } from "./economics";
import { fromTuple, ImportPayloadSchema, payloadIssues, toTuple, type HistoryTuple } from "./import-payload";

const rows = historyRowsFromTwin(buildDemoTwin().history);
const payload = { rows: rows.map(toTuple), economics: DEFAULT_ECONOMICS };

it("round-trips rows through compact tuples", () => {
  expect(rows.map(toTuple).map(fromTuple)).toEqual(rows);
  expect(ImportPayloadSchema.parse(payload)).toEqual(payload);
});
it("is strict and bounded", () => {
  const bad = (change: (t: HistoryTuple[]) => unknown[]) => ImportPayloadSchema.safeParse({ ...payload, rows: change(structuredClone(payload.rows)) }).success;
  expect(ImportPayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  expect(bad((t) => { t[0][2] = -1; return t; })).toBe(false);
  expect(bad((t) => { t[0][2] = 1.5; return t; })).toBe(false);
  expect(bad((t) => { t[0][2] = 10_000_001; return t; })).toBe(false);
  expect(bad((t) => { t[0][0] = "2026-13"; return t; })).toBe(false);
  expect(bad((t) => { (t[0] as unknown[])[1] = "vip"; return t; })).toBe(false);
  expect(bad((t) => { (t[0] as unknown[]).push(0); return t; })).toBe(false);
  expect(bad((t) => t.slice(0, 29))).toBe(false);
  expect(bad((t) => [...t, ...t, ...t, ...t].slice(0, 301))).toBe(false);
  const zero = { price: 0, other: 0 };
  expect(ImportPayloadSchema.safeParse({ ...payload, reasonCounts: { new: { price: 150, other: 51 }, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: zero } }).success).toBe(false);
  expect(ImportPayloadSchema.safeParse({ ...payload, reasonCounts: { new: { price: 150, other: 50 }, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: zero } }).success).toBe(true);
});
it("keeps the largest legal payload well under the 64 KiB request cap", () => {
  const big: HistoryTuple = ["2026-09", "price_sensitive", 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999];
  expect(new TextEncoder().encode(JSON.stringify({ rows: Array(300).fill(big), economics: DEFAULT_ECONOMICS })).byteLength).toBeLessThan(40 * 1024);
});

it("maps schema issues to CSV rows and columns", () => {
  const rows = structuredClone(payload.rows);
  rows[12][3] = -1;
  const parsed = ImportPayloadSchema.safeParse({ ...payload, rows, economics: { ...DEFAULT_ECONOMICS, merchantName: "" } });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(payloadIssues(parsed.error).map(({ row, column }) => ({ row, column }))).toEqual([
    { row: 14, column: "voluntary_cancels" },
    { row: null, column: "economics.merchantName" },
  ]);
});
it("never echoes unexpected field names", () => {
  const secret = "customer-email@example.com";
  const parsed = ImportPayloadSchema.safeParse({ ...payload, [secret]: 1, economics: { ...DEFAULT_ECONOMICS, [secret]: 2 } });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const issues = payloadIssues(parsed.error);
  expect(issues).toHaveLength(2);
  expect(issues).toEqual(expect.arrayContaining([
    { row: null, column: null, message: "unexpected field" },
    { row: null, column: "economics", message: "unexpected field" },
  ]));
  expect(JSON.stringify(issues)).not.toContain(secret);
});

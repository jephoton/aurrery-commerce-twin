import { expect, it } from "vitest";
import type { StrategyResult } from "@/twin/simulate";
import { comparisonRows, intervalDomain, intervalGeometry, shouldSelectRow } from "./comparison-model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntervalCell } from "./IntervalCell";

const result = (id: string, kind: "baseline" | "targeted_discount" | "annual_plan" | "list_price_change", p10 = -5, p50 = 2, p90 = 10) => ({
  strategy: { id, name: `Any name ${id}`, intervention: { kind } },
  vsBaseline: { totalValue: { p10, p50, p90 }, grossProfit: { p50: 3 }, endingActive: { mean: 4 } },
  metrics: { endingActive: { p50: 20 }, discountCost: { mean: 5 } },
  probValueBelowBaseline: 0.2,
  paypalAction: null,
}) as StrategyResult;

it("groups by intervention kind and holds exactly one baseline outside candidates", () => {
  const data = [result("x", "targeted_discount"), result("a", "annual_plan"), result("p", "list_price_change"), result("b", "baseline")];
  const { candidates, baseline } = comparisonRows(data, "b");
  expect(candidates.map((r) => r.family)).toEqual(["Retention", "Annual", "Pricing"]);
  expect(baseline?.family).toBe("Baseline");
  expect(candidates).toHaveLength(3);
  expect(() => comparisonRows([...data, result("b2", "baseline")], "b")).toThrow(/one baseline/);
});

it("uses one zero inclusive interval domain across every family", () => {
  const data = comparisonRows([result("b", "baseline", 0, 0, 0), result("x", "targeted_discount", -20, -10, -5), result("p", "list_price_change", 2, 8, 40)], "b");
  expect(intervalDomain(data.candidates)).toEqual([-20, 40]);
  expect(intervalGeometry(-20, -10, -5, [-20, 40])).toEqual({ start: 0, median: 1 / 6, end: 1 / 4, zero: 1 / 3 });
  expect(intervalDomain([{ deltaValueP10: -9, deltaValueP90: -1 }])).toEqual([-9, 0]);
  expect(Object.values(intervalGeometry(0, 0, 0, [0, 0])).every(Number.isFinite)).toBe(true);
});

it("only forwards a newly selected, eligible candidate row", () => {
  const row = comparisonRows([result("b", "baseline"), result("x", "targeted_discount")], "b").candidates[0];
  expect(shouldSelectRow(row, true, false, "b", false)).toBe(true);
  expect(shouldSelectRow(row, false, false, null, false)).toBe(false);
  expect(shouldSelectRow(row, true, false, "x", false)).toBe(false);
  expect(shouldSelectRow(row, true, true, null, false)).toBe(false);
  expect(shouldSelectRow(row, true, false, null, true)).toBe(false);
});

it("exposes numeric p10, median and p90 values with the shared interval graphic", () => {
  const html = renderToStaticMarkup(createElement(IntervalCell, { p10: -5, p50: 2, p90: 10, domain: [-20, 40] }));
  expect(html).toContain("p10 −$5");
  expect(html).toContain("median +$2");
  expect(html).toContain("p90 +$10");
  expect(html).toContain("80% interval");
  expect(html).toContain("<svg");
});

import { expect, it } from "vitest";
import { betaMean } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";
import { buildDemoTwin } from "./demo";
import { summarizeMerchant } from "./summary";

it("builds exactly the summary the page built before (Ridgeline)", () => {
  const { twin, history } = buildDemoTwin();
  const lastMonth = history.segments.at(-1)!.month;
  const recent = history.segments.filter((r) => r.month === lastMonth);
  const active = SEGMENTS.reduce((s, seg) => s + twin.initialActive[seg], 0);
  const observed = { observedEvidence: undefined, parameterChanges: [], annualEvidence: undefined };
  expect(summarizeMerchant(twin, history, observed)).toEqual({
    name: twin.merchant.name, description: twin.merchant.description, planName: twin.merchant.planName, asOfMonth: twin.asOfMonth,
    listPrice: twin.params.listPrice, active, mrr: active * twin.params.listPrice,
    lastMonthChurnRate: recent.reduce((s, r) => s + r.voluntaryChurn + r.involuntaryChurn, 0) / recent.reduce((s, r) => s + r.activeAtStart, 0),
    segments: SEGMENTS.map((s) => ({ id: s, label: twin.params.segments[s].label, active: twin.initialActive[s], churn: betaMean(twin.params.segments[s].monthlyChurn) })),
    provenance: twin.provenance, ...observed,
  });
});
it("carries imported details", () => {
  const { twin, history } = buildDemoTwin();
  const imported = { months: 18, firstMonth: "2025-04", lastMonth: "2026-09", feedbackRows: 0 };
  const summary = summarizeMerchant(twin, history, { imported });
  expect(summary.imported).toEqual(imported);
  expect(summary).not.toHaveProperty("observedEvidence");
});

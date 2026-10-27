import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import { EvidencePanel } from "./EvidencePanel";
import { dashboardReducer, emptyDashboard } from "./lab-state";
import { deriveDiscountOutcomes } from "@/ledger/discount-outcomes";
import type { ObservedSnapshot } from "@/merchant/observed-snapshot";

const summary = {
  name: "Demo", description: "", planName: "Monthly", asOfMonth: "2026-10", listPrice: 24,
  active: 100, mrr: 2400, lastMonthChurnRate: .1,
  segments: [{ id: "cancel_intent", label: "Cancel intent", active: 18, churn: .3 }],
  provenance: { "segments.cancel_intent.monthlyChurn": { source: "estimated", note: "Estimated from synthetic history." }, "offerChurnRelativeRisk.price": { source: "assumption", note: "Pilot assumption." } },
} as MerchantSummary;
const evidence = {
  type: "classification",
  summary: { source: "AI-classified synthetic feedback", provider: "gemini", model: "test-model", total: 200, accepted: 200, unclassified: 0 },
  hitmap: { cancel_intent: { price: 21, other: 21 } },
  provenance: summary.provenance,
} as AgentEvent;
const initialSnapshot: ObservedSnapshot = { evidence: deriveDiscountOutcomes([], [], "2026-10-27T00:00:00Z"), changes: [], provenance: summary.provenance };
const render = (source: "agent" | "manual" | null, event: AgentEvent | null) => renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: event?.type === "classification" ? event : null, source, snapshot: source ? initialSnapshot : null }));

it("separates active subscriber population from classified feedback counts", () => {
  const html = render("agent", evidence);
  expect(html).toMatch(/Active subscriber population[\s\S]*?Cancel intent[\s\S]*?18 active/);
  expect(html).toMatch(/Classified feedback sample[\s\S]*?42 feedback records[\s\S]*?21 price[\s\S]*?21 other/);
  expect(html).toContain("AI-classified synthetic feedback");
  expect(html).toContain("estimated");
  expect(html).toContain("assumption");
  expect(html).not.toContain(">observed<");
});

it("uses canonical synthetic provenance for a manual comparison", () => {
  const html = render("manual", evidence);
  expect(html).toContain("Canonical synthetic twin");
  expect(html).not.toContain("42 feedback records");
  expect(html).toContain("Estimated from synthetic history.");
});
it("separates measured exposure, ambiguous cancellations, posterior exclusions and parameter changes", () => {
  const snapshot: ObservedSnapshot = { evidence: { episodes: 2, cancellations: 1, censoredEpisodes: 1, subscriberMonths: .75, posteriorSubscriberMonths: .5, posteriorCancellations: 0, limitation: "Observational only; no causal retention claim." }, changes: [{ parameter: "offerChurnRelativeRisk.price", before: { mean: .45, sd: .15 }, after: { mean: .44, sd: .14 }, evidence: "0 cancellation(s) in 0.5 months" }], provenance: summary.provenance };
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot }));
  expect(html).toContain("Measured sandbox outcomes");
  expect(html).toContain("0.750");
  expect(html).toContain("0.500");
  expect(html).toContain("1 ambiguous cancellation");
  expect(html).toContain("0 qualified posterior cancellations");
  expect(html).toContain("offerChurnRelativeRisk.price");
  expect(html).toContain("no causal retention claim");
});
it("does not reuse page-load evidence when the comparison has no run snapshot", () => {
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...summary, observedEvidence: deriveDiscountOutcomes([], [], "2026-10-27T00:00:00Z"), parameterChanges: [] }, evidence: null, source: "manual" }));
  expect(html).toContain("snapshot unavailable for this run");
  expect(html).not.toContain("No measured effect parameter changes");
  expect(html).not.toContain("Pilot assumption.");
});
it.each(["manual", "agent"] as const)("uses the %s run snapshot when page-load evidence had no measured effects", source => {
  const fresh: ObservedSnapshot = { evidence: { ...deriveDiscountOutcomes([], [], "2026-10-27T00:00:00Z"), episodes: 1, subscriberMonths: .5, posteriorSubscriberMonths: .5 }, changes: [{ parameter: "offerChurnRelativeRisk.price", before: { mean: .45, sd: .15 }, after: { mean: .44, sd: .14 }, evidence: "Fresh run measured effect" }], provenance: { "offerChurnRelativeRisk.price": { source: "observed", note: "Fresh run measured effect", evidenceCount: .5 } } };
  let state = emptyDashboard;
  if (source === "agent") state = dashboardReducer(state, { type: "event", event: { type: "observed_snapshot", snapshot: fresh } });
  else state = dashboardReducer(state, { type: "comparison", comparison: { strategies: [], baselineId: "baseline", merchantId: "fixture", options: { runs: 1, horizonMonths: 1, seed: 0 } }, source, observedSnapshot: fresh });
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...summary, observedEvidence: deriveDiscountOutcomes([], [], "2026-10-27T00:00:00Z"), parameterChanges: [] }, evidence: null, source, snapshot: state.observedSnapshot }));
  expect(html).toContain("Fresh run measured effect");
  expect(html).toContain("0.500");
  expect(html).toContain(">observed<");
  expect(html).not.toContain("No measured effect parameter changes");
  expect(html).not.toContain("page load");
  expect(dashboardReducer(state, { type: "reset" }).observedSnapshot).toBeNull();
});

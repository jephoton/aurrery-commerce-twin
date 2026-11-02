import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import { EvidencePanel } from "./EvidencePanel";
import { dashboardReducer, emptyDashboard } from "./lab-state";
import { deriveDiscountOutcomes } from "@/ledger/discount-outcomes";
import type { ObservedSnapshot } from "@/merchant/observed-snapshot";
import type { LiveAnnual } from "./lab-state";

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

const annualFixture = (accepted: number) => ({
  offers: [{ segment: "core" as const, accepted, declined: 0, unresolved: 1 - accepted }],
  changes: accepted ? [{ parameter: "segments.core.annualUptake", before: { mean: .05, sd: .03 }, after: { mean: .0732, sd: .04 }, evidence: "1 accepted, 0 confirmed declined (1 resolved annual offer(s))" }] : [],
  limitation: "Customers chose whether to switch, so this is not a randomized uptake estimate.",
});

it("keeps annual offer evidence in its own block with its own limitation", () => {
  const snapshot: ObservedSnapshot = { ...initialSnapshot, annual: annualFixture(1) };
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot }));
  expect(html).toContain("Annual offers");
  expect(html).toContain("1 accepted · 0 declined · 0 awaiting decision or final check");
  expect(html).toContain("core: 1 accepted");
  expect(html.indexOf("segments.core.annualUptake")).toBeGreaterThan(html.indexOf("Annual offers"));
  expect(html).toContain("not a randomized uptake estimate");
  expect(html).toContain("No measured effect parameter changes");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("href");
  // The annual change is outside the discount block and the discount limitation stays out of the annual block.
  const discountBlock = html.slice(html.indexOf("Measured sandbox outcomes"), html.indexOf("Annual offers"));
  expect(discountBlock).not.toContain("segments.core.annualUptake");
  expect(html.slice(html.indexOf("Annual offers"))).not.toContain(initialSnapshot.evidence.limitation);
  const withoutAnnual = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot: initialSnapshot }));
  expect(withoutAnnual).not.toContain("Annual offers");
});

it("shows page-load annual evidence with no run, and live evidence over it without touching discount evidence", () => {
  const loaded = { ...summary, annualEvidence: annualFixture(0) };
  const before = renderToStaticMarkup(createElement(EvidencePanel, { summary: loaded, evidence: null, source: null }));
  expect(before).toContain("0 accepted · 0 declined · 1 awaiting decision or final check");
  const live: LiveAnnual = { annual: annualFixture(1) };
  const after = renderToStaticMarkup(createElement(EvidencePanel, { summary: loaded, evidence: null, source: null, liveAnnual: live }));
  expect(after).toContain("1 accepted · 0 declined · 0 awaiting decision or final check");
  // A displayed run keeps its own discount evidence while annual evidence follows the refresh.
  const snapshot: ObservedSnapshot = { ...initialSnapshot, annual: annualFixture(0) };
  const run = renderToStaticMarkup(createElement(EvidencePanel, { summary: loaded, evidence: null, source: "manual", snapshot, liveAnnual: live }));
  expect(run).toContain("Evidence snapshot used for this run.");
  expect(run).toContain("1 accepted · 0 declined · 0 awaiting decision or final check");
});

it("counts awaiting offers in the total and per segment, including a two-segment case", () => {
  const mixed = { offers: [{ segment: "core" as const, accepted: 1, declined: 0, unresolved: 1 }], changes: [], limitation: "Annual limitation." };
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot: { ...initialSnapshot, annual: mixed } }));
  expect(html).toContain("1 accepted · 0 declined · 1 awaiting decision or final check");
  expect(html).toContain("core: 1 accepted · 0 declined · 1 awaiting decision or final check");
  const two = { offers: [{ segment: "core" as const, accepted: 1, declined: 0, unresolved: 0 }, { segment: "cancel_intent" as const, accepted: 0, declined: 0, unresolved: 2 }], changes: [], limitation: "Annual limitation." };
  const twoHtml = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: null, liveAnnual: { annual: two } }));
  expect(twoHtml).toContain("1 accepted · 0 declined · 2 awaiting decision or final check");
  expect(twoHtml).toContain("core: 1 accepted · 0 declined · 0 awaiting decision or final check");
  expect(twoHtml).toContain("Cancel intent: 0 accepted · 0 declined · 2 awaiting decision or final check");
});

it("labels live annual evidence, mentions the run snapshot only when a run is displayed, and exposes a labelled live region", () => {
  const live: LiveAnnual = { annual: annualFixture(1) };
  const noRun = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: null, liveAnnual: live }));
  expect(noRun).toContain("Current ledger, updated by the latest PayPal check.");
  expect(noRun).not.toContain("The displayed run used the evidence snapshot above.");
  expect(noRun).toContain('aria-live="polite"');
  // Its own id: the annual offers panel on the same page uses annual-offers-title.
  expect(noRun).toMatch(/<section[^>]*aria-labelledby="annual-evidence-title"/);
  expect(noRun).toContain('id="annual-evidence-title"');
  expect(noRun).not.toContain("annual-offers-title");
  const run = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot: initialSnapshot, liveAnnual: live }));
  expect(run).toContain("Current ledger, updated by the latest PayPal check.");
  expect(run).toContain("The displayed run used the evidence snapshot above.");
  const loaded = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...summary, annualEvidence: annualFixture(0) }, evidence: null, source: null }));
  expect(loaded).not.toContain("Current ledger, updated by the latest PayPal check.");
});

it("shows an imported twin's own provenance and feedback, never Ridgeline's measured or annual evidence", () => {
  const zero = { price: 0, other: 0 };
  const annualEvidence = { offers: [{ segment: "core" as const, accepted: 1, declined: 0, unresolved: 1 }], changes: [], limitation: "Annual limitation." };
  const imported = {
    ...summary, observedEvidence: initialSnapshot.evidence, annualEvidence,
    provenance: { monthlyChurn: { source: "estimated", note: "Beta posterior per segment, estimated from your CSV (12 months)." } },
    imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 5, reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: { price: 4, other: 1 } } },
  } as unknown as MerchantSummary;
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: imported, evidence: null, source: "manual", snapshot: null, liveAnnual: { annual: annualEvidence } }));
  expect(html).toContain("Imported CSV history · 2025-10 to 2026-09 (12 months)");
  expect(html).toContain("AI-classified from 5 uploaded feedback rows");
  expect(html).toMatch(/Cancel intent: 5 feedback rows · 4 price · 1 other/);
  expect(html).toContain("estimated from your CSV (12 months)");
  for (const absent of ["Measured sandbox outcomes", "annual-evidence-title", "snapshot unavailable", "Annual limitation.", "synthetic"]) expect(html).not.toContain(absent);
  const noFeedback = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...imported, imported: { ...imported.imported!, feedbackRows: 0, reasonCounts: undefined } }, evidence: null, source: null, snapshot: null }));
  expect(noFeedback).toContain("No feedback imported");
});

it("treats a segment missing from imported reason counts as zero instead of crashing", () => {
  const imported = { ...summary, segments: [...summary.segments, { id: "core", label: "Core", active: 100, churn: 0.03 }], imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 5, reasonCounts: { cancel_intent: { price: 4, other: 1 } } } } as unknown as MerchantSummary;
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: imported, evidence: null, source: "manual", snapshot: null }));
  expect(html).toMatch(/Core: 0 feedback rows · 0 price · 0 other/);
});

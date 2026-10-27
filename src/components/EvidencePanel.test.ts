import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import { EvidencePanel } from "./EvidencePanel";

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
const render = (source: "agent" | "manual" | null, event: AgentEvent | null) => renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: event?.type === "classification" ? event : null, source }));

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
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...summary, observedEvidence: { episodes: 2, cancellations: 1, censoredEpisodes: 1, subscriberMonths: .75, posteriorSubscriberMonths: .5, posteriorCancellations: 0, observations: [], limitation: "Observational only; no causal retention claim." }, parameterChanges: [{ parameter: "offerChurnRelativeRisk.price", before: { mean: .45, sd: .15 }, after: { mean: .44, sd: .14 }, evidence: "0 cancellation(s) in 0.5 months" }] }, evidence: null, source: "manual" }));
  expect(html).toContain("Measured sandbox outcomes");
  expect(html).toContain("0.750");
  expect(html).toContain("0.500");
  expect(html).toContain("1 ambiguous cancellation");
  expect(html).toContain("0 qualified posterior cancellations");
  expect(html).toContain("offerChurnRelativeRisk.price");
  expect(html).toContain("no causal retention claim");
});

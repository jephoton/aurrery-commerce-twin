import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { compareStrategies } from "@/twin/simulate";
import { buildDemoTwin } from "@/merchant/demo";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import type { Proposal } from "@/ledger/proposals";
import type { AgentEvent } from "@/agent/contracts";
import { DecisionSummary } from "./DecisionSummary";

const result = compareStrategies(buildDemoTwin().twin, STARTER_STRATEGIES, { runs: 2, horizonMonths: 2 }).strategies[1];
const selected = {
  ...result,
  vsBaseline: { ...result.vsBaseline, totalValue: { ...result.vsBaseline.totalValue, mean: 1234, p50: 2345, p10: -456, p90: 3456 } },
  metrics: { ...result.metrics, discountCost: { ...result.metrics.discountCost, mean: 78 } },
  probValueBelowBaseline: .25,
};
const baseProps = { selected, proposal: null, proposalSource: null, rules: null, stress: null, horizonMonths: 12, source: "manual" as const, busy: false };
const render = (props: Parameters<typeof DecisionSummary>[0]) => renderToStaticMarkup(createElement(DecisionSummary, props));

it("labels mean, median, interval, downside risk and cost from distinct typed fields", () => {
  const html = render(baseProps);
  expect(html).toMatch(/Expected value change<\/dt><dd[^>]*>\+\$1,234/);
  expect(html).toMatch(/Median value change<\/dt><dd[^>]*>\+\$2,345/);
  expect(html).toContain("−$456");
  expect(html).toContain("+$3,456");
  expect(html).toContain("25.0%");
  expect(html).toContain("$78");
  expect(html).toContain("12-month");
  expect(html).toContain("Manual scenario");
});

it("starts without a recommendation or fabricated statistics", () => {
  const html = render({ ...baseProps, selected: null, source: null });
  expect(html).toMatch(/<h1 id="decision-title"[^>]*>Simulate before you transact\.<\/h1>/);
  expect(html).toContain("Run the agent or simulate strategies");
  expect(html).not.toContain("Expected value");
  expect(html).not.toContain("Review exact action");
});

it("uses the selected strategy as the page heading after comparison", () => {
  const html = render(baseProps);
  expect(html).toContain(`<h1 id="decision-title"`);
  expect(html).toContain(`${selected.strategy.name}</h1>`);
});

it("links only the currently selected proposed action to review without an approval control", () => {
  const proposal = { strategy: selected.strategy, status: "proposed" } as Proposal;
  const current = render({ ...baseProps, proposal, proposalSource: "agent", source: "agent" });
  expect(current).toContain("Agent proposal");
  expect(current).toContain('href="#approval"');
  expect(current).toContain("Review exact action");
  expect(current).not.toContain("Approve &amp; execute");
  expect(render({ ...baseProps, proposal, proposalSource: "manual" })).toContain("Prepared action");
  expect(render({ ...baseProps, proposal: { ...proposal, strategy: STARTER_STRATEGIES[2] }, source: "agent" })).not.toContain('href="#approval"');
  expect(render({ ...baseProps, proposal: { ...proposal, status: "rejected" }, source: "agent" })).not.toContain('href="#approval"');
});

it("keeps agent-comparison statistics distinct from a separately prepared manual action", () => {
  const manual = { strategy: selected.strategy, status: "proposed", prediction: { vsBaseline: { totalValue: { mean: 987654 } } } } as Proposal;
  const html = render({ ...baseProps, source: "agent", proposal: manual, proposalSource: "manual" });
  expect(html).toContain("Selected scenario");
  expect(html).toContain("agent-classified comparison");
  expect(html).toContain("manual action");
  expect(html).toContain("canonical estimates");
  expect(html).toContain("+$1,234");
  expect(html).not.toContain("987,654");
  expect(html).not.toContain("Agent proposal");
  expect(html).not.toContain("Prepared action");
  expect(html).toContain('href="#approval"');
});

it("keeps simulate-only and adverse stress tied to the displayed strategy", () => {
  const simulateOnly = { ...selected, strategy: STARTER_STRATEGIES[2] };
  const stress: Extract<AgentEvent, { type: "stress" }> = { type: "stress", strategyId: selected.strategy.id, stress: { base: selected, stressed: { ...selected, vsBaseline: { ...selected.vsBaseline, totalValue: { ...selected.vsBaseline.totalValue, p50: 10 } } }, stressedParams: buildDemoTwin().twin.params, shifted: ["Discount effect weaker"] } };
  expect(render({ ...baseProps, selected: simulateOnly, stress })).toContain("Simulate only");
  expect(render({ ...baseProps, selected: simulateOnly, stress })).not.toContain("Adverse stress");
  expect(render({ ...baseProps, stress })).toContain("Adverse stress");
});

it("labels the headline pick as recommended and lists bigger simulate-only levers with reasons", () => {
  const rise = { ...selected, strategy: { id: "rise", name: "Raise list price to $27", intervention: { kind: "list_price_change" as const, newPrice: 27 } }, vsBaseline: { ...selected.vsBaseline, totalValue: { ...selected.vsBaseline.totalValue, p50: 61_792 } } };
  const html = render({ ...baseProps, recommended: true, biggerLevers: [rise] });
  expect(html).toContain("Recommended now");
  expect(html).toContain("Bigger simulated levers");
  expect(html).toContain("Raise list price to $27");
  expect(html).toContain("+$61,792");
  expect(html).toMatch(/every subscriber/);
});

it("explains why a selected simulate-only strategy is not executable", () => {
  const rise = { ...selected, strategy: { id: "rise", name: "Raise list price to $27", intervention: { kind: "list_price_change" as const, newPrice: 27 } } };
  const html = render({ ...baseProps, selected: rise });
  expect(html).toContain("Simulate only");
  expect(html).toMatch(/every subscriber/);
  expect(html).not.toContain("Recommended now");
});

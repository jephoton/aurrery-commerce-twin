import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentPanel, AgentActivity } from "./AgentPanel";
import { samplePayload } from "@/test/import-fixture";

it("offers accessible run controls and disables runs while manual work is busy", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, { objective: "Explore", disabled: true, onStart() {}, onEvent() {}, onFinish() {} }));
  expect(html).toContain("Run agent");
  expect(html).toContain("disabled");
  expect(html).toContain('role="status"');
});
it("renders customer drafts as escaped display-only text", () => {
  const html = renderToStaticMarkup(createElement(AgentActivity, { event: { type: "draft", strategyId: "save", displayOnly: true, message: "<script>private()</script>" } }));
  expect(html).toContain("Display only");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
it("shows a simulate-only recommendation with the demo-only notice", () => {
  const html = renderToStaticMarkup(createElement(AgentActivity, { event: { type: "recommendation", strategy: { id: "at-risk-20-3m", name: "At-risk: 20% off", intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 6 } }, rationale: "Price-driven leavers", tradeoffs: "Discount cost", simulateOnly: true } }));
  expect(html).toContain("Recommended (simulate only): At-risk: 20% off");
  expect(html).toContain("Price-driven leavers");
  expect(html).toContain("Tradeoffs: Discount cost");
  expect(html).toContain("PayPal actions are available for the demo merchant only.");
  expect(html).not.toContain("Approval below");
});
it("tells the user an imported investigation is simulate only", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, { objective: "Explore", disabled: false, importPayload: samplePayload(), onStart() {}, onEvent() {}, onFinish() {} }));
  expect(html).toContain("Ready to investigate. Imported merchant: simulate only, no PayPal action.");
  expect(renderToStaticMarkup(createElement(AgentPanel, { objective: "Explore", disabled: false, onStart() {}, onEvent() {}, onFinish() {} }))).toContain("Ready to investigate. Proposals require separate merchant approval.");
});

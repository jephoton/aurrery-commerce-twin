import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentPanel, AgentActivity } from "./AgentPanel";

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

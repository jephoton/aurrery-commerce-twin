import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FanChart } from "./FanChart";

it("labels a one-month comparison once", () => {
  const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series: [{ label: "Baseline", color: "gray", band: { p10: [10], p50: [12], p90: [15] } }] }));
  expect(html.match(/Month 1/g)).toHaveLength(1);
});

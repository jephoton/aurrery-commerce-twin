import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FanChart } from "./FanChart";

it("labels a one-month comparison once", () => {
  const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series: [{ label: "Baseline", color: "gray", band: { p10: [10], p50: [12], p90: [15] } }] }));
  expect(html.match(/Month 1/g)).toHaveLength(1);
});

it("describes each series with numeric start and end quantiles", () => {
  const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series: [
    { label: "Do nothing", color: "#abb8cb", baseline: true, band: { p10: [8, 9], p50: [10, 11], p90: [12, 13] } },
    { label: "Offer", color: "#e6bd69", band: { p10: [7, 14], p50: [10, 17], p90: [13, 20] } },
  ] }));
  expect(html).toContain("Do nothing: month 1 median 10, p10 8, p90 12; month 2 median 11, p10 9, p90 13");
  expect(html).toContain("Offer: month 1 median 10, p10 7, p90 13; month 2 median 17, p10 14, p90 20");
  expect(html).toContain("stroke-dasharray");
});

it("renders empty and one-point bands without invalid coordinates", () => {
  for (const series of [[], [{ label: "Offer", color: "#e6bd69", band: { p10: [4], p50: [5], p90: [6] } }], [
    { label: "Empty", color: "#abb8cb", band: { p10: [], p50: [], p90: [] } },
    { label: "Offer", color: "#e6bd69", band: { p10: [4], p50: [5], p90: [6] } },
  ]]) {
    const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series }));
    expect(html).not.toMatch(/NaN|Infinity/);
  }
});

it("renders one centered axis tick for a constant one-point band", () => {
  const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series: [
    { label: "Flat", color: "#e6bd69", band: { p10: [5], p50: [5], p90: [5] } },
  ] }));
  expect(html.match(/>5<\/text>/g)).toHaveLength(1);
  expect(html).not.toMatch(/NaN|Infinity/);
});

it("anchors endpoint month labels inside the chart without moving their data positions", () => {
  const values = Array.from({ length: 12 }, (_, i) => i + 1);
  const html = renderToStaticMarkup(createElement(FanChart, { title: "Active", format: String, series: [
    { label: "Offer", color: "#e6bd69", band: { p10: values, p50: values, p90: values } },
  ] }));
  expect(html).toMatch(/<text x="64" y="212" text-anchor="start"[^>]*>Month 1<\/text>/);
  expect(html).toMatch(/<text x="544" y="212" text-anchor="end"[^>]*>Month 12<\/text>/);
});

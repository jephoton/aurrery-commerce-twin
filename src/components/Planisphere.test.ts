import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Planisphere, STAR_MIN, starSize } from "./Planisphere";

const segments = [
  { id: "core", label: "Core", active: 820 },
  { id: "at_risk", label: "At risk (skipped or paused recently)", active: 150 },
  { id: "cancel_intent", label: "Cancel intent (opened cancel flow)", active: 30 },
];

const render = () => renderToStaticMarkup(createElement(Planisphere, { segments, total: 1000 }));
const sizes = (html: string) => Object.fromEntries([...html.matchAll(/data-segment="([^"]+)" data-size="([\d.]+)"/g)].map(([, id, size]) => [id, Number(size)]));

it("draws one star per segment", () => {
  expect(render().match(/class="planisphere-star"/g)).toHaveLength(3);
});

it("is an image with an accessible label summarising every segment", () => {
  const html = render();
  expect(html).toContain('role="img"');
  const label = html.match(/aria-label="([^"]+)"/)?.[1] ?? "";
  expect(label).toContain("3 subscriber segments");
  expect(label).toContain("1,000 active subscribers in total");
  expect(label).toContain("At risk (skipped or paused recently): 150 active");
  expect(label).toContain("decorative, not a risk scale");
  // The drawing shows the short label; the full one stays in the accessible name.
  expect(html).toMatch(/>At risk<\/text>/);
});

it("scales star size with each segment's active subscribers, with a floor", () => {
  const s = sizes(render());
  expect(s.core).toBeGreaterThan(s.at_risk);
  expect(s.at_risk).toBeGreaterThan(s.cancel_intent);
  expect(s.cancel_intent).toBeGreaterThanOrEqual(STAR_MIN);
  expect(starSize(0, 1000)).toBe(STAR_MIN);
  expect(starSize(5, 0)).toBe(STAR_MIN);
});

it("renders deterministically", () => {
  expect(render()).toBe(render());
});

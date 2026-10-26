import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MerchantSummary } from "./Lab";
import { MerchantOverview } from "./MerchantOverview";

const summary = {
  name: "Sample Merchant", planName: "Monthly", asOfMonth: "2026-10", listPrice: 24,
  active: 100, mrr: 2400, lastMonthChurnRate: .11,
  segments: [
    { id: "core", label: "Core", active: 82, churn: .04 },
    { id: "cancel_intent", label: "Cancel intent", active: 18, churn: .30 },
  ],
} as MerchantSummary;

it("pairs decorative orbits with real labelled subscriber and estimated churn values", () => {
  const html = renderToStaticMarkup(createElement(MerchantOverview, { summary }));
  expect(html).toMatch(/100<\/strong> <span[^>]*>active subscribers/);
  expect(html).toMatch(/\$2,400<\/strong> <span[^>]*>monthly recurring revenue/);
  expect(html).toMatch(/Core[\s\S]*?82 active[\s\S]*?4.0% estimated monthly churn/);
  expect(html).toMatch(/Cancel intent[\s\S]*?18 active[\s\S]*?30.0% estimated monthly churn/);
  expect(html).toContain("Synthetic demo history");
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("decorative, not a risk scale");
});

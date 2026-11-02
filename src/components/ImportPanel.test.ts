import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SAMPLE_FILES } from "@/import/sample-files";
import { samplePayload } from "@/test/import-fixture";
import type { MerchantSummary } from "@/merchant/summary";
import { DemoOnlyNotice, economicsFieldErrors, ImportedBanner, ImportErrors, ImportPanel } from "./ImportPanel";
import type { ImportSession } from "./import-flow";

it("offers template and sample downloads, two labelled file inputs and the prefilled economics", () => {
  const html = renderToStaticMarkup(createElement(ImportPanel, { disabled: false, onImported() {} }));
  expect(html).toContain("Use your own data");
  for (const path of Object.values(SAMPLE_FILES)) expect(html).toContain(`href="/${path}"`);
  expect(html.match(/type="file"/g)).toHaveLength(2);
  expect(html).toContain("History CSV");
  expect(html).toContain("Feedback CSV");
  expect(html).toContain('value="Your merchant"');
  expect(html).toContain('value="Monthly plan"');
  expect(html).toContain('value="24"');
  expect(html).toContain('value="0.0349"');
  expect(html).toContain("merchant-entered assumptions");
  expect(html).toContain("Build twin");
  expect(html).toContain("Load sample merchant");
  expect(html).not.toContain('role="alert"');
});

it("locks every control while disabled", () => {
  const html = renderToStaticMarkup(createElement(ImportPanel, { disabled: true, onImported() {} }));
  expect(html.match(/<input[^>]*type="file"[^>]*disabled=""/g)).toHaveLength(2);
  expect(html).toMatch(/<fieldset disabled=""/);
  // Busy buttons stay focusable: aria-disabled, not disabled.
  expect(html).toMatch(/<button type="button" aria-disabled="true"[^>]*>Build twin/);
  expect(html).toMatch(/<button type="button" aria-disabled="true"[^>]*>Load sample merchant/);
});

it("shows the imported banner, notes and Back to Ridgeline, and the demo-only notice", () => {
  const session = { id: 1, payload: samplePayload(), summary: { name: "Hollowbrook Treat Box" } as MerchantSummary, starterStrategies: [], reasonTargeting: true, classifierNotes: ["40 of 40 rows classified."] } satisfies ImportSession;
  const banner = renderToStaticMarkup(createElement(ImportedBanner, { session, disabled: false, onBack() {} }));
  expect(banner).toContain("Imported: Hollowbrook Treat Box · simulate only");
  expect(banner).toContain("Back to Ridgeline");
  expect(banner).toContain("40 of 40 rows classified.");
  expect(renderToStaticMarkup(createElement(DemoOnlyNotice))).toContain("PayPal actions are available for the demo merchant only.");
});

it("escapes an imported merchant name", () => {
  const session = { id: 2, payload: samplePayload(), summary: { name: "<img src=x>" } as MerchantSummary, starterStrategies: [], reasonTargeting: false, classifierNotes: [] } satisfies ImportSession;
  const banner = renderToStaticMarkup(createElement(ImportedBanner, { session, disabled: false, onBack() {} }));
  expect(banner).toContain("&lt;img src=x&gt;");
  expect(banner).not.toContain("<img");
});

it("lists every import error with its file, row and column, as escaped text", () => {
  const html = renderToStaticMarkup(createElement(ImportErrors, { errors: [
    { source: "history", row: 14, column: "voluntary_cancels", message: "voluntary + involuntary cancels + moves exceed active_start" },
    { source: "economics", row: null, column: "listPrice", message: "must be at least 1 USD" },
    { source: "server", row: null, column: null, message: "<script>x()</script>" },
  ] }));
  expect(html).toContain("History file · row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start");
  expect(html).toContain("Economics · listPrice: must be at least 1 USD");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("the current twin is unchanged");
  expect(html).toContain('role="alert"');
  expect(html).toContain('tabindex="-1"');
});

it("maps economics errors to their form fields for aria-invalid", () => {
  expect(economicsFieldErrors([
    { source: "economics", row: null, column: "listPrice", message: "must be a number" },
    { source: "economics", row: null, column: "listPrice", message: "second" },
    { source: "economics", row: null, column: "unitCost", message: "unit cost plus shipping must be below the list price" },
    { source: "history", row: 2, column: "month", message: "must be YYYY-MM" },
    { source: "economics", row: null, column: "constructor", message: "odd" },
  ])).toEqual({ listPrice: "must be a number", unitCost: "unit cost plus shipping must be below the list price" });
});

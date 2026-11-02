import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { buildImportedTwin, importedStarterStrategies } from "@/import/imported-twin";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { summarizeMerchant } from "@/merchant/summary";
import { samplePayload } from "@/test/import-fixture";
import type { ImportSession } from "./import-flow";
import { Lab, Workspace } from "./Lab";

const built = buildImportedTwin(samplePayload());
if (!built.ok) throw new Error("The sample must build.");
const importedSummary = summarizeMerchant(built.twin, built.history, { imported: { months: built.months, firstMonth: built.firstMonth, lastMonth: built.lastMonth, feedbackRows: built.feedbackRows } });
const session: ImportSession = { id: 1, payload: samplePayload(), summary: importedSummary, starterStrategies: importedStarterStrategies(built), reasonTargeting: true, classifierNotes: ["40 of 40 rows classified."] };
const demo = buildDemoTwin();
const demoSummary = summarizeMerchant(demo.twin, demo.history);
// The annual offers panel renders only once PayPal reports offers, so its absence is checked with the import only.
const PAYPAL_PANELS = ["Pilot cohort in PayPal Sandbox", "Administrator access", "Restore a verified discount", "PayPal Sandbox:"];

it("renders Ridgeline with its PayPal panels and the import panel", () => {
  const html = renderToStaticMarkup(createElement(Lab, { summary: demoSummary, starterStrategies: STARTER_STRATEGIES, simulationRuns: 400 }));
  expect(html).toContain("Ridgeline Roasters · Roaster&#x27;s Choice (monthly) · synthetic demo");
  for (const shown of [...PAYPAL_PANELS, "Use your own data"]) expect(html).toContain(shown);
  for (const hidden of ["Back to Ridgeline", "· simulate only", "demo merchant only. Go back"]) expect(html).not.toContain(hidden);
});

it("renders an imported merchant simulate-only, with no PayPal panels", () => {
  const html = renderToStaticMarkup(createElement(Workspace, { summary: importedSummary, starterStrategies: session.starterStrategies, simulationRuns: 400, imported: session, onImported() {}, onBackToDemo() {} }));
  expect(html).toContain("Imported: Hollowbrook Treat Box · simulate only");
  expect(html).toContain("Back to Ridgeline");
  expect(html).toContain("Hollowbrook Treat Box · Treat Box (monthly) · imported CSV · simulate only");
  expect(html).toContain("PayPal actions: demo merchant only");
  expect(html).toContain("PayPal actions are available for the demo merchant only. Go back to Ridgeline");
  expect(html).toContain("Ready to investigate. Imported merchant: simulate only, no PayPal action.");
  expect(html).toContain(`${session.starterStrategies.length} candidates`);
  // The import panel stays available, so a broken upload can be shown to leave the imported twin unchanged.
  expect(html).toContain("Use your own data");
  for (const hidden of [...PAYPAL_PANELS, "annual-offers-title"]) expect(html).not.toContain(hidden);
  for (const action of ["Prepare PayPal action", "Approve &amp; execute", "Refresh from PayPal"]) expect(html).not.toContain(action);
});

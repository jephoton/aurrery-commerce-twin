import { describe, expect, it } from "vitest";
import { generateDemoHistory, RIDGELINE_ECONOMICS, RIDGELINE_PROFILE } from "@/merchant/demo";
import { buildTwinFromHistory, startingActives, type ReasonCounts } from "./build-twin";
import { betaMean } from "./calibrate";

const { history, endActive } = generateDemoHistory();
const input = { history, economics: RIDGELINE_ECONOMICS, profile: RIDGELINE_PROFILE, asOfMonth: "2026-09" };
const zero = { price: 0, other: 0 };
const counts: ReasonCounts = { new: zero, core: { price: 2, other: 6 }, price_sensitive: zero, at_risk: { price: 16, other: 2 }, cancel_intent: zero };

describe("buildTwinFromHistory", () => {
  it("derives starting actives from the last month: start − cancels − moves out + moves in", () => {
    expect(startingActives(history.segments)).toEqual(endActive);
  });
  it("estimates the same parameters whatever the provenance wording", () => {
    const synthetic = buildTwinFromHistory({ ...input, source: "synthetic" });
    const csv = buildTwinFromHistory({ ...input, source: "csv" });
    expect(csv.params).toEqual(synthetic.params);
    expect(csv.initialActive).toEqual(endActive);
  });
  it("labels CSV estimates and keeps assumptions as assumptions", () => {
    const { provenance } = buildTwinFromHistory({ ...input, source: "csv" });
    for (const key of ["monthlyChurn", "involuntaryChurn", "monthlyAcquisition", "transitions"]) {
      expect(provenance[key]).toMatchObject({ source: "estimated", note: expect.stringContaining("estimated from your CSV (18 months)") });
    }
    for (const key of ["churnPriceElasticity", "acquisitionPriceElasticity", "annualUptake", "offerChurnRelativeRisk.price", "offerChurnRelativeRisk.other", "postOfferChurnMultiplier", "unitEconomics", "priceReasonShare"]) {
      expect(provenance[key].source).toBe("assumption");
    }
    expect(provenance.unitEconomics.note).toContain("Merchant-entered assumptions");
  });
  it("turns classified counts into reason-share posteriors and keeps the prior elsewhere", () => {
    const withCounts = buildTwinFromHistory({ ...input, source: "csv", reasonCounts: counts });
    const without = buildTwinFromHistory({ ...input, source: "csv" });
    expect(withCounts.params.segments.at_risk.priceReasonShare).toEqual({ alpha: 17, beta: 3 });
    expect(withCounts.params.segments.core.priceReasonShare).toEqual({ alpha: 3, beta: 7 });
    expect(withCounts.params.segments.cancel_intent.priceReasonShare).toEqual(without.params.segments.cancel_intent.priceReasonShare);
    expect(betaMean(without.params.segments.cancel_intent.priceReasonShare)).toBeCloseTo(0.6);
    expect(withCounts.provenance.priceReasonShare).toMatchObject({ source: "estimated", evidenceCount: 26, note: expect.stringContaining("AI-classified from 26 feedback rows") });
  });
  it("uses the entered list price as the reference price and copies the profile", () => {
    const twin = buildTwinFromHistory({ ...input, economics: { ...RIDGELINE_ECONOMICS, listPrice: 30 }, source: "csv" });
    expect(twin.params).toMatchObject({ listPrice: 30, referencePrice: 30 });
    twin.merchant.name = "changed";
    expect(RIDGELINE_PROFILE.name).toBe("Ridgeline Roasters");
  });
});

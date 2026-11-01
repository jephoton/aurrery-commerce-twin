import { describe, expect, it } from "vitest";
import { describeIntervention } from "./interventions";

describe("describeIntervention", () => {
  it("shows the exact annual price an offer would carry, not a float rounding", () => {
    expect(describeIntervention({ kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] }, 24))
      .toBe("Offer core, price sensitive subscribers an annual prepay plan at 15% off ($244.80/yr).");
    // 19.99 × 12 × 0.875 is 209.894999… in floating point; the offer charges 20990 cents.
    expect(describeIntervention({ kind: "annual_plan", discountPct: 12.5, segments: ["core"] }, 19.99)).toContain("($209.90/yr)");
  });
});

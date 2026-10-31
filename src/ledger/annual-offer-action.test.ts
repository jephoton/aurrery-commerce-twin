import { describe, expect, it } from "vitest";
import type { Strategy } from "@/twin/interventions";
import { AnnualOfferActionSchema, annualPriceCents, buildAnnualOfferAction } from "./annual-offer-action";

const annual: Strategy = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] } };
const eligible = [
  { subscriptionId: "I-AAAAAAAAAA01", label: "Pilot A", segment: "cancel_intent", reason: "price" },
  { subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other" },
  { subscriptionId: "I-EEEEEEEEEE05", label: "Pilot E", segment: "core", reason: "other" },
];
const input = { strategy: annual, listPrice: 24, productId: "PROD-RIDGELINE00000000", monthlyPlanId: "P-MONTHLY0000000000000000000", offerWindowDays: 7, eligible };

describe("annual offer action", () => {
  it("targets eligible pilots in the strategy's segments at list × 12 × (1 − discount)", () => {
    expect(buildAnnualOfferAction(input)).toEqual({
      type: "annual_plan_offer", productId: input.productId, monthlyPlanId: input.monthlyPlanId, currency: "USD",
      listPrice: "24.00", discountPct: 15, annualPrice: "244.80", offerWindowDays: 7, segments: ["core", "price_sensitive"],
      targets: [
        { subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other" },
        { subscriptionId: "I-EEEEEEEEEE05", label: "Pilot E", segment: "core", reason: "other" },
      ],
    });
  });

  it("computes the annual price in exact cents", () => {
    expect(annualPriceCents("24.00", 15)).toBe(24480);
    expect(annualPriceCents("19.99", 10)).toBe(21589);
    expect(annualPriceCents("bad", 10)).toBeNull();
  });

  it("refuses non-annual strategies and empty target sets", () => {
    expect(() => buildAnnualOfferAction({ ...input, strategy: { ...annual, intervention: { kind: "list_price_change", newPrice: 27 } } })).toThrow("Not an annual-plan strategy");
    expect(() => buildAnnualOfferAction({ ...input, eligible: eligible.slice(0, 1) })).toThrow("No eligible subscribers");
  });

  it("rejects tampered or invalid payloads", () => {
    const valid = buildAnnualOfferAction(input);
    for (const bad of [
      { ...valid, annualPrice: "200.00" },
      { ...valid, offerWindowDays: 0 },
      { ...valid, offerWindowDays: 31 },
      { ...valid, targets: [valid.targets[0], valid.targets[0]] },
      { ...valid, targets: [{ ...valid.targets[0], segment: "at_risk" }] },
      { ...valid, currency: "EUR" },
      { ...valid, extra: true },
    ]) expect(AnnualOfferActionSchema.safeParse(bad).success).toBe(false);
  });
});

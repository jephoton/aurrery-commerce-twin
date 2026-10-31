import { describe, expect, it } from "vitest";
import type { Strategy } from "@/twin/interventions";
import { AnnualOfferActionSchema, annualPriceCents, buildAnnualOfferAction } from "./annual-offer-action";

const annual: Strategy = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] } };
const CREATED = "2026-10-22T00:00:00.000Z";
const eligible = [
  { subscriptionId: "I-AAAAAAAAAA01", label: "Pilot A", segment: "cancel_intent", reason: "price", createdAt: CREATED },
  { subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other", createdAt: CREATED },
  { subscriptionId: "I-EEEEEEEEEE05", label: "Pilot E", segment: "core", reason: "other", createdAt: CREATED },
];
const input = { strategy: annual, listPrice: 24, productId: "PROD-RIDGELINE00000000", monthlyPlanId: "P-MONTHLY0000000000000000000", offerWindowDays: 7, eligible };
const target = (id: string, label: string) => ({ subscriptionId: id, registration: { label, segment: "core", reason: "other", createdAt: CREATED } });

describe("annual offer action", () => {
  it("targets eligible pilots in the strategy's segments at list × 12 × (1 − discount)", () => {
    expect(buildAnnualOfferAction(input)).toEqual({
      type: "annual_plan_offer", productId: input.productId, monthlyPlanId: input.monthlyPlanId, currency: "USD",
      listPrice: "24.00", discountPct: 15, annualPrice: "244.80", offerWindowDays: 7, segments: ["core", "price_sensitive"],
      targets: [target("I-DDDDDDDDDD04", "Pilot D"), target("I-EEEEEEEEEE05", "Pilot E")],
    });
  });

  it("computes the annual price in exact cents", () => {
    expect(annualPriceCents("24.00", 15)).toBe(24480);
    expect(annualPriceCents("19.99", 10)).toBe(21589);
    expect(annualPriceCents("19.99", 12.5)).toBe(20990);
    expect(annualPriceCents("9.99", 5)).toBe(11389);
    expect(annualPriceCents("bad", 10)).toBeNull();
  });

  it("refuses non-annual strategies, empty target sets and non-positive list prices", () => {
    expect(() => buildAnnualOfferAction({ ...input, strategy: { ...annual, intervention: { kind: "list_price_change", newPrice: 27 } } })).toThrow("Not an annual-plan strategy");
    expect(() => buildAnnualOfferAction({ ...input, eligible: eligible.slice(0, 1) })).toThrow("No eligible subscribers");
    expect(() => buildAnnualOfferAction({ ...input, listPrice: 0 })).toThrow();
    expect(() => buildAnnualOfferAction({ ...input, listPrice: 200.01 })).toThrow();
  });

  it("caps targets at 25 in input order", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ subscriptionId: `I-CORE${String(i).padStart(4, "0")}`, label: `Pilot ${i}`, segment: "core", reason: "other", createdAt: CREATED }));
    const built = buildAnnualOfferAction({ ...input, eligible: many });
    expect(built.targets).toHaveLength(25);
    expect(built.targets.map((t) => t.subscriptionId)).toEqual(many.slice(0, 25).map((m) => m.subscriptionId));
  });

  it("is stable through a JSON round trip (hash stability)", () => {
    const built = buildAnnualOfferAction(input);
    const reparsed = AnnualOfferActionSchema.parse(JSON.parse(JSON.stringify(built)));
    expect(reparsed).toEqual(built);
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(built));
  });

  it("rejects tampered or invalid payloads", () => {
    const valid = buildAnnualOfferAction(input);
    for (const bad of [
      { ...valid, annualPrice: "200.00" },
      { ...valid, listPrice: "024.00", annualPrice: "0001.00" },
      { ...valid, annualPrice: "0244.80" },
      { ...valid, listPrice: "0.00", annualPrice: "0.00" },
      { ...valid, listPrice: "200.01", annualPrice: "2161.08" },
      { ...valid, listPrice: "0.01", discountPct: 40, annualPrice: "0.00" },
      { ...valid, offerWindowDays: 0 },
      { ...valid, offerWindowDays: 31 },
      { ...valid, targets: [valid.targets[0], valid.targets[0]] },
      { ...valid, targets: [{ ...valid.targets[0], registration: { ...valid.targets[0].registration, segment: "at_risk" } }] },
      { ...valid, targets: [{ ...valid.targets[0], registration: { ...valid.targets[0].registration, createdAt: "yesterday" } }] },
      { ...valid, targets: [{ ...valid.targets[0], registration: { ...valid.targets[0].registration, extra: 1 } }] },
      { ...valid, targets: [{ subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other" }] },
      { ...valid, segments: ["core", "core"] },
      { ...valid, segments: ["new", "core", "price_sensitive", "at_risk", "cancel_intent", "core"] },
      { ...valid, productId: "prod-ridgeline" },
      { ...valid, monthlyPlanId: "P-bad id" },
      { ...valid, currency: "EUR" },
      { ...valid, extra: true },
    ]) expect(AnnualOfferActionSchema.safeParse(bad).success).toBe(false);
  });
});

import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { formatRowError } from "./row-error";
import { DEFAULT_ECONOMICS, EconomicsSchema, economicsErrors, SAMPLE_ECONOMICS } from "./economics";

const issues = (value: unknown) => {
  const parsed = EconomicsSchema.safeParse(value);
  if (parsed.success) throw new Error("expected errors");
  return economicsErrors(parsed.error).map(formatRowError);
};

it("prefills Ridgeline's numbers under a neutral name", () => {
  const { params } = buildDemoTwin().twin;
  expect(DEFAULT_ECONOMICS).toEqual({ merchantName: "Your merchant", planName: "Monthly plan", listPrice: params.listPrice, unitCost: params.unitCost, shippingCost: params.shippingCost, paymentFeeRate: params.paymentFeeRate, paymentFeeFixed: params.paymentFeeFixed });
  expect(EconomicsSchema.parse(DEFAULT_ECONOMICS)).toEqual(DEFAULT_ECONOMICS);
  expect(EconomicsSchema.parse(SAMPLE_ECONOMICS)).toEqual(SAMPLE_ECONOMICS);
});
it("enforces the spec's bounds", () => {
  // A field error may or may not also trigger the cross-field check, depending on Zod's refinement order; assert the field message.
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: 0.5 })).toContain("listPrice: must be at least 1 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: 201 })).toContain("listPrice: must be at most 200 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, unitCost: -1 })).toContain("unitCost: must not be negative");
  expect(issues({ ...DEFAULT_ECONOMICS, paymentFeeRate: 0.21 })).toContain("paymentFeeRate: must be at most 0.2");
  expect(issues({ ...DEFAULT_ECONOMICS, paymentFeeFixed: 5.01 })).toContain("paymentFeeFixed: must be at most 5 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, unitCost: 15, shippingCost: 9 })).toEqual(["unitCost: unit cost plus shipping must be below the list price"]);
});
it("rejects empty names, control characters, blank numbers and extra fields", () => {
  expect(issues({ ...DEFAULT_ECONOMICS, merchantName: "  " })).toEqual(["merchantName: is required"]);
  expect(issues({ ...DEFAULT_ECONOMICS, planName: "a\u0007b" })).toEqual(["planName: must not contain control characters"]);
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: Number.NaN })[0]).toMatch(/^listPrice: /);
  expect(issues({ ...DEFAULT_ECONOMICS, extra: 1 })[0]).toMatch(/extra|Unrecognized/);
});

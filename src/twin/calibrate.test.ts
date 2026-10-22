import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { updateDiscountEffect, type DiscountOutcomeObservation } from "./calibrate";

it("skips aggregate any-reason outcomes while retaining assessed per-pilot evidence", () => {
  const { twin } = buildDemoTwin();
  const aggregate: DiscountOutcomeObservation = {
    segment: "cancel_intent", reason: "any", subscriberMonths: 900, cancellations: 300,
  };
  const assessed: DiscountOutcomeObservation = {
    segment: "cancel_intent", reason: "price", subscriberMonths: 100, cancellations: 1,
  };
  const skipped = updateDiscountEffect(twin, [aggregate]);
  expect(skipped.changes).toEqual([]);
  expect(skipped.twin).toEqual(twin);
  expect(updateDiscountEffect(twin, [aggregate, assessed])).toEqual(updateDiscountEffect(twin, [assessed]));
  expect(updateDiscountEffect(twin, [assessed]).changes.map((c) => c.parameter)).toEqual(["offerChurnRelativeRisk.price"]);
});

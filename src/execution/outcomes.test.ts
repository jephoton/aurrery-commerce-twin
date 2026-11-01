import { expect, it } from "vitest";
import { ExecutionReconciliationRequired, REFUSAL_TEXT, isDefinitiveFailure, outcomeStatusText } from "./outcomes";

it.each([[400, true], [401, true], [403, true], [404, true], [422, true], [200, false], [409, false], [429, false], [500, false], [null, false]] as const)(
  "classifies HTTP %s as definitive: %s", (status, expected) => expect(isDefinitiveFailure(status)).toBe(expected));

it("names the proposal that needs reconciliation", () => {
  expect(new ExecutionReconciliationRequired("prop_x")).toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: "prop_x" });
});

it("shows the refusal reason instead of the observed status for a refused target", () => {
  const outcome = { subscriptionId: "I-ONE", ok: false, httpStatus: null, debugId: null, verified: false, error: "anything",
    observed: { status: "ACTIVE", regularPrice: "244.8", planOverridden: false, nextBillingTime: null } };
  expect(outcomeStatusText({ ...outcome, refused: "annual_plan" })).toBe(REFUSAL_TEXT.annual_plan);
  expect(REFUSAL_TEXT.annual_plan).toBe("On an annual plan by customer choice; the price was not changed.");
  expect(outcomeStatusText({ ...outcome, refused: "plan_unknown" })).toBe(REFUSAL_TEXT.plan_unknown);
  expect(REFUSAL_TEXT.plan_unknown).toMatch(/did not report/);
  expect(outcomeStatusText(outcome)).toBe("ACTIVE");
  expect(outcomeStatusText({ ...outcome, observed: null })).toBe("anything");
  expect(outcomeStatusText({ ...outcome, observed: null, error: null })).toBeNull();
});

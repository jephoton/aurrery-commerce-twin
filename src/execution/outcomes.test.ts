import { expect, it } from "vitest";
import { ExecutionReconciliationRequired, isDefinitiveFailure } from "./outcomes";

it.each([[400, true], [401, true], [403, true], [404, true], [422, true], [200, false], [409, false], [429, false], [500, false], [null, false]] as const)(
  "classifies HTTP %s as definitive: %s", (status, expected) => expect(isDefinitiveFailure(status)).toBe(expected));

it("names the proposal that needs reconciliation", () => {
  expect(new ExecutionReconciliationRequired("prop_x")).toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: "prop_x" });
});

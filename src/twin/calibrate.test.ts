import { describe, expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { betaMean, updateAnnualUptake, updateDiscountEffect, type DiscountOutcomeObservation } from "./calibrate";

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

describe("annual uptake learning", () => {
  const twin = buildDemoTwin().twin;
  it("adds accepted and confirmed-declined offers to the segment's Beta prior and marks it observed", () => {
    const before = twin.params.segments.core.annualUptake;
    const { twin: updated, changes } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, declined: 1 }]);
    expect(updated.params.segments.core.annualUptake).toEqual({ alpha: before.alpha + 1, beta: before.beta + 1 });
    expect(updated.provenance["annualUptake.core"]).toMatchObject({ source: "observed", evidenceCount: 2 });
    expect(updated.provenance["annualUptake.core"].note).toContain("1 accepted of 2 resolved");
    expect(changes).toEqual([expect.objectContaining({ parameter: "annualUptake.core", evidence: "1 accepted of 2 resolved annual offer(s); 1 confirmed decline(s)" })]);
    expect(changes[0].before.mean).toBeCloseTo(betaMean(before));
  });
  it("leaves other segments and the canonical twin untouched, and ignores empty counts", () => {
    const original = structuredClone(twin);
    const { twin: updated, changes } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, declined: 0 }, { segment: "new", accepted: 0, declined: 0 }]);
    expect(updated.params.segments.new).toEqual(twin.params.segments.new);
    expect(changes.map((c) => c.parameter)).toEqual(["annualUptake.core"]);
    expect(twin).toEqual(original);
  });
  it("rejects negative or non-integer counts", () => {
    expect(() => updateAnnualUptake(twin, [{ segment: "core", accepted: -1, declined: 0 }])).toThrow(RangeError);
    expect(() => updateAnnualUptake(twin, [{ segment: "core", accepted: 0.5, declined: 0 }])).toThrow(RangeError);
  });
});

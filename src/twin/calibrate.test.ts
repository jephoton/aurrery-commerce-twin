import { describe, expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { stressTest } from "./stress";
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
    expect(updated.provenance["segments.core.annualUptake"]).toMatchObject({ source: "observed", evidenceCount: 2 });
    const note = updated.provenance["segments.core.annualUptake"].note;
    expect(note).toContain(twin.params.segments.core.label);
    expect(note).toContain("uptake prior updated");
    expect(note).toContain("1 accepted, 1 confirmed declined (2 resolved annual offer(s))");
    expect(changes).toEqual([expect.objectContaining({ parameter: "segments.core.annualUptake" })]);
    expect(changes[0].evidence).toContain("1 accepted");
    expect(changes[0].evidence).toContain("1 confirmed declined");
    expect(changes[0].evidence).toContain("2 resolved annual offer(s)");
    expect(changes[0].before.mean).toBeCloseTo(betaMean(before));
  });
  it("leaves other segments and the canonical twin untouched, and ignores empty counts", () => {
    const original = structuredClone(twin);
    const { twin: updated, changes } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, declined: 0 }, { segment: "new", accepted: 0, declined: 0 }]);
    expect(updated.params.segments.new).toEqual(twin.params.segments.new);
    expect(changes.map((c) => c.parameter)).toEqual(["segments.core.annualUptake"]);
    expect(twin).toEqual(original);
  });
  it("rejects a segment that appears more than once", () => {
    expect(() => updateAnnualUptake(twin, [{ segment: "core", accepted: 1, declined: 0 }, { segment: "core", accepted: 0, declined: 1 }])).toThrow(new RangeError("Each segment may appear once."));
  });
  it("is treated as observed, not as an assumption, by the annual-plan stress shift", () => {
    const { twin: updated } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, declined: 1 }]);
    const strategy = { id: "annual", name: "Annual", intervention: { kind: "annual_plan" as const, discountPct: 15, segments: ["core" as const, "price_sensitive" as const] } };
    const { stressedParams, shifted } = stressTest(updated, strategy, { runs: 2, horizonMonths: 2, seed: 1 });
    expect(stressedParams.segments.core.annualUptake).toEqual(updated.params.segments.core.annualUptake);
    expect(stressedParams.segments.price_sensitive.annualUptake).not.toEqual(updated.params.segments.price_sensitive.annualUptake);
    expect(shifted.some((line) => line.includes(updated.params.segments.core.label))).toBe(false);
  });
  it("rejects negative or non-integer counts", () => {
    const message = "Offer counts must be non-negative integers.";
    expect(() => updateAnnualUptake(twin, [{ segment: "core", accepted: -1, declined: 0 }])).toThrow(new RangeError(message));
    expect(() => updateAnnualUptake(twin, [{ segment: "core", accepted: 0.5, declined: 0 }])).toThrow(new RangeError(message));
  });
});

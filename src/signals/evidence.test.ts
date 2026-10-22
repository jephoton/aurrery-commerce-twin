import { describe, expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { PILOT_COHORT } from "@/paypal/setup";
import { feedbackCorpus, loadGroundTruth } from "./corpus";
import type { FeedbackMessage, Prediction } from "./contracts";
import { applyEvidence, pilotEligibility, summarizeEvidence } from "./evidence";

const message = (id: string, segment: FeedbackMessage["segment"] = "cancel_intent"): FeedbackMessage => ({ id, text: id, source: "cancel_flow", segment });
const prediction = (id: string, reason: Prediction["reason"] = "price", confidence = 0.9): Prediction => ({ id, reason, confidence, intent: "cancel" });
const messages = [message("p1"), message("p2"), message("o")];
const accepted = [prediction("p1", "price", 0.7), prediction("p2", "price", 1), prediction("o", "other")];

describe("classified feedback evidence", () => {
  it("replaces the affected reason prior with unweighted Beta counts and exact provenance", () => {
    const original = buildDemoTwin().twin;
    const before = structuredClone(original);
    const updated = applyEvidence(original, messages, accepted);
    expect(updated.params.segments.cancel_intent.priceReasonShare).toEqual({ alpha: 3, beta: 2 });
    expect(updated.provenance["segments.cancel_intent.priceReasonShare"]).toMatchObject({ source: "estimated", evidenceCount: 3 });
    expect(updated.provenance["segments.cancel_intent.priceReasonShare"].note).toContain("AI-classified synthetic feedback");
    expect(original).toEqual(before);
    expect(updated).not.toBe(original);
    const restored = structuredClone(updated);
    restored.params.segments.cancel_intent.priceReasonShare = before.params.segments.cancel_intent.priceReasonShare;
    delete restored.provenance["segments.cancel_intent.priceReasonShare"];
    expect(restored).toEqual(before);
    expect(applyEvidence(updated, messages, accepted)).toEqual(updated);
  });

  it("preserves absent segments, existing provenance and all priors with no accepted evidence", () => {
    const original = buildDemoTwin().twin;
    original.provenance["segments.core.priceReasonShare"] = { source: "observed", note: "existing" };
    expect(applyEvidence(original, messages, [])).toEqual(original);
    const updated = applyEvidence(original, [message("core", "core")], [prediction("core", "other")]);
    expect(updated.params.segments.core.priceReasonShare).toEqual({ alpha: 1, beta: 2 });
    expect(updated.params.segments.cancel_intent).toEqual(original.params.segments.cancel_intent);
    expect(updated.provenance).not.toHaveProperty("segments.cancel_intent.priceReasonShare");
  });

  it("filters low confidence and schema-invalid predictions and reports segment and intent counts separately", () => {
    const input = [...messages, message("stay", "core")];
    const predictions = [prediction("p1", "price", 0.69), { ...prediction("p2"), confidence: NaN }, prediction("o", "other"), { ...prediction("stay"), intent: "stay" as const }];
    const summary = summarizeEvidence(input, predictions);
    expect(summary.accepted.map(({ id }) => id)).toEqual(["o", "stay"]);
    expect(summary.segments.cancel_intent).toEqual({ price: 0, other: 1 });
    expect(summary.segments.core).toEqual({ price: 1, other: 0 });
    expect(summary.intents).toEqual({ cancel: 1, considering_cancel: 0, stay: 1 });
  });

  it("rejects duplicate inputs, predictions and unknown IDs instead of counting them", () => {
    const twin = buildDemoTwin().twin;
    expect(() => applyEvidence(twin, [messages[0], messages[0]], accepted)).toThrow(/unique|duplicate/i);
    expect(() => applyEvidence(twin, messages, [accepted[0], accepted[0]])).toThrow(/unique|duplicate/i);
    expect(() => applyEvidence(twin, messages, [prediction("unknown")])).toThrow(/unknown/i);
    expect(() => applyEvidence(twin, [message("x", "unknown" as FeedbackMessage["segment"])], [])).toThrow(/segment/i);
  });
});

describe("runtime pilot eligibility", () => {
  const labels = PILOT_COHORT.map(({ label }) => label);
  const registry = labels.map((label, i) => ({ label, subscriptionId: `local-${i}`, segment: "ignored", reason: "other" }));
  it("maps A/B only through stable labels despite reordered registry and replacement IDs", async () => {
    const truth = await loadGroundTruth();
    const predictions = feedbackCorpus.map(({ id }) => ({ id, ...truth[id], confidence: 1 }));
    const rows = [{ ...registry[0], subscriptionId: "replacement-A" }, ...registry.slice(1)].reverse();
    const before = structuredClone(rows);
    const report = pilotEligibility(feedbackCorpus, predictions, rows, labels);
    expect(report.eligibleSubscriptionIds).toEqual(["replacement-A", "local-1"]);
    expect(report.pilots.map(({ eligible }) => eligible)).toEqual([true, true, false, false]);
    expect(report.issues).toEqual([]);
    expect(rows).toEqual(before);
  });

  it("fails closed and reports missing or ambiguous labels and duplicate subscription IDs", () => {
    const pilots = [0, 1, 2, 3].map((pilotIndex) => ({ ...message(`pilot-${pilotIndex}`), pilotIndex: pilotIndex as 0 | 1 | 2 | 3 }));
    const predictions = pilots.map(({ id }) => prediction(id));
    const rows = [registry[0], { ...registry[0], subscriptionId: "duplicate-label" }, { ...registry[2], subscriptionId: registry[3].subscriptionId }, registry[3]];
    const report = pilotEligibility(pilots, predictions, rows, labels);
    expect(report.eligibleSubscriptionIds).toEqual([]);
    expect(report.issues.map(({ cause }) => cause)).toEqual(["ambiguous_mapping", "missing_mapping", "ambiguous_mapping", "ambiguous_mapping"]);
  });

  it("uses predictions without repairing them from registry reasons or hidden labels", () => {
    const pilots = [0, 1, 2, 3].map((pilotIndex) => ({ ...message(`pilot-${pilotIndex}`, pilotIndex === 3 ? "core" : "cancel_intent"), pilotIndex: pilotIndex as 0 | 1 | 2 | 3 }));
    const predictions = [prediction("pilot-0", "other"), { ...prediction("pilot-1"), intent: "considering_cancel" as const }, prediction("pilot-2"), prediction("pilot-3")];
    expect(pilotEligibility(pilots, predictions, registry, labels).eligibleSubscriptionIds).toEqual(["local-2"]);
    expect(pilotEligibility(pilots, [prediction("pilot-0", "price", 0.69)], registry, labels).eligibleSubscriptionIds).toEqual([]);
    expect(() => pilotEligibility([...pilots, { ...pilots[0], id: "extra" }], predictions, registry, labels)).toThrow(/pilot/i);
  });
});

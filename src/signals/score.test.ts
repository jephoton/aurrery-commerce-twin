import { describe, expect, it } from "vitest";
import type { FeedbackMessage, GroundTruth, Prediction } from "./contracts";
import { feedbackCorpus, loadGroundTruth } from "./corpus";
import { scoreClassification } from "./score";

const messages: FeedbackMessage[] = ["a", "b", "c", "d"].map((id) => ({ id, text: id, source: "support", segment: "core" }));
const truth: GroundTruth = { a: { intent: "stay", reason: "other" }, b: { intent: "cancel", reason: "price" }, c: { intent: "considering_cancel", reason: "other" }, d: { intent: "cancel", reason: "other" } };
const predict = (id: string): Prediction => ({ id, ...truth[id], confidence: 0.9 });

describe("provider agreement scoring", () => {
  it("separates valid output, coverage and accepted agreement from full-corpus agreement", () => {
    const report = scoreClassification(messages, truth, { accepted: [predict("a"), { ...predict("b"), reason: "other" }], schemaValidCount: 3 }, true);
    expect(report.total).toBe(4);
    expect(report.acceptedCount).toBe(2);
    expect(report.unclassifiedCount).toBe(2);
    expect(report.schemaValidRate).toBe(0.75);
    expect(report.acceptedCoverage).toBe(0.5);
    expect(report.acceptedAgreement).toEqual({ intent: 1, reason: 0.5, joint: 0.5 });
    expect(report.wholeCorpusAgreement).toEqual({ intent: 0.5, reason: 0.25, joint: 0.25 });
    expect(report.confusion.intent.cancel.cancel).toBe(1);
    expect(report.confusion.intent.cancel.unclassified).toBe(1);
    expect(report.confusion.intent.considering_cancel.unclassified).toBe(1);
    expect(report.confusion.reason.price.other).toBe(1);
    expect(report.confusion.reason.other.unclassified).toBe(2);
    expect(report.suitable).toBe(false);
  });

  it("uses zeros without NaN for no accepted outputs or an empty corpus", () => {
    for (const input of [messages, []]) {
      const labels = input.length ? truth : {};
      const report = scoreClassification(input, labels, { accepted: [], schemaValidCount: 0 }, true);
      expect(report.acceptedAgreement).toEqual({ intent: 0, reason: 0, joint: 0 });
      expect(report.wholeCorpusAgreement).toEqual({ intent: 0, reason: 0, joint: 0 });
      expect(report.schemaValidRate).toBe(0);
      expect(report.acceptedCoverage).toBe(0);
      expect(report.suitable).toBe(false);
    }
  });

  it("rejects duplicate/unknown IDs, missing or unknown truth and impossible valid counts", () => {
    const result = { accepted: [predict("a")], schemaValidCount: 1 };
    expect(() => scoreClassification([messages[0], messages[0]], truth, result, true)).toThrow(/unique|duplicate/i);
    expect(() => scoreClassification(messages, truth, { ...result, accepted: [predict("a"), predict("a")] }, true)).toThrow(/unique|duplicate/i);
    expect(() => scoreClassification(messages, truth, { ...result, accepted: [{ ...predict("a"), id: "unknown" }] }, true)).toThrow(/unknown/i);
    expect(() => scoreClassification(messages, { ...truth, a: undefined } as unknown as GroundTruth, result, true)).toThrow(/truth/i);
    expect(() => scoreClassification(messages, { ...truth, extra: truth.a }, result, true)).toThrow(/truth/i);
    for (const schemaValidCount of [-1, 5, 1.5, NaN, 0]) expect(() => scoreClassification(messages, truth, { ...result, schemaValidCount }, true)).toThrow(/valid/i);
  });

  it("requires inclusive thresholds, all four pilot checks and a passing tool smoke", async () => {
    const labels = await loadGroundTruth();
    const all = feedbackCorpus.map(({ id }) => ({ id, ...labels[id], confidence: 1 }));
    const nonPilots = feedbackCorpus.filter(({ pilotIndex }) => pilotIndex === undefined);
    const omitted = new Set(nonPilots.slice(0, 20).map(({ id }) => id));
    const accepted = all.filter(({ id }) => !omitted.has(id));
    const report = scoreClassification(feedbackCorpus, labels, { accepted, schemaValidCount: 190 }, true);
    expect(report.acceptedCoverage).toBe(0.9);
    expect(report.wholeCorpusAgreement.joint).toBe(0.9);
    expect(report.pilotChecks.map(({ correct }) => correct)).toEqual([true, true, true, true]);
    expect(report.suitable).toBe(true);
    expect(scoreClassification(feedbackCorpus, labels, { accepted, schemaValidCount: 189 }, true).suitable).toBe(false);
    expect(scoreClassification(feedbackCorpus, labels, { accepted: accepted.slice(0, -1), schemaValidCount: 190 }, true).suitable).toBe(false);
    expect(scoreClassification(feedbackCorpus, labels, { accepted, schemaValidCount: 190 }, false).suitable).toBe(false);
    const pilotA = feedbackCorpus.find(({ pilotIndex }) => pilotIndex === 0)!;
    const wrong = all.map((p) => p.id === pilotA.id ? { ...p, reason: "other" as const } : p);
    const wrongReport = scoreClassification(feedbackCorpus, labels, { accepted: wrong, schemaValidCount: 200 }, true);
    expect(wrongReport.wholeCorpusAgreement.joint).toBe(0.995);
    expect(wrongReport.pilotChecks[0]).toMatchObject({ expectedEligible: true, actualEligible: false, correct: false });
    expect(wrongReport.suitable).toBe(false);
    const pilotD = feedbackCorpus.find(({ pilotIndex }) => pilotIndex === 3)!;
    expect(scoreClassification(feedbackCorpus, labels, { accepted: all.filter(({ id }) => id !== pilotD.id), schemaValidCount: 199 }, true).pilotChecks[3].correct).toBe(false);
    const mislabeledD = all.map((p) => p.id === pilotD.id ? { ...p, intent: "cancel" as const } : p);
    expect(scoreClassification(feedbackCorpus, labels, { accepted: mislabeledD, schemaValidCount: 200 }, true).suitable).toBe(false);
  });
});

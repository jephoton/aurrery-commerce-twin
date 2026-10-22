import { describe, expect, it } from "vitest";
import { SEGMENTS } from "@/twin/types";
import { MIN_CONFIDENCE, PredictionSchema, PROMPT_VERSION, SCHEMA_VERSION } from "./contracts";
import { corpusVersion, feedbackCorpus, loadGroundTruth, toModelInput } from "./corpus";

describe("synthetic feedback corpus", () => {
  it("contains 200 stable, distinct messages across all known segments and sources", () => {
    expect(corpusVersion).toBe("feedback-corpus-v1");
    expect(feedbackCorpus).toHaveLength(200);
    expect(new Set(feedbackCorpus.map((message) => message.id)).size).toBe(200);
    expect(new Set(feedbackCorpus.map((message) => message.text)).size).toBe(200);
    expect([...new Set(feedbackCorpus.map((message) => message.segment))].sort()).toEqual([...SEGMENTS].sort());
    expect([...new Set(feedbackCorpus.map((message) => message.source))].sort()).toEqual(["cancel_flow", "support"]);
    for (const message of feedbackCorpus) {
      expect(message.id).toMatch(/^feedback-\d{3}$/);
      expect(message.text.trim().length).toBeGreaterThan(0);
      expect(SEGMENTS).toContain(message.segment);
      expect(["cancel_flow", "support"]).toContain(message.source);
      expect(message).not.toHaveProperty("intent");
      expect(message).not.toHaveProperty("reason");
    }
  });

  it("keeps complete ground truth separate and keyed by message ID", async () => {
    const truth = await loadGroundTruth();
    expect(Object.keys(truth).sort()).toEqual(feedbackCorpus.map((message) => message.id).sort());
    for (const [id, label] of Object.entries(truth)) {
      expect(PredictionSchema.safeParse({ id, ...label, confidence: 1 }).success).toBe(true);
      expect(Object.keys(label).sort()).toEqual(["intent", "reason"]);
    }
    expect(new Set(Object.values(truth).map((label) => label.intent))).toEqual(new Set(["cancel", "considering_cancel", "stay"]));
  });

  it("maps exactly four pilot quotations by stable index with their original labels", async () => {
    const pilots = feedbackCorpus.filter((message) => message.pilotIndex !== undefined);
    const truth = await loadGroundTruth();
    expect(pilots.map((message) => message.pilotIndex).sort()).toEqual([0, 1, 2, 3]);
    const texts = ["honestly it's just too expensive right now", "can't justify $24 a month anymore", "moving abroad next month", "loyal, 14 months"];
    for (const [index, text] of texts.entries()) {
      const pilot = pilots.find((message) => message.pilotIndex === index)!;
      expect(pilot.text).toBe(text);
      expect(feedbackCorpus.filter((message) => message.text === text)).toHaveLength(1);
      expect(pilot.source).toBe(index === 3 ? "support" : "cancel_flow");
      expect(pilot.segment).toBe(index === 3 ? "core" : "cancel_intent");
      expect(truth[pilot.id]).toEqual({ intent: index === 3 ? "stay" : "cancel", reason: index < 2 ? "price" : "other" });
    }
  });

  it("projects only the four allowed model input fields even if labels or metadata are attached", () => {
    const standalone = { id: "standalone", text: "Thanks", source: "support" as const, segment: "core" as const, pilotIndex: 3 as const };
    for (const message of [standalone, ...feedbackCorpus]) {
      const enriched = { ...message, intent: "cancel", reason: "price", corpusVersion, subscriptionId: "synthetic-only" };
      expect(toModelInput(enriched)).toEqual({ id: message.id, text: message.text, source: message.source, segment: message.segment });
      expect(Object.keys(toModelInput(enriched)).sort()).toEqual(["id", "segment", "source", "text"]);
    }
  });
});

describe("prediction contract", () => {
  const valid = { id: "feedback-001", intent: "cancel", reason: "price", confidence: 0.7 };
  it("pins prompt, schema and acceptance threshold versions", () => {
    expect(PROMPT_VERSION).toBe("feedback-v1");
    expect(SCHEMA_VERSION).toBe("classification-v1");
    expect(MIN_CONFIDENCE).toBe(0.7);
  });
  it.each([0, 0.69, 0.7, 1])("accepts schema-valid confidence %s independently of the acceptance threshold", (confidence) => {
    expect(PredictionSchema.parse({ ...valid, confidence })).toEqual({ ...valid, confidence });
  });
  it.each([
    { confidence: -0.01 }, { confidence: 1.01 }, { confidence: NaN },
    { confidence: Infinity }, { confidence: -Infinity }, { confidence: "0.8" },
    { id: "" }, { id: "   " }, { intent: "unknown" }, { reason: "relocation" },
    { unexpected: "field" }, { pilotIndex: 0 },
  ])("rejects invalid prediction %j", (override) => {
    expect(PredictionSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
  it("requires every field", () => {
    for (const key of Object.keys(valid)) {
      const incomplete: Record<string, unknown> = { ...valid };
      delete incomplete[key];
      expect(PredictionSchema.safeParse(incomplete).success).toBe(false);
    }
  });
});

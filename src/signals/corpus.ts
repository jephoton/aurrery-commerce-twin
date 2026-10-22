import "server-only";
import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import { PredictionSchema, type FeedbackMessage, type GroundTruth, type ModelInput } from "./contracts";
import fixture from "./fixtures/feedback.json";

const corpus = z.strictObject({
  corpusVersion: z.string().min(1),
  messages: z.array(z.strictObject({
    id: z.string().min(1),
    text: z.string().min(1),
    source: z.enum(["cancel_flow", "support"]),
    segment: z.enum(SEGMENTS),
    pilotIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })),
}).parse(fixture);

export const corpusVersion = corpus.corpusVersion;
export const feedbackCorpus: FeedbackMessage[] = corpus.messages;

/** Evaluation only: importing the corpus never eagerly loads hidden labels. */
export async function loadGroundTruth(): Promise<GroundTruth> {
  const { default: truth } = await import("./fixtures/truth.json");
  return z.record(z.string(), PredictionSchema.pick({ intent: true, reason: true })).parse(truth);
}

/** Allow-list projection keeps pilot identity, truth and future metadata out of prompts. */
export function toModelInput(message: FeedbackMessage): ModelInput {
  const { id, text, source, segment } = message;
  return { id, text, source, segment };
}

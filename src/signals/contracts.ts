import { z } from "zod";
import type { SegmentId } from "@/twin/types";

export interface FeedbackMessage {
  id: string;
  text: string;
  source: "cancel_flow" | "support";
  segment: SegmentId;
  pilotIndex?: 0 | 1 | 2 | 3;
}

export type ModelInput = Pick<FeedbackMessage, "id" | "text" | "source" | "segment">;
export const PROMPT_VERSION = "feedback-v1";
export const SCHEMA_VERSION = "classification-v1";
export const MIN_CONFIDENCE = 0.7;

export const PredictionSchema = z.strictObject({
  id: z.string().trim().min(1),
  intent: z.enum(["cancel", "considering_cancel", "stay"]),
  reason: z.enum(["price", "other"]),
  confidence: z.number().finite().min(0).max(1),
});

export type Prediction = z.infer<typeof PredictionSchema>;
export type GroundTruthLabel = Pick<Prediction, "intent" | "reason">;
export type GroundTruth = Record<string, GroundTruthLabel>;

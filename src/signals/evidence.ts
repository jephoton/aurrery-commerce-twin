import { SEGMENTS, type MerchantTwin, type SegmentId } from "@/twin/types";
import { MIN_CONFIDENCE, PredictionSchema, type FeedbackMessage, type Prediction } from "./contracts";

export interface EvidenceSummary {
  accepted: Prediction[];
  segments: Record<SegmentId, { price: number; other: number }>;
  intents: Record<Prediction["intent"], number>;
}

/** Revalidate at the pure boundary. Ambiguous identities can never add observations. */
export function summarizeEvidence(messages: FeedbackMessage[], predictions: Prediction[]): EvidenceSummary {
  const byId = new Map<string, FeedbackMessage>();
  for (const message of messages) {
    if (!message.id.trim() || message.id !== message.id.trim() || byId.has(message.id)) throw new Error("Feedback IDs must be nonempty, trimmed and unique");
    if (!SEGMENTS.includes(message.segment)) throw new Error("Unknown feedback segment");
    byId.set(message.id, message);
  }
  const summary: EvidenceSummary = {
    accepted: [],
    segments: Object.fromEntries(SEGMENTS.map((segment) => [segment, { price: 0, other: 0 }])) as EvidenceSummary["segments"],
    intents: { cancel: 0, considering_cancel: 0, stay: 0 },
  };
  const seen = new Set<string>();
  for (const prediction of predictions) {
    const id = typeof prediction?.id === "string" ? prediction.id.trim() : undefined;
    if (id === undefined || !byId.has(id)) throw new Error("Unknown prediction ID");
    if (seen.has(id)) throw new Error("Prediction IDs must be unique");
    seen.add(id);
    const parsed = PredictionSchema.safeParse(prediction);
    if (!parsed.success || parsed.data.confidence < MIN_CONFIDENCE) continue;
    const accepted = parsed.data;
    summary.accepted.push(accepted);
    summary.segments[byId.get(id)!.segment][accepted.reason]++;
    summary.intents[accepted.intent]++;
  }
  return summary;
}

/** Replaces reason estimates on a copy; never accumulates cache hits or changes churn. */
export function applyEvidence(twin: MerchantTwin, messages: FeedbackMessage[], accepted: Prediction[]): MerchantTwin {
  const summary = summarizeEvidence(messages, accepted);
  const updated = structuredClone(twin);
  for (const segment of SEGMENTS) {
    const { price, other } = summary.segments[segment];
    if (price + other === 0) continue;
    updated.params.segments[segment].priceReasonShare = { alpha: 1 + price, beta: 1 + other };
    updated.provenance[`segments.${segment}.priceReasonShare`] = {
      source: "estimated", evidenceCount: price + other,
      note: "AI-classified synthetic feedback; reason counts within the known segment, not cancellation rates or causal discount effects.",
    };
  }
  return updated;
}

export const PILOT_INDICES = [0, 1, 2, 3] as const;
export type PilotIndex = (typeof PILOT_INDICES)[number];

export function indexPilots(messages: FeedbackMessage[]): Map<PilotIndex, FeedbackMessage> {
  const pilots = new Map<PilotIndex, FeedbackMessage>();
  for (const message of messages) {
    if (message.pilotIndex === undefined) continue;
    if (!PILOT_INDICES.includes(message.pilotIndex) || pilots.has(message.pilotIndex)) throw new Error("Pilot indices must be known and unique");
    pilots.set(message.pilotIndex, message);
  }
  return pilots;
}

export function isPilotEligible(message: FeedbackMessage, prediction: Pick<Prediction, "intent" | "reason"> | undefined): boolean {
  return message.segment === "cancel_intent" && prediction?.intent === "cancel" && prediction.reason === "price";
}

export interface PilotMappingIssue { pilotIndex: PilotIndex; cause: "missing_feedback" | "missing_mapping" | "ambiguous_mapping" }
export interface PilotEligibilityReport {
  eligibleSubscriptionIds: string[];
  pilots: { pilotIndex: PilotIndex; messageId?: string; subscriptionId?: string; eligible: boolean }[];
  issues: PilotMappingIssue[];
}

/** Callers supply current registry rows and PILOT_COHORT labels; no registry I/O here. */
export function pilotEligibility(messages: FeedbackMessage[], predictions: Prediction[], registry: readonly { label: string; subscriptionId: string }[], labels: readonly string[]): PilotEligibilityReport {
  const accepted = new Map(summarizeEvidence(messages, predictions).accepted.map((prediction) => [prediction.id, prediction]));
  const messagesByPilot = indexPilots(messages);
  const report: PilotEligibilityReport = { eligibleSubscriptionIds: [], pilots: [], issues: [] };
  for (const pilotIndex of PILOT_INDICES) {
    const message = messagesByPilot.get(pilotIndex);
    const label = labels[pilotIndex];
    const matches = label?.trim() ? registry.filter((row) => row.label === label) : [];
    const row = matches.length === 1 ? matches[0] : undefined;
    let cause: PilotMappingIssue["cause"] | undefined;
    if (!message) cause = "missing_feedback";
    else if ((!row && matches.length === 0) || (row && !row.subscriptionId.trim())) cause = "missing_mapping";
    else if (!row || labels.filter((candidate) => candidate === label).length !== 1 || registry.filter((candidate) => candidate.subscriptionId === row.subscriptionId).length !== 1) cause = "ambiguous_mapping";
    if (cause) report.issues.push({ pilotIndex, cause });
    const subscriptionId = !cause ? row!.subscriptionId : undefined;
    const eligible = !!subscriptionId && isPilotEligible(message!, accepted.get(message!.id));
    report.pilots.push({ pilotIndex, ...(message ? { messageId: message.id } : {}), ...(subscriptionId ? { subscriptionId } : {}), eligible });
    if (eligible) report.eligibleSubscriptionIds.push(subscriptionId!);
  }
  return report;
}

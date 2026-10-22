import type { ClassificationResult } from "./classify";
import { PredictionSchema, type FeedbackMessage, type GroundTruth, type Prediction } from "./contracts";
import { indexPilots, isPilotEligible, PILOT_INDICES, summarizeEvidence, type PilotIndex } from "./evidence";

type Intent = Prediction["intent"];
type Reason = Prediction["reason"];
type Confusion<T extends string> = Record<T, Record<T | "unclassified", number>>;
export interface Agreement { intent: number; reason: number; joint: number }
export interface PilotCheck {
  pilotIndex: PilotIndex;
  messageId?: string;
  expectedEligible: boolean;
  actualEligible: boolean;
  classified: boolean;
  correct: boolean;
}
export interface ClassificationScore {
  total: number;
  schemaValidCount: number;
  acceptedCount: number;
  unclassifiedCount: number;
  schemaValidRate: number;
  acceptedCoverage: number;
  acceptedAgreement: Agreement;
  wholeCorpusAgreement: Agreement;
  confusion: { intent: Confusion<Intent>; reason: Confusion<Reason> };
  pilotChecks: PilotCheck[];
  allPilotsCorrect: boolean;
  toolSmokePassed: boolean;
  suitable: boolean;
}

function confusion<T extends string>(labels: readonly T[]): Confusion<T> {
  return Object.fromEntries(labels.map((label) => [label, Object.fromEntries([...labels, "unclassified"].map((predicted) => [predicted, 0]))])) as Confusion<T>;
}
const rate = (numerator: number, denominator: number): number => denominator ? numerator / denominator : 0;

/** Hidden labels are supplied only here; unclassified feedback remains in every corpus denominator. */
export function scoreClassification(messages: FeedbackMessage[], truth: GroundTruth, result: Pick<ClassificationResult, "accepted" | "schemaValidCount">, toolSmokePassed: boolean): ClassificationScore {
  const { accepted } = summarizeEvidence(messages, result.accepted);
  const total = messages.length;
  if (!Number.isInteger(result.schemaValidCount) || result.schemaValidCount < accepted.length || result.schemaValidCount > total) throw new Error("Schema-valid count must be an integer between accepted count and corpus size");
  const labelSchema = PredictionSchema.pick({ intent: true, reason: true });
  if (Object.keys(truth).length !== total || messages.some(({ id }) => !Object.hasOwn(truth, id) || !labelSchema.safeParse(truth[id]).success)) throw new Error("Ground truth must contain exactly one valid label for every feedback ID");
  const byId = new Map(accepted.map((prediction) => [prediction.id, prediction]));
  const counts: Agreement = { intent: 0, reason: 0, joint: 0 };
  const matrix = { intent: confusion<Intent>(["cancel", "considering_cancel", "stay"]), reason: confusion<Reason>(["price", "other"]) };
  for (const { id } of messages) {
    const expected = truth[id];
    const actual = byId.get(id);
    matrix.intent[expected.intent][actual?.intent ?? "unclassified"]++;
    matrix.reason[expected.reason][actual?.reason ?? "unclassified"]++;
    if (actual?.intent === expected.intent) counts.intent++;
    if (actual?.reason === expected.reason) counts.reason++;
    if (actual?.intent === expected.intent && actual.reason === expected.reason) counts.joint++;
  }
  const agreement = (denominator: number): Agreement => ({ intent: rate(counts.intent, denominator), reason: rate(counts.reason, denominator), joint: rate(counts.joint, denominator) });
  const pilots = indexPilots(messages);
  const pilotChecks = PILOT_INDICES.map((pilotIndex): PilotCheck => {
    const message = pilots.get(pilotIndex);
    const actual = message ? byId.get(message.id) : undefined;
    const expected = message ? truth[message.id] : undefined;
    return {
      pilotIndex, ...(message ? { messageId: message.id } : {}), classified: !!actual,
      expectedEligible: !!message && isPilotEligible(message, expected),
      actualEligible: !!message && isPilotEligible(message, actual),
      correct: !!actual && actual.intent === expected?.intent && actual.reason === expected.reason,
    };
  });
  const schemaValidRate = rate(result.schemaValidCount, total);
  const acceptedCoverage = rate(accepted.length, total);
  const wholeCorpusAgreement = agreement(total);
  const allPilotsCorrect = pilotChecks.every(({ correct }) => correct);
  return {
    total, schemaValidCount: result.schemaValidCount, acceptedCount: accepted.length, unclassifiedCount: total - accepted.length,
    schemaValidRate, acceptedCoverage, acceptedAgreement: agreement(accepted.length), wholeCorpusAgreement,
    confusion: matrix, pilotChecks, allPilotsCorrect, toolSmokePassed,
    suitable: schemaValidRate >= 0.95 && acceptedCoverage >= 0.9 && wholeCorpusAgreement.joint >= 0.9 && allPilotsCorrect && toolSmokePassed,
  };
}

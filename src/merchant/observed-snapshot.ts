import { z } from "zod";
import { SEGMENTS, type MerchantTwin } from "@/twin/types";
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { ParameterChange } from "@/twin/calibrate";
import type { ComparisonResult } from "@/twin/simulate";

const count = z.number().finite().int().nonnegative();
const exposure = z.number().finite().nonnegative();
const text = z.string().max(16_384);
const estimate = z.object({ mean: z.number().finite(), sd: z.number().finite().nonnegative() });
const change = z.object({ parameter: text, before: estimate, after: estimate, evidence: text });
/** Annual offers are separate evidence with their own limitation. */
export const AnnualEvidenceSchema = z.object({
  offers: z.array(z.object({ segment: z.enum(SEGMENTS), accepted: count, declined: count, unresolved: count })).max(SEGMENTS.length),
  changes: z.array(change).max(SEGMENTS.length),
  limitation: text,
});
export const ObservedSnapshotSchema = z.object({
  evidence: z.object({ episodes: count, cancellations: count, censoredEpisodes: count, subscriberMonths: exposure, posteriorSubscriberMonths: exposure, posteriorCancellations: count, limitation: text }),
  /** Discount effect changes only: one per leaving reason. */
  changes: z.array(change).max(2),
  /** Annual offers are separate evidence with their own limitation. Optional so earlier recorded runs stay valid. */
  annual: AnnualEvidenceSchema.optional(),
  provenance: z.record(z.string(), z.object({ source: z.enum(["estimated", "assumption", "observed"]), note: text, evidenceCount: exposure.optional() })),
});
export type ObservedSnapshot = z.infer<typeof ObservedSnapshotSchema>;
export type AnnualEvidence = NonNullable<ObservedSnapshot["annual"]>;
export type ObservedComparison = ComparisonResult & { observedSnapshot: ObservedSnapshot };

/** Safe bounded-size aggregate for the exact twin used by one comparison/run. No per-episode or per-offer rows, and no links. */
export function toObservedSnapshot(view: { twin: MerchantTwin; evidence: DiscountEvidence; changes: ParameterChange[]; annual?: AnnualEvidence }): ObservedSnapshot {
  return ObservedSnapshotSchema.parse({ evidence: view.evidence, changes: view.changes, ...(view.annual ? { annual: view.annual } : {}), provenance: view.twin.provenance });
}

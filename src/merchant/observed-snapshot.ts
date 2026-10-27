import { z } from "zod";
import type { MerchantTwin } from "@/twin/types";
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { ParameterChange } from "@/twin/calibrate";
import type { ComparisonResult } from "@/twin/simulate";

const count = z.number().finite().int().nonnegative();
const exposure = z.number().finite().nonnegative();
const text = z.string().max(16_384);
const estimate = z.object({ mean: z.number().finite(), sd: z.number().finite().nonnegative() });
export const ObservedSnapshotSchema = z.object({
  evidence: z.object({ episodes: count, cancellations: count, censoredEpisodes: count, subscriberMonths: exposure, posteriorSubscriberMonths: exposure, posteriorCancellations: count, limitation: text }),
  changes: z.array(z.object({ parameter: text, before: estimate, after: estimate, evidence: text })).max(2),
  provenance: z.record(z.string(), z.object({ source: z.enum(["estimated", "assumption", "observed"]), note: text, evidenceCount: exposure.optional() })),
});
export type ObservedSnapshot = z.infer<typeof ObservedSnapshotSchema>;
export type ObservedComparison = ComparisonResult & { observedSnapshot: ObservedSnapshot };

/** Safe bounded-size aggregate for the exact twin used by one comparison/run. No per-episode rows. */
export function toObservedSnapshot(view: { twin: MerchantTwin; evidence: DiscountEvidence; changes: ParameterChange[] }): ObservedSnapshot {
  return ObservedSnapshotSchema.parse({ evidence: view.evidence, changes: view.changes, provenance: view.twin.provenance });
}

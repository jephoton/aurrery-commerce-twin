import "server-only";
import type { ReasonId, SegmentId } from "@/twin/types";
import type { DiscountOutcomeObservation } from "@/twin/calibrate";
import { runtimeLedgerConnection, type LedgerConnection } from "./connection";
import { authoritativeWrite } from "./operations";
import { sameUsdAmount } from "@/paypal/prices";

export const SUBSCRIBER_MONTH_MS = 30 * 86_400_000;
export const OUTCOME_LIMITATION = "Observational evidence with an assumed counterfactual; selection and censoring limit interpretation. PayPal cancellation facts prove neither voluntary intent nor discounted price. Ambiguous cancellation episodes (including prior survival) are excluded from calibration. No causal retention claim.";
export interface DiscountEpisode {
  executionId: number; subscriptionId: string; segment: SegmentId; reason: ReasonId;
  startedAt: string; endsAt: string; discountedPrice: string;
}
export interface DiscountFact { subscriptionId: string; observedAt: string; status: string; regularPrice: string | null }
export interface DiscountEvidence {
  episodes: number; cancellations: number; censoredEpisodes: number; subscriberMonths: number;
  posteriorSubscriberMonths: number; posteriorCancellations: number; observations: DiscountOutcomeObservation[]; limitation: string;
}

/** Rebuild from occurrence order; neither delivery order nor repeated polling adds trials. */
export function deriveDiscountOutcomes(episodes: DiscountEpisode[], facts: DiscountFact[], now: string): DiscountEvidence {
  const evidence: DiscountEvidence = { episodes: episodes.length, cancellations: 0, censoredEpisodes: 0, subscriberMonths: 0, posteriorSubscriberMonths: 0, posteriorCancellations: 0, observations: [], limitation: OUTCOME_LIMITATION };
  const ordered = [...episodes].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.executionId - b.executionId);
  const timely = facts.filter(f => Date.parse(f.observedAt) <= Date.parse(now));
  const transitions = new Set<string>();
  const previous = new Map<string, { status: string; time: number }>();
  const key = (f: DiscountFact) => `${f.subscriptionId}\0${Date.parse(f.observedAt)}`;
  for (const f of [...timely].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Number(b.status === "CANCELLED") - Number(a.status === "CANCELLED"))) {
    if (!["ACTIVE", "CANCELLED", "SUSPENDED", "EXPIRED", "APPROVED", "APPROVAL_PENDING"].includes(f.status)) continue;
    const prior = previous.get(f.subscriptionId), time = Date.parse(f.observedAt);
    if (prior?.time === time) continue;
    if (f.status === "CANCELLED" && prior?.status !== "CANCELLED") transitions.add(key(f));
    previous.set(f.subscriptionId, { status: f.status, time });
  }
  for (const [index, episode] of ordered.entries()) {
    const start = Date.parse(episode.startedAt);
    const next = ordered.slice(index + 1).find(e => e.subscriptionId === episode.subscriptionId);
    const nextStart = next ? Date.parse(next.startedAt) : Infinity;
    const end = Math.min(Date.parse(episode.endsAt), Date.parse(now), nextStart);
    if (end <= start) continue;
    const matched = (f: DiscountFact) => f.status === "ACTIVE" && sameUsdAmount(f.regularPrice, episode.discountedPrice);
    const priority = (f: DiscountFact) => f.status === "CANCELLED" ? 0 : matched(f) ? 2 : 1;
    const orderedFacts = [...timely].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || priority(a) - priority(b));
    let through = start, stopped = false, closed = false, cancelled = false;
    for (const f of orderedFacts) {
      const time = Date.parse(f.observedAt);
      if (f.subscriptionId !== episode.subscriptionId || time < start || time >= nextStart) continue;
      // Cancellations within the approved window are ambiguous even after the last positive read.
      if (closed) continue;
      if (time <= end && f.status === "CANCELLED" && transitions.has(key(f))) cancelled = true;
      if ((f.regularPrice !== null && !sameUsdAmount(f.regularPrice, episode.discountedPrice)) || f.status === "EXPIRED") closed = true;
      if (stopped) continue;
      if (f.status === "PAYMENT_COMPLETED") continue;
      if (!matched(f)) { stopped = true; continue; }
      through = Math.max(through, Math.min(time, end));
    }
    const months = Math.max(0, through - start) / SUBSCRIBER_MONTH_MS;
    evidence.subscriberMonths += months;
    if (cancelled) { evidence.cancellations++; evidence.censoredEpisodes++; continue; }
    if (months > 0) evidence.observations.push({ segment: episode.segment, reason: episode.reason, subscriberMonths: months, cancellations: 0 });
    evidence.posteriorSubscriberMonths += months;
  }
  return evidence;
}

/** One consistent authority snapshot; no historical episodes are inferred from old executions. */
export async function readDiscountOutcomes(connection?: LedgerConnection, now = new Date().toISOString()): Promise<DiscountEvidence> {
  return authoritativeWrite(connection ?? await runtimeLedgerConnection(), async tx => {
    const rows = await tx.query("SELECT * FROM discount_episodes ORDER BY started_at,execution_id");
    const facts = await tx.query("SELECT subscription_id,observed_at,status,regular_price FROM observations WHERE source IN ('paypal.status','paypal.get_subscription','paypal.webhook','paypal.execution_preread') ORDER BY observed_at,id");
    return deriveDiscountOutcomes(rows.map(r => ({ executionId: Number(r.execution_id), subscriptionId: String(r.subscription_id), segment: r.segment as SegmentId, reason: r.reason as ReasonId, startedAt: String(r.started_at), endsAt: String(r.ends_at), discountedPrice: String(r.discounted_price) })), facts.map(r => ({ subscriptionId: String(r.subscription_id), observedAt: String(r.observed_at), status: String(r.status), regularPrice: r.regular_price === null ? null : String(r.regular_price) })), now);
  });
}

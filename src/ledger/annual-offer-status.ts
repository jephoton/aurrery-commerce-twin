import { SEGMENTS, type SegmentId } from "@/twin/types";

// An offer's status is derived from recorded PayPal reads, never stored as truth. A switch counts
// only when PayPal reads the subscription back ACTIVE on the offered annual plan.

export type OfferStatus = "pending" | "switched" | "expired";
export interface OfferFacts { annualPlanId: string; expiresAt: string }
export interface OfferRead { observedAt: string; status: string; planId: string | null }

export function offerStatus(offer: OfferFacts, reads: OfferRead[], now: Date): { status: OfferStatus; resolvedAt: string | null } {
  const switched = reads
    .filter((r) => r.status === "ACTIVE" && r.planId === offer.annualPlanId && !Number.isNaN(Date.parse(r.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
  if (switched) return { status: "switched", resolvedAt: switched.observedAt };
  // Fail closed: an unparseable deadline must not mean "never expires".
  if (Number.isNaN(Date.parse(offer.expiresAt))) return { status: "expired", resolvedAt: null };
  if (now.getTime() >= Date.parse(offer.expiresAt)) return { status: "expired", resolvedAt: offer.expiresAt };
  return { status: "pending", resolvedAt: null };
}

/** The earlier of the merchant's offer window and any expiry PayPal attaches to the approval link. */
export function offerExpiry(offeredAt: string, windowDays: number, paypalExpiresAt?: string | null): string {
  const window = Date.parse(offeredAt) + windowDays * 86_400_000;
  const paypal = paypalExpiresAt ? Date.parse(paypalExpiresAt) : Number.POSITIVE_INFINITY;
  return new Date(Math.min(window, paypal)).toISOString();
}

export interface SegmentOfferCounts { segment: SegmentId; accepted: number; expired: number; pending: number }

export function countResolvedOffers(offers: { segment: SegmentId; status: OfferStatus }[]): SegmentOfferCounts[] {
  return SEGMENTS
    .map((segment) => {
      const own = offers.filter((o) => o.segment === segment);
      return {
        segment,
        accepted: own.filter((o) => o.status === "switched").length,
        expired: own.filter((o) => o.status === "expired").length,
        pending: own.filter((o) => o.status === "pending").length,
      };
    })
    .filter((c) => c.accepted + c.expired + c.pending > 0);
}

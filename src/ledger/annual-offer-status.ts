import { SEGMENTS, type SegmentId } from "@/twin/types";

// An offer's status is derived from recorded PayPal reads, never stored as truth. A switch counts
// only when PayPal reads the subscription back ACTIVE on the offered annual plan. "Expired" is a UI
// state, not evidence: only a confirmed read after a grace period counts as a decline.

export type OfferStatus = "pending" | "switched" | "expired" | "invalid";
export type OfferOutcome = "accepted" | "declined" | "unresolved";
export interface OfferFacts { annualPlanId: string; expiresAt: string }
export interface OfferRead { observedAt: string; status: string; planId: string | null }

/** Reads happen on page loads and PayPal can lag, so a decline needs a read this long after the deadline. */
export const DECLINE_GRACE_MS = 6 * 3_600_000;

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO-8601 instant: date-time with `Z` or a ±HH:MM offset. Returns epoch ms, or null if invalid. */
export function parseIsoInstant(value: string): number | null {
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function offerStatus(offer: OfferFacts, reads: OfferRead[], now: Date): { status: OfferStatus; resolvedAt: string | null } {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError("Invalid now");
  const switched = reads
    .flatMap((r) => {
      const at = parseIsoInstant(r.observedAt);
      return r.status === "ACTIVE" && r.planId === offer.annualPlanId && at !== null ? [{ at, observedAt: r.observedAt }] : [];
    })
    .sort((a, b) => a.at - b.at || (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))[0];
  if (switched) return { status: "switched", resolvedAt: switched.observedAt };
  const expiresMs = parseIsoInstant(offer.expiresAt);
  if (expiresMs === null) return { status: "invalid", resolvedAt: null };
  if (nowMs >= expiresMs) return { status: "expired", resolvedAt: offer.expiresAt };
  return { status: "pending", resolvedAt: null };
}

/**
 * Learning outcome. Declined only when the grace period after the deadline has elapsed AND a valid
 * read taken at or after that point shows the subscription is not on the annual plan (any status,
 * including CANCELLED). Anything else that has not switched is unresolved.
 */
export function offerOutcome(offer: OfferFacts, reads: OfferRead[], now: Date): OfferOutcome {
  const { status } = offerStatus(offer, reads, now);
  if (status === "switched") return "accepted";
  if (status !== "expired") return "unresolved";
  const confirmFrom = (parseIsoInstant(offer.expiresAt) as number) + DECLINE_GRACE_MS;
  if (now.getTime() < confirmFrom) return "unresolved";
  const confirmed = reads.some((r) => {
    const at = parseIsoInstant(r.observedAt);
    return at !== null && at >= confirmFrom && r.planId !== offer.annualPlanId;
  });
  return confirmed ? "declined" : "unresolved";
}

/** True while PayPal should still be read: pending, or expired without a confirmed outcome. */
export function needsRead(offer: OfferFacts, reads: OfferRead[], now: Date): boolean {
  const { status } = offerStatus(offer, reads, now);
  if (status === "pending") return true;
  return status === "expired" && offerOutcome(offer, reads, now) === "unresolved";
}

/** The earlier of the merchant's offer window and any expiry PayPal attaches to the approval link. */
export function offerExpiry(offeredAt: string, windowDays: number, paypalExpiresAt?: string | null): string {
  const offeredMs = parseIsoInstant(offeredAt);
  if (offeredMs === null) throw new RangeError("Invalid offeredAt: expected an ISO-8601 instant with Z or an offset");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    throw new RangeError("Invalid windowDays: expected an integer from 1 to 30");
  }
  let expiry = offeredMs + windowDays * 86_400_000;
  if (paypalExpiresAt !== undefined && paypalExpiresAt !== null) {
    const paypalMs = parseIsoInstant(paypalExpiresAt);
    if (paypalMs === null) throw new RangeError("Invalid paypalExpiresAt: expected an ISO-8601 instant with Z or an offset");
    if (paypalMs <= offeredMs) throw new RangeError("Invalid paypalExpiresAt: must be after offeredAt");
    expiry = Math.min(expiry, paypalMs);
  }
  return new Date(expiry).toISOString();
}

/** Segments with no offers are omitted; consumers treat a missing segment as all zeros. */
export interface SegmentOfferCounts { segment: SegmentId; accepted: number; declined: number; unresolved: number }

export function countResolvedOffers(offers: { segment: SegmentId; outcome: OfferOutcome }[]): SegmentOfferCounts[] {
  return SEGMENTS
    .map((segment) => {
      const own = offers.filter((o) => o.segment === segment);
      return {
        segment,
        accepted: own.filter((o) => o.outcome === "accepted").length,
        declined: own.filter((o) => o.outcome === "declined").length,
        unresolved: own.filter((o) => o.outcome === "unresolved").length,
      };
    })
    .filter((c) => c.accepted + c.declined + c.unresolved > 0);
}

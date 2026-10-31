import { describe, expect, it } from "vitest";
import {
  DECLINE_GRACE_MS,
  countResolvedOffers,
  needsRead,
  offerExpiry,
  offerOutcome,
  offerStatus,
  parseIsoInstant,
} from "./annual-offer-status";

const offer = { annualPlanId: "P-ANNUAL", expiresAt: "2026-11-08T00:00:00.000Z" };
const corrupt = { annualPlanId: "P-ANNUAL", expiresAt: "garbage" };
const read = (observedAt: string, status: string, planId: string | null) => ({ observedAt, status, planId });
const afterGrace = "2026-11-08T06:00:00.000Z";

describe("parseIsoInstant", () => {
  it("accepts ISO-8601 date-times with Z or an offset", () => {
    expect(parseIsoInstant("2026-11-03T00:00:00Z")).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(parseIsoInstant("2026-11-03T00:00:00.123Z")).toBe(Date.parse("2026-11-03T00:00:00.123Z"));
    expect(parseIsoInstant("2026-11-03T08:00+08:00")).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(parseIsoInstant("2026-11-03T08:00:00-05:00")).toBe(Date.parse("2026-11-03T13:00:00Z"));
  });
  it("rejects strings with no zone, other formats and impossible dates", () => {
    expect(parseIsoInstant("2026-11-03T00:00:00")).toBeNull();
    expect(parseIsoInstant("11/03/2026")).toBeNull();
    expect(parseIsoInstant("2026-11-03")).toBeNull();
    expect(parseIsoInstant("not-a-date")).toBeNull();
    expect(parseIsoInstant("")).toBeNull();
    expect(parseIsoInstant("2026-13-45T00:00:00Z")).toBeNull();
  });
});

describe("annual offer status", () => {
  it("is pending until a switch is observed or the offer expires", () => {
    expect(offerStatus(offer, [read("2026-11-02T00:00:00Z", "ACTIVE", "P-MONTHLY")], new Date("2026-11-03T00:00:00Z"))).toEqual({ status: "pending", resolvedAt: null });
  });
  it("is switched at the first ACTIVE read on the annual plan", () => {
    const reads = [read("2026-11-04T00:00:00Z", "ACTIVE", "P-ANNUAL"), read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-05T00:00:00Z"))).toEqual({ status: "switched", resolvedAt: "2026-11-03T00:00:00Z" });
  });
  it("ignores annual-plan reads that are not ACTIVE", () => {
    expect(offerStatus(offer, [read("2026-11-03T00:00:00Z", "APPROVAL_PENDING", "P-ANNUAL")], new Date("2026-11-04T00:00:00Z")).status).toBe("pending");
  });
  it("is switched when an APPROVAL_PENDING read is followed by an ACTIVE read on the annual plan", () => {
    const reads = [read("2026-11-03T00:00:00Z", "APPROVAL_PENDING", "P-ANNUAL"), read("2026-11-03T00:05:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-04T00:00:00Z"))).toEqual({ status: "switched", resolvedAt: "2026-11-03T00:05:00Z" });
  });
  it("does not count a lowercase status", () => {
    expect(offerStatus(offer, [read("2026-11-03T00:00:00Z", "active", "P-ANNUAL")], new Date("2026-11-04T00:00:00Z")).status).toBe("pending");
  });
  it("is expired at the deadline, and a later observed switch still wins", () => {
    expect(offerStatus(offer, [], new Date("2026-11-08T00:00:00Z"))).toEqual({ status: "expired", resolvedAt: offer.expiresAt });
    expect(offerStatus(offer, [read("2026-11-09T00:00:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-10T00:00:00Z")).status).toBe("switched");
  });
  it("is still pending one millisecond before the deadline", () => {
    expect(offerStatus(offer, [], new Date("2026-11-07T23:59:59.999Z")).status).toBe("pending");
  });
  it("breaks ties between equal instants by the observedAt string", () => {
    const reads = [read("2026-11-03T08:00:00+08:00", "ACTIVE", "P-ANNUAL"), read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-04T00:00:00Z")).resolvedAt).toBe("2026-11-03T00:00:00Z");
  });
  it("does not count a read with an unparseable or zoneless timestamp as a switch", () => {
    for (const bad of ["not-a-date", "2026-11-03T00:00:00", "11/03/2026"]) {
      expect(offerStatus(offer, [read(bad, "ACTIVE", "P-ANNUAL")], new Date("2026-11-04T00:00:00Z"))).toEqual({ status: "pending", resolvedAt: null });
    }
  });
  it("still finds the valid switch when an invalid read is present", () => {
    const reads = [read("not-a-date", "ACTIVE", "P-ANNUAL"), read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-04T00:00:00Z"))).toEqual({ status: "switched", resolvedAt: "2026-11-03T00:00:00Z" });
  });
  it("is invalid when the deadline cannot be parsed, but a switch still wins", () => {
    expect(offerStatus(corrupt, [], new Date("2026-11-03T00:00:00Z"))).toEqual({ status: "invalid", resolvedAt: null });
    expect(offerStatus({ ...corrupt, expiresAt: "2026-11-08T00:00:00" }, [], new Date("2026-11-03T00:00:00Z")).status).toBe("invalid");
    expect(offerStatus(corrupt, [read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-04T00:00:00Z")).status).toBe("switched");
  });
  it("throws when now is invalid", () => {
    expect(() => offerStatus(offer, [], new Date(Number.NaN))).toThrow(new RangeError("Invalid now"));
  });
});

describe("offerExpiry", () => {
  it("expires at the earlier of the offer window and the PayPal link expiry", () => {
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7)).toBe("2026-11-08T00:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-11-01T03:00:00.000Z")).toBe("2026-11-01T03:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-12-01T00:00:00.000Z")).toBe("2026-11-08T00:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, null)).toBe("2026-11-08T00:00:00.000Z");
  });
  it("rejects invalid inputs with a clear RangeError per cause", () => {
    expect(() => offerExpiry("garbage", 7)).toThrow(/offeredAt/);
    expect(() => offerExpiry("2026-11-01T00:00:00", 7)).toThrow(RangeError);
    for (const days of [0, 31, 1.5, Number.NaN]) {
      expect(() => offerExpiry("2026-11-01T00:00:00.000Z", days)).toThrow(/windowDays/);
    }
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", 7, "garbage")).toThrow(/paypalExpiresAt/);
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", 7, "")).toThrow(/paypalExpiresAt/);
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-10-31T00:00:00.000Z")).toThrow(/paypalExpiresAt/);
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-11-01T00:00:00.000Z")).toThrow(RangeError);
  });
});

describe("offerOutcome and needsRead", () => {
  const monthly = (at: string, status = "ACTIVE") => read(at, status, "P-MONTHLY");

  it("uses a six hour grace", () => {
    expect(DECLINE_GRACE_MS).toBe(6 * 3_600_000);
  });
  it("is accepted when switched, even after the deadline", () => {
    expect(offerOutcome(offer, [read("2026-11-09T00:00:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-10T00:00:00Z"))).toBe("accepted");
  });
  it("is unresolved while pending", () => {
    expect(offerOutcome(offer, [monthly("2026-11-03T00:00:00Z")], new Date("2026-11-04T00:00:00Z"))).toBe("unresolved");
  });
  it("is unresolved when expired with no confirming read", () => {
    expect(offerOutcome(offer, [], new Date("2026-11-20T00:00:00Z"))).toBe("unresolved");
  });
  it("is unresolved when the only reads predate the grace boundary", () => {
    expect(offerOutcome(offer, [monthly("2026-11-08T05:59:59.999Z")], new Date("2026-11-20T00:00:00Z"))).toBe("unresolved");
  });
  it("is declined with a post-grace read still on the monthly plan", () => {
    expect(offerOutcome(offer, [monthly(afterGrace)], new Date("2026-11-08T07:00:00Z"))).toBe("declined");
  });
  it("is declined with a post-grace CANCELLED read", () => {
    expect(offerOutcome(offer, [monthly(afterGrace, "CANCELLED")], new Date("2026-11-08T07:00:00Z"))).toBe("declined");
  });
  it("is unresolved before the grace elapses, even with reads", () => {
    expect(offerOutcome(offer, [monthly("2026-11-08T03:00:00Z")], new Date("2026-11-08T05:00:00Z"))).toBe("unresolved");
    expect(offerOutcome(offer, [monthly(afterGrace)], new Date("2026-11-08T05:59:59.999Z"))).toBe("unresolved");
  });
  it("does not treat a post-grace read with a null planId as a decline", () => {
    expect(offerOutcome(offer, [read(afterGrace, "ACTIVE", null)], new Date("2026-11-20T00:00:00Z"))).toBe("unresolved");
    expect(needsRead(offer, [read(afterGrace, "ACTIVE", null)], new Date("2026-11-20T00:00:00Z"))).toBe(true);
  });
  it("ignores unparseable reads as confirmation", () => {
    expect(offerOutcome(offer, [monthly("2026-11-09T00:00:00")], new Date("2026-11-20T00:00:00Z"))).toBe("unresolved");
  });
  it("is unresolved for an invalid deadline", () => {
    expect(offerOutcome(corrupt, [monthly(afterGrace)], new Date("2026-11-20T00:00:00Z"))).toBe("unresolved");
  });
  it("needsRead is a truth table over pending, switched, invalid, unconfirmed and declined", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(needsRead(offer, [], new Date("2026-11-03T00:00:00Z"))).toBe(true); // pending
    expect(needsRead(offer, [read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")], now)).toBe(false); // switched
    expect(needsRead(corrupt, [], now)).toBe(true); // invalid: a real switch can still be observed
    expect(needsRead(offer, [], now)).toBe(true); // expired, unconfirmed
    expect(needsRead(offer, [monthly("2026-11-08T01:00:00Z")], now)).toBe(true); // expired, pre-grace read only
    expect(needsRead(offer, [monthly(afterGrace)], now)).toBe(false); // declined
  });
});

describe("countResolvedOffers", () => {
  it("counts outcomes per segment in SEGMENTS order and omits empty segments", () => {
    expect(countResolvedOffers([
      { segment: "price_sensitive", outcome: "declined" },
      { segment: "core", outcome: "accepted" },
      { segment: "core", outcome: "declined" },
      { segment: "core", outcome: "unresolved" },
    ])).toEqual([
      { segment: "core", accepted: 1, declined: 1, unresolved: 1 },
      { segment: "price_sensitive", accepted: 0, declined: 1, unresolved: 0 },
    ]);
  });
  it("returns an empty list for no offers", () => {
    expect(countResolvedOffers([])).toEqual([]);
  });
});

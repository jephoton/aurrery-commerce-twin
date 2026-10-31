import { describe, expect, it } from "vitest";
import { countResolvedOffers, offerExpiry, offerStatus } from "./annual-offer-status";

const offer = { annualPlanId: "P-ANNUAL", expiresAt: "2026-11-08T00:00:00.000Z" };
const read = (observedAt: string, status: string, planId: string | null) => ({ observedAt, status, planId });

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
  it("expires at the deadline, but a later observed switch still counts", () => {
    expect(offerStatus(offer, [], new Date("2026-11-08T00:00:00Z"))).toEqual({ status: "expired", resolvedAt: offer.expiresAt });
    expect(offerStatus(offer, [read("2026-11-09T00:00:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-10T00:00:00Z")).status).toBe("switched");
  });
  it("expires at the earlier of the offer window and PayPal's link expiry", () => {
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7)).toBe("2026-11-08T00:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-11-01T03:00:00.000Z")).toBe("2026-11-01T03:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-12-01T00:00:00.000Z")).toBe("2026-11-08T00:00:00.000Z");
  });
  it("counts resolved offers per segment and ignores pending ones", () => {
    expect(countResolvedOffers([
      { segment: "core", status: "switched" }, { segment: "core", status: "expired" },
      { segment: "core", status: "pending" }, { segment: "price_sensitive", status: "expired" },
    ])).toEqual([
      { segment: "core", accepted: 1, expired: 1, pending: 1 },
      { segment: "price_sensitive", accepted: 0, expired: 1, pending: 0 },
    ]);
  });
});

describe("annual offer status on invalid timestamps", () => {
  it("does not count a read with an unparseable timestamp as a switch", () => {
    expect(offerStatus(offer, [read("not-a-date", "ACTIVE", "P-ANNUAL")], new Date("2026-11-03T00:00:00Z"))).toEqual({ status: "pending", resolvedAt: null });
  });
  it("still finds the valid switch when an invalid read is present", () => {
    const reads = [read("not-a-date", "ACTIVE", "P-ANNUAL"), read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-04T00:00:00Z"))).toEqual({ status: "switched", resolvedAt: "2026-11-03T00:00:00Z" });
  });
  it("treats an unparseable deadline as expired rather than never expiring", () => {
    expect(offerStatus({ annualPlanId: "P-ANNUAL", expiresAt: "garbage" }, [], new Date("2026-11-03T00:00:00Z"))).toEqual({ status: "expired", resolvedAt: null });
  });
  it("throws instead of returning a bogus expiry for invalid inputs", () => {
    expect(() => offerExpiry("garbage", 7)).toThrow(RangeError);
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", Number.NaN)).toThrow(RangeError);
    expect(() => offerExpiry("2026-11-01T00:00:00.000Z", 7, "garbage")).toThrow(RangeError);
  });
});

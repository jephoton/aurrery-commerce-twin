import { expect, it } from "vitest";
import { draftAnnualOfferMessage } from "./annual-offer-message";

const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST0000000001";
const input = { merchantName: "Ridgeline Roasters", planName: "Roaster's Choice (monthly)", annualPrice: "244.80", discountPct: 15, expiresAt: "2026-11-08T00:00:00.000Z", approvalUrl: LINK };

it("drafts a consent message with the yearly price, renewal timing, window and link", () => {
  const text = draftAnnualOfferMessage(input);
  expect(text).toContain("Ridgeline Roasters");
  expect(text).toContain("$244.80 a year");
  expect(text).toContain("15% less than twelve monthly payments");
  expect(text).toContain("Nothing changes unless you agree in PayPal");
  expect(text).toContain("charged from your next renewal date");
  expect(text).toContain("open until November 8, 2026, 12:00 AM UTC.");
  expect(text.endsWith(LINK)).toBe(true);
});

it("states the exact closing time in UTC, not just the date", () => {
  const at = (expiresAt: string) => draftAnnualOfferMessage({ ...input, expiresAt });
  expect(at("2026-11-08T15:14:00.000Z")).toContain("open until November 8, 2026, 3:14 PM UTC.");
  expect(at("2026-11-08T23:59:59.000Z")).toContain("November 8, 2026, 11:59 PM UTC.");
  expect(at("2026-11-08T12:05:00.000Z")).toContain("November 8, 2026, 12:05 PM UTC.");
});

it("converts an offset deadline to UTC", () => {
  expect(draftAnnualOfferMessage({ ...input, expiresAt: "2026-11-08T23:30:00+08:00" })).toContain("November 8, 2026, 3:30 PM UTC.");
});

it("renders a fractional discount as given", () => {
  expect(draftAnnualOfferMessage({ ...input, discountPct: 12.5 })).toContain("12.5% less than twelve monthly payments");
});

it("never claims the link stops working", () => {
  expect(draftAnnualOfferMessage(input)).not.toMatch(/dead|expire|stop[s]? working|no longer work/i);
});

it.each(["soon", "Nov 8 2026", "2026-11-08", "2026-02-30T00:00:00.000Z", "2026-11-08T25:00:00.000Z", "2026-11-08T00:00:00"])(
  "refuses the deadline %j", (expiresAt) => {
    expect(() => draftAnnualOfferMessage({ ...input, expiresAt })).toThrow(RangeError);
  });

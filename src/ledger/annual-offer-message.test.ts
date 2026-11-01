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
  expect(text).toContain("November 8, 2026 (UTC)");
  expect(text.endsWith(LINK)).toBe(true);
});

it("states the deadline in UTC whatever the server's time zone", () => {
  expect(draftAnnualOfferMessage({ ...input, expiresAt: "2026-11-08T23:59:59.000Z" })).toContain("November 8, 2026 (UTC)");
});

it("never claims the link stops working", () => {
  expect(draftAnnualOfferMessage(input)).not.toMatch(/dead|expire|stop[s]? working|no longer work/i);
});

it("refuses an unparseable deadline", () => {
  expect(() => draftAnnualOfferMessage({ ...input, expiresAt: "soon" })).toThrow(RangeError);
});

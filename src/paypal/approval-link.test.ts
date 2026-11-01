import { expect, it } from "vitest";
import { isPayPalApprovalUrl } from "./approval-link";

it.each([
  ["https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST", true],
  ["https://paypal.com/approve", true],
  ["http://www.paypal.com/approve", false],
  ["https://notpaypal.com/approve", false],
  ["https://evil.example/approve", false],
  ["not a url", false],
])("treats %s as a PayPal approval link: %s", (href, expected) => {
  expect(isPayPalApprovalUrl(href)).toBe(expected);
});

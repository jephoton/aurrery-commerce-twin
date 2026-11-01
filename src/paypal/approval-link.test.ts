import { expect, it } from "vitest";
import { isPayPalApprovalUrl } from "./approval-link";

it.each([
  ["https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST", true],
  ["https://paypal.com/approve", true],
  ["http://www.paypal.com/approve", false],
  ["https://notpaypal.com/approve", false],
  ["https://evil.example/approve", false],
  ["not a url", false],
  ["https://paypal.com:8443/a", false],
  ["https://www.paypal.com:443/a", true],
  ["https://user:pw@www.paypal.com/a", false],
  ["https://evil.com@paypal.com/a", false],
  ["https://paypal.com@evil.com/a", false],
  ["https://paypal.com.evil.com/a", false],
  ["https://WWW.PAYPAL.COM/a", true],
  ["https://www.paypal.com./a", false],
  [" https://www.paypal.com/a", false],
  ["https://www.paypal.com/a ", false],
])("treats %s as a PayPal approval link: %s", (href, expected) => {
  expect(isPayPalApprovalUrl(href)).toBe(expected);
});

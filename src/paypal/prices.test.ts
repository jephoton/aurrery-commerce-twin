import { expect, it } from "vitest";
import { sameUsdAmount, usdCents } from "./prices";

it("compares strict USD decimal strings by cents across equivalent PayPal formatting", () => {
  expect(usdCents("24")).toBe(2400);
  expect(usdCents("24.0")).toBe(2400);
  expect(usdCents("24.00")).toBe(2400);
  expect(usdCents("0.01")).toBe(1);
  expect(sameUsdAmount("18.0", "18.00")).toBe(true);
  expect(sameUsdAmount("24", "24.00")).toBe(true);
  expect(sameUsdAmount("18.01", "18.00")).toBe(false);
});

it.each(["", " 24.00", "24.00 ", "24.000", "24e0", "Infinity", "NaN", "-1", "1.2.0", "9007199254740992"])("rejects malformed or unsafe USD amount %s", (value) => {
  expect(usdCents(value)).toBeNull();
  expect(sameUsdAmount(value, "24.00")).toBe(false);
});

it("does not coerce null or numeric observations into a price", () => {
  expect(usdCents(null)).toBeNull();
  expect(usdCents(24)).toBeNull();
  expect(sameUsdAmount(null, "0.00")).toBe(false);
});

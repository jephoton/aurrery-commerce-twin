import { describe, expect, it } from "vitest";
import { ApiError, ResponseValidationError } from "@paypal/paypal-server-sdk";
import { toFailure } from "./client";

const request = { method: "POST", url: "https://api-m.sandbox.paypal.com/x" } as never;

describe("toFailure", () => {
  it("maps an ApiError body to name, status, debug id and details", () => {
    const body = JSON.stringify({ name: "PLAN_PRODUCT_NOT_COMPATIBLE", message: "nope", debug_id: "dbg-body", details: [{ issue: "X" }] });
    const e = new ApiError({ request, response: { statusCode: 422, headers: { "paypal-debug-id": "dbg-header" }, body } } as never, "Unprocessable");
    expect(toFailure(e)).toEqual({ httpStatus: 422, name: "PLAN_PRODUCT_NOT_COMPATIBLE", message: "nope", debugId: "dbg-body", details: [{ issue: "X" }] });
  });

  it("does not mark definitive API errors or network errors as ambiguous", () => {
    expect(toFailure(new Error("socket hang up"))).not.toHaveProperty("ambiguous");
  });

  it("maps a ResponseValidationError to an ambiguous failure that never echoes the response", () => {
    const secret = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=SECRET";
    const e = new ResponseValidationError(
      { request, statusCode: 200, headers: { "paypal-debug-id": "dbg-v" }, result: undefined, body: JSON.stringify({ links: [{ href: secret }] }) } as never,
      [{ message: `bad value ${secret}` } as never],
    );
    const f = toFailure(e);
    expect(f).toEqual({
      httpStatus: 200, name: "RESPONSE_VALIDATION_ERROR", debugId: "dbg-v", details: null, ambiguous: true,
      message: "PayPal returned a response that did not match the expected schema.",
    });
    expect(JSON.stringify(f)).not.toContain("SECRET");
  });

  it("tolerates a ResponseValidationError without headers", () => {
    const e = new ResponseValidationError({ request, statusCode: 201, body: "", result: undefined } as never, []);
    expect(toFailure(e)).toMatchObject({ httpStatus: 201, debugId: null, ambiguous: true });
  });
});

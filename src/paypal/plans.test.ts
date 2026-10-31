import { ApiError } from "@paypal/paypal-server-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = { createBillingPlan: vi.fn(), getBillingPlan: vi.fn(), reviseSubscription: vi.fn() };
vi.mock("./client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./client")>()), paypal: () => ({ subscriptions: sdk }) }));
const { createAnnualPlan, getPlan, reviseToPlan } = await import("./plans");

const plan = {
  id: "P-ANNUAL0000000000000000000", status: "ACTIVE", name: "Annual", productId: "PROD-RIDGELINE00000000",
  billingCycles: [{ tenureType: "REGULAR", sequence: 1, totalCycles: 0, frequency: { intervalUnit: "YEAR", intervalCount: 1 }, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }],
};
const snapshot = {
  planId: plan.id, status: "ACTIVE", productId: plan.productId, name: "Annual", price: "244.80", currency: "USD",
  intervalUnit: "YEAR", intervalCount: 1, totalCycles: 0, regularCycleCount: 1, cycleCount: 1,
};
const createInput = { productId: "PROD-RIDGELINE00000000", annualPrice: "244.80", currency: "USD", requestId: "req-1", name: "Annual", description: "One prepaid year" } as const;
const revise = { subscriptionId: "I-SUB0000001", planId: plan.id, returnUrl: "https://aurrery.example/return" };
const apiError = (statusCode: number, body: object) =>
  new ApiError({ request: {}, response: { statusCode, headers: { "paypal-debug-id": "dbg-api" }, body: JSON.stringify(body) } } as never, "api error");
const reviseResult = (href: string) => ({ result: { planId: plan.id, links: [{ rel: "approve", href }, { rel: "self", href: "https://api" }] }, statusCode: 200, headers: { "paypal-debug-id": "dbg2" } });

describe("annual plan adapter", () => {
  beforeEach(() => { for (const fn of Object.values(sdk)) fn.mockReset(); });

  it("creates one yearly regular cycle at the exact price under the given request ID", async () => {
    sdk.createBillingPlan.mockResolvedValue({ result: plan, statusCode: 201, headers: { "paypal-debug-id": "dbg1" } });
    const r = await createAnnualPlan(createInput);
    expect(r).toEqual({ ok: true, debugId: "dbg1", value: snapshot });
    const call = sdk.createBillingPlan.mock.calls[0][0];
    expect(call.paypalRequestId).toBe("req-1");
    expect(call.prefer).toBe("return=representation");
    expect(call.body.billingCycles).toEqual([{ frequency: { intervalUnit: "YEAR", intervalCount: 1 }, tenureType: "REGULAR", sequence: 1, totalCycles: 0, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }]);
    expect(call.body).toMatchObject({
      productId: "PROD-RIDGELINE00000000", name: "Annual", description: "One prepaid year", status: "ACTIVE",
      paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 2 },
    });
  });

  it("reads a plan back into the same snapshot shape", async () => {
    sdk.getBillingPlan.mockResolvedValue({ result: plan, statusCode: 200, headers: {} });
    expect(await getPlan(plan.id)).toEqual({ ok: true, debugId: null, value: snapshot });
    expect(sdk.getBillingPlan).toHaveBeenCalledWith(plan.id);
  });

  it("reports a plan with no REGULAR cycle without inventing price or interval", async () => {
    const trialOnly = { ...plan, billingCycles: [{ tenureType: "TRIAL", sequence: 1, totalCycles: 1, frequency: { intervalUnit: "MONTH", intervalCount: 1 }, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "0" } } }] };
    sdk.getBillingPlan.mockResolvedValue({ result: trialOnly, statusCode: 200, headers: {} });
    expect(await getPlan(plan.id)).toMatchObject({ ok: true, value: { price: null, currency: null, intervalUnit: null, intervalCount: null, totalCycles: null, regularCycleCount: 0, cycleCount: 1 } });
  });

  it("counts several regular cycles so callers can reject them", async () => {
    sdk.getBillingPlan.mockResolvedValue({ result: { ...plan, billingCycles: [plan.billingCycles[0], { ...plan.billingCycles[0], sequence: 2 }] }, statusCode: 200, headers: {} });
    expect(await getPlan(plan.id)).toMatchObject({ ok: true, value: { regularCycleCount: 2, cycleCount: 2 } });
  });

  it("fails closed, ambiguously, when PayPal returns a plan without an id", async () => {
    const noId = { ...plan, id: undefined };
    sdk.createBillingPlan.mockResolvedValue({ result: noId, statusCode: 201, headers: { "paypal-debug-id": "dbg3" } });
    sdk.getBillingPlan.mockResolvedValue({ result: noId, statusCode: 200, headers: {} });
    expect(await createAnnualPlan(createInput)).toMatchObject({ ok: false, error: { name: "MISSING_PLAN_ID", httpStatus: 201, debugId: "dbg3", ambiguous: true } });
    expect(await getPlan(plan.id)).toMatchObject({ ok: false, error: { name: "MISSING_PLAN_ID", ambiguous: true } });
  });

  it("passes a 4xx API error through with its name, status and debug id", async () => {
    sdk.createBillingPlan.mockRejectedValue(apiError(422, { name: "PLAN_PRODUCT_NOT_COMPATIBLE", message: "bad product", debug_id: "dbg-api", details: [] }));
    const r = await createAnnualPlan(createInput);
    expect(r).toMatchObject({ ok: false, error: { name: "PLAN_PRODUCT_NOT_COMPATIBLE", httpStatus: 422, debugId: "dbg-api" } });
    expect(r.ok === false && r.error.ambiguous).toBeUndefined();
  });

  it("normalises SDK errors from create and get", async () => {
    sdk.createBillingPlan.mockRejectedValue(new Error("boom"));
    sdk.getBillingPlan.mockRejectedValue(new Error("boom"));
    expect(await createAnnualPlan(createInput)).toMatchObject({ ok: false, error: { name: "NETWORK_OR_CLIENT_ERROR", httpStatus: null } });
    expect(await getPlan(plan.id)).toMatchObject({ ok: false, error: { name: "NETWORK_OR_CLIENT_ERROR", httpStatus: null } });
  });

  it("requests a switch and returns the customer approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue(reviseResult("https://www.sandbox.paypal.com/approve?token=x"));
    expect(await reviseToPlan(revise)).toEqual({ ok: true, debugId: "dbg2", value: { approvalUrl: "https://www.sandbox.paypal.com/approve?token=x", planId: plan.id } });
    expect(sdk.reviseSubscription).toHaveBeenCalledWith({ id: "I-SUB0000001", body: { planId: plan.id, applicationContext: { returnUrl: "https://aurrery.example/return", cancelUrl: "https://aurrery.example/return" } } });
  });

  it("fails closed and ambiguous when PayPal returns no approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue({ result: { planId: plan.id, links: [] }, statusCode: 200, headers: { "paypal-debug-id": "dbg4" } });
    expect(await reviseToPlan(revise)).toEqual({
      ok: false,
      error: { httpStatus: 200, name: "MISSING_APPROVAL_LINK", message: "PayPal accepted the revision without an approval link.", debugId: "dbg4", details: null, ambiguous: true },
    });
  });

  it.each([
    ["a non-PayPal host", "https://evil.example/approve?token=SECRET"],
    ["a look-alike host", "https://notpaypal.com/approve?token=SECRET"],
    ["plain http", "http://www.paypal.com/approve?token=SECRET"],
    ["an unparseable value", "not a url SECRET"],
  ])("rejects an approval link on %s without echoing it", async (_label, href) => {
    sdk.reviseSubscription.mockResolvedValue(reviseResult(href));
    const r = await reviseToPlan(revise);
    expect(r).toMatchObject({ ok: false, error: { name: "UNEXPECTED_APPROVAL_LINK", httpStatus: 200, debugId: "dbg2", details: null, ambiguous: true } });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("accepts the bare paypal.com host", async () => {
    sdk.reviseSubscription.mockResolvedValue(reviseResult("https://paypal.com/approve?token=x"));
    expect(await reviseToPlan(revise)).toMatchObject({ ok: true });
  });

  it("normalises SDK errors", async () => {
    sdk.reviseSubscription.mockRejectedValue(new Error("socket hang up"));
    expect(await reviseToPlan(revise)).toMatchObject({ ok: false, error: { name: "NETWORK_OR_CLIENT_ERROR", httpStatus: null } });
  });
});

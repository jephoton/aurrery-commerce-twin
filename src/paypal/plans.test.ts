import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = { createBillingPlan: vi.fn(), getBillingPlan: vi.fn(), reviseSubscription: vi.fn() };
vi.mock("./client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./client")>()), paypal: () => ({ subscriptions: sdk }) }));
const { createAnnualPlan, getPlan, reviseToPlan } = await import("./plans");

const plan = {
  id: "P-ANNUAL0000000000000000000", status: "ACTIVE", productId: "PROD-RIDGELINE00000000",
  billingCycles: [{ tenureType: "REGULAR", sequence: 1, frequency: { intervalUnit: "YEAR", intervalCount: 1 }, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }],
};

describe("annual plan adapter", () => {
  beforeEach(() => { for (const fn of Object.values(sdk)) fn.mockReset(); });

  it("creates one yearly regular cycle at the exact price under the given request ID", async () => {
    sdk.createBillingPlan.mockResolvedValue({ result: plan, statusCode: 201, headers: { "paypal-debug-id": "dbg1" } });
    const r = await createAnnualPlan({ productId: "PROD-RIDGELINE00000000", annualPrice: "244.80", requestId: "req-1", name: "Annual" });
    expect(r).toEqual({ ok: true, debugId: "dbg1", value: { planId: plan.id, status: "ACTIVE", productId: plan.productId, price: "244.80", intervalUnit: "YEAR", intervalCount: 1 } });
    const call = sdk.createBillingPlan.mock.calls[0][0];
    expect(call.paypalRequestId).toBe("req-1");
    expect(call.body.billingCycles).toEqual([{ frequency: { intervalUnit: "YEAR", intervalCount: 1 }, tenureType: "REGULAR", sequence: 1, totalCycles: 0, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }]);
    expect(call.body.productId).toBe("PROD-RIDGELINE00000000");
  });

  it("reads a plan back into the same snapshot shape", async () => {
    sdk.getBillingPlan.mockResolvedValue({ result: plan, statusCode: 200, headers: {} });
    expect(await getPlan(plan.id)).toMatchObject({ ok: true, value: { planId: plan.id, price: "244.80", intervalUnit: "YEAR" } });
    expect(sdk.getBillingPlan).toHaveBeenCalledWith(plan.id);
  });

  it("requests a switch and returns the customer approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue({ result: { planId: plan.id, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve?token=x" }, { rel: "self", href: "https://api" }] }, statusCode: 200, headers: { "paypal-debug-id": "dbg2" } });
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://aurrery.example/return")).toEqual({ ok: true, debugId: "dbg2", value: { approvalUrl: "https://www.sandbox.paypal.com/approve?token=x", planId: plan.id } });
    expect(sdk.reviseSubscription).toHaveBeenCalledWith({ id: "I-SUB0000001", body: { planId: plan.id, applicationContext: { returnUrl: "https://aurrery.example/return", cancelUrl: "https://aurrery.example/return" } } });
  });

  it("fails closed when PayPal returns no approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue({ result: { planId: plan.id, links: [] }, statusCode: 200, headers: {} });
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://x.example/r")).toMatchObject({ ok: false, error: { name: "MISSING_APPROVAL_LINK" } });
  });

  it("normalises SDK errors", async () => {
    sdk.reviseSubscription.mockRejectedValue(new Error("socket hang up"));
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://x.example/r")).toMatchObject({ ok: false, error: { name: "NETWORK_OR_CLIENT_ERROR", httpStatus: null } });
  });
});

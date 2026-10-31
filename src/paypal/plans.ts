import "server-only";
import { IntervalUnit, TenureType, type BillingPlan } from "@paypal/paypal-server-sdk";
import { paypal, toFailure } from "./client";
import type { Result } from "./subscriptions";

// Annual-plan offers: create the yearly plan an approved offer names, and ask PayPal to switch a
// subscriber to it. The switch needs the subscriber's consent, so PayPal returns an approval link.

export interface PlanSnapshot {
  planId: string;
  status: string;
  productId: string | null;
  price: string | null;
  intervalUnit: string | null;
  intervalCount: number | null;
}

function planSnapshot(p: BillingPlan): PlanSnapshot {
  const regular = p.billingCycles?.find((c) => c.tenureType === "REGULAR");
  return {
    planId: p.id ?? "",
    status: String(p.status ?? "UNKNOWN"),
    productId: p.productId ?? null,
    price: regular?.pricingScheme?.fixedPrice?.value ?? null,
    intervalUnit: regular?.frequency?.intervalUnit ?? null,
    intervalCount: regular?.frequency?.intervalCount ?? null,
  };
}

/** Create a yearly plan. A repeated `requestId` makes PayPal return the original plan. */
export async function createAnnualPlan(input: { productId: string; annualPrice: string; requestId: string; name: string }): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.createBillingPlan({
      paypalRequestId: input.requestId,
      prefer: "return=representation",
      body: {
        productId: input.productId,
        name: input.name,
        description: "One prepaid year of the monthly coffee subscription",
        billingCycles: [{
          frequency: { intervalUnit: IntervalUnit.Year, intervalCount: 1 },
          tenureType: TenureType.Regular,
          sequence: 1,
          totalCycles: 0,
          pricingScheme: { fixedPrice: { currencyCode: "USD", value: input.annualPrice } },
        }],
        paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 2 },
      },
    });
    return { ok: true, value: planSnapshot(res.result), debugId: res.headers?.["paypal-debug-id"] ?? null };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export async function getPlan(planId: string): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.getBillingPlan(planId);
    return { ok: true, value: planSnapshot(res.result), debugId: res.headers?.["paypal-debug-id"] ?? null };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export interface ReviseOffer {
  /** Secret, per-subscriber customer approval link. Never log or return it to visitors. */
  approvalUrl: string;
  planId: string | null;
}

/** Ask PayPal to switch a subscription to `planId`. The customer must open the approval link. */
export async function reviseToPlan(subscriptionId: string, planId: string, returnUrl: string): Promise<Result<ReviseOffer>> {
  try {
    const res = await paypal().subscriptions.reviseSubscription({
      id: subscriptionId,
      body: { planId, applicationContext: { returnUrl, cancelUrl: returnUrl } },
    });
    const debugId = res.headers?.["paypal-debug-id"] ?? null;
    const approvalUrl = res.result.links?.find((l) => l.rel === "approve")?.href;
    if (!approvalUrl) {
      return { ok: false, error: { httpStatus: res.statusCode, name: "MISSING_APPROVAL_LINK", message: "PayPal accepted the revision without an approval link.", debugId, details: null } };
    }
    return { ok: true, value: { approvalUrl, planId: res.result.planId ?? null }, debugId };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

import "server-only";
import { IntervalUnit, PlanRequestStatus, TenureType, type BillingPlan } from "@paypal/paypal-server-sdk";
import { isPayPalApprovalUrl } from "./approval-link";
import { paypal, toFailure, type PayPalFailure } from "./client";
import type { Result } from "./subscriptions";

// Annual-plan offers: create the yearly plan an approved offer names, and ask PayPal to switch a
// subscriber to it. The switch needs the subscriber's consent, so PayPal returns an approval link.

export interface PlanSnapshot {
  planId: string;
  status: string;
  name: string | null;
  productId: string | null;
  /** Regular-cycle price, or null when the plan has no REGULAR cycle. */
  price: string | null;
  currency: string | null;
  intervalUnit: string | null;
  intervalCount: number | null;
  totalCycles: number | null;
  /** Callers must require exactly one regular cycle (and usually one cycle overall). */
  regularCycleCount: number;
  cycleCount: number;
}

function planSnapshot(p: BillingPlan, planId: string): PlanSnapshot {
  const cycles = p.billingCycles ?? [];
  const regulars = cycles.filter((c) => c.tenureType === "REGULAR");
  const regular = regulars[0];
  return {
    planId,
    status: String(p.status ?? "UNKNOWN"),
    name: p.name ?? null,
    productId: p.productId ?? null,
    price: regular?.pricingScheme?.fixedPrice?.value ?? null,
    currency: regular?.pricingScheme?.fixedPrice?.currencyCode ?? null,
    intervalUnit: regular?.frequency?.intervalUnit ?? null,
    intervalCount: regular?.frequency?.intervalCount ?? null,
    totalCycles: regular?.totalCycles ?? null,
    regularCycleCount: regulars.length,
    cycleCount: cycles.length,
  };
}

function planResult(p: BillingPlan, statusCode: number, debugId: string | null): Result<PlanSnapshot> {
  if (!p.id) {
    return { ok: false, error: { httpStatus: statusCode, name: "MISSING_PLAN_ID", message: "PayPal returned a plan without an id.", debugId, details: null, ambiguous: true } };
  }
  return { ok: true, value: planSnapshot(p, p.id), debugId };
}

/**
 * Create a yearly plan. PayPal replays the original plan for a repeated `requestId` only within its
 * request-ID retention window, and regardless of a changed body, so callers must verify the result
 * (price, interval, product) by reading the plan back.
 */
export async function createAnnualPlan(input: {
  productId: string;
  annualPrice: string;
  currency: "USD";
  requestId: string;
  name: string;
  description: string;
}): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.createBillingPlan({
      paypalRequestId: input.requestId,
      prefer: "return=representation",
      body: {
        productId: input.productId,
        name: input.name,
        description: input.description,
        status: PlanRequestStatus.Active,
        billingCycles: [{
          frequency: { intervalUnit: IntervalUnit.Year, intervalCount: 1 },
          tenureType: TenureType.Regular,
          sequence: 1,
          totalCycles: 0,
          pricingScheme: { fixedPrice: { currencyCode: input.currency, value: input.annualPrice } },
        }],
        paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 2 },
      },
    });
    return planResult(res.result, res.statusCode, res.headers?.["paypal-debug-id"] ?? null);
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export async function getPlan(planId: string): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.getBillingPlan(planId);
    return planResult(res.result, res.statusCode, res.headers?.["paypal-debug-id"] ?? null);
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export interface ReviseOffer {
  /** Secret, per-subscriber customer approval link. Never log or return it to visitors. */
  approvalUrl: string;
  planId: string | null;
  /** The real HTTP status of the revise call, for the execution record. */
  httpStatus: number;
}

/** Ask PayPal to switch a subscription to `planId`. The customer must open the approval link. */
export async function reviseToPlan(input: { subscriptionId: string; planId: string; returnUrl: string }): Promise<Result<ReviseOffer>> {
  try {
    const res = await paypal().subscriptions.reviseSubscription({
      id: input.subscriptionId,
      body: { planId: input.planId, applicationContext: { returnUrl: input.returnUrl, cancelUrl: input.returnUrl } },
    });
    const debugId = res.headers?.["paypal-debug-id"] ?? null;
    const fail = (name: string, message: string): Result<ReviseOffer> => {
      const error: PayPalFailure = { httpStatus: res.statusCode, name, message, debugId, details: null, ambiguous: true };
      return { ok: false, error };
    };
    const approvalUrl = res.result.links?.find((l) => l.rel === "approve")?.href;
    if (!approvalUrl) return fail("MISSING_APPROVAL_LINK", "PayPal accepted the revision without an approval link.");
    // The link is a secret, per-subscriber URL: never echo it, and only hand on a PayPal https link.
    if (!isPayPalApprovalUrl(approvalUrl)) return fail("UNEXPECTED_APPROVAL_LINK", "PayPal returned an approval link that is not a PayPal https URL.");
    return { ok: true, value: { approvalUrl, planId: res.result.planId ?? null, httpStatus: res.statusCode }, debugId };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

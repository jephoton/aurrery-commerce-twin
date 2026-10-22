import "server-only";
import { PatchOp } from "@paypal/paypal-server-sdk";
import { paypal, toFailure, type PayPalFailure } from "./client";

// Thin, typed wrappers over the Subscriptions API calls the product actually uses.

export interface SubscriptionSnapshot {
  id: string;
  status: string;
  planId: string | null;
  planOverridden: boolean;
  /** Regular-cycle price as PayPal reports it, including any per-subscription override. */
  regularPrice: string | null;
  nextBillingTime: string | null;
  lastPayment: { amount: string; time: string } | null;
  raw: unknown;
}

export type Result<T> = { ok: true; value: T; debugId: string | null } | { ok: false; error: PayPalFailure };

export type PatchOperation = "replace" | "add";

export async function getSubscription(id: string): Promise<Result<SubscriptionSnapshot>> {
  try {
    const res = await paypal().subscriptions.getSubscription({ id, fields: "plan" });
    const s = res.result;
    const regular = s.plan?.billingCycles?.find((c) => c.tenureType === "REGULAR") ?? s.plan?.billingCycles?.[0];
    return {
      ok: true,
      debugId: res.headers?.["paypal-debug-id"] ?? null,
      value: {
        id: s.id ?? id,
        status: String(s.status ?? "UNKNOWN"),
        planId: s.planId ?? null,
        planOverridden: Boolean(s.planOverridden),
        regularPrice: regular?.pricingScheme?.fixedPrice?.value ?? null,
        nextBillingTime: s.billingInfo?.nextBillingTime ?? null,
        lastPayment: s.billingInfo?.lastPayment
          ? { amount: s.billingInfo.lastPayment.amount?.value ?? "", time: s.billingInfo.lastPayment.time ?? "" }
          : null,
        raw: s,
      },
    };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

/**
 * Override the regular billing-cycle price for one subscription. Merchant-side; PayPal does not
 * require buyer consent for this, and charges within 10 days of the change are unaffected.
 */
export async function overrideSubscriptionPrice(
  id: string,
  amount: string,
  billingCycleSequence = 1,
  operation: PatchOperation = "replace",
): Promise<Result<{ httpStatus: number }>> {
  try {
    const res = await paypal().subscriptions.patchSubscription({
      id,
      body: [
        {
          op: operation === "add" ? PatchOp.Add : PatchOp.Replace,
          path: `/plan/billing_cycles/@sequence==${billingCycleSequence}/pricing_scheme/fixed_price`,
          value: { currency_code: "USD", value: amount },
        },
      ],
    });
    return { ok: true, value: { httpStatus: res.statusCode }, debugId: res.headers?.["paypal-debug-id"] ?? null };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

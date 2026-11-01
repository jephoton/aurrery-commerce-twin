import { connection } from "next/server";
import { recordObservation } from "@/execution/execute";
import { appendOfferReads, listAnnualOfferViews } from "@/ledger/annual-offers";
import { getSetting } from "@/ledger/operations";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getSubscription } from "@/paypal/subscriptions";
import { errorResponse } from "../../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

/**
 * Live read of the registered sandbox subscriptions, straight from PayPal. Every successful GET of a
 * subscription that received annual offers appends one read per offer, even after a confirmed decline,
 * because a stale link can still be approved (decision 0008). A subscriber that left the registry is
 * read only while one of its offers still needs a read. Failed GETs record nothing. The payload
 * carries offer status and expiry only, never approval links.
 */
export async function GET(request: Request) {
  await connection();
  const admission = await admitHostedRequest(request, { limit: "poll" });
  if (admission) return admission;
  try {
    const configured = paypalConfigured();
    const registered = await listSandboxSubscribers();
    const before = await listAnnualOfferViews();
    const offered = new Set(before.map((offer) => offer.subscriptionId));
    const annualPlans = new Set(before.map((offer) => offer.annualPlanId));
    const readAndRecord = async (subscriptionId: string) => {
      const r = await getSubscription(subscriptionId);
      if (!r.ok) return r;
      const observedAt = new Date().toISOString();
      await recordObservation(r.value, "paypal.status");
      if (offered.has(subscriptionId)) {
        await appendOfferReads(subscriptionId, { status: r.value.status, planId: r.value.planId, debugId: r.debugId }, observedAt);
      }
      return r;
    };
    const subscriptions = configured
      ? await Promise.all(
          registered.map(async (s) => {
            const r = await readAndRecord(s.subscriptionId);
            return r.ok
              ? { ...s, live: { status: r.value.status, regularPrice: r.value.regularPrice, planOverridden: r.value.planOverridden, nextBillingTime: r.value.nextBillingTime,
                  annualPlan: r.value.planId !== null && annualPlans.has(r.value.planId) } }
              : { ...s, error: "Live status unavailable." };
          }),
        )
      : registered;
    if (configured) {
      const registeredIds = new Set(registered.map((s) => s.subscriptionId));
      const unregistered = new Set(before.filter((offer) => offer.needsRead && !registeredIds.has(offer.subscriptionId)).map((offer) => offer.subscriptionId));
      await Promise.all([...unregistered].map(readAndRecord));
    }
    return Response.json({ environment: "sandbox", configured, planId: await getSetting("paypal.plan_id"), subscriptions, annualOffers: await listAnnualOfferViews() });
  } catch (e) {
    return errorResponse(e);
  }
}

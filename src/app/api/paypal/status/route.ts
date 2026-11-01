import { connection } from "next/server";
import { recordObservation } from "@/execution/execute";
import { appendOfferReads, listAnnualOfferViews } from "@/ledger/annual-offers";
import { getSetting } from "@/ledger/operations";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getSubscription, type SubscriptionSnapshot } from "@/paypal/subscriptions";
import { errorResponse } from "../../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

/**
 * Live read of the registered sandbox subscriptions, straight from PayPal. Every successful GET of a
 * subscription that received annual offers appends one read per offer, even after a confirmed decline,
 * because a stale link can still be approved (decision 0008). A subscriber that left the registry is
 * read only while one of its offers still needs a read, in the same PayPal round. Failed GETs, and GETs
 * that return a different subscription, record nothing. The payload carries offer status and expiry only,
 * never approval links.
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
    const registeredIds = new Set(registered.map((s) => s.subscriptionId));
    const unregistered = [...new Set(before.filter((offer) => offer.needsRead && !registeredIds.has(offer.subscriptionId)).map((offer) => offer.subscriptionId))];
    const readAndRecord = async (subscriptionId: string): Promise<SubscriptionSnapshot | null> => {
      const r = await getSubscription(subscriptionId);
      // Only a successful read of the subscription that was asked for is evidence.
      if (!r.ok || r.value.id !== subscriptionId) return null;
      // Offer reads first, so a failed observation write never loses one.
      if (offered.has(subscriptionId)) {
        await appendOfferReads(subscriptionId, { status: r.value.status, planId: r.value.planId, debugId: r.debugId }, new Date().toISOString());
      }
      await recordObservation(r.value, "paypal.status");
      return r.value;
    };
    // One PayPal round: registered subscribers and unregistered ones that still need a read, together.
    const [subscriptions] = configured
      ? await Promise.all([
          Promise.all(registered.map(async (s) => {
            const live = await readAndRecord(s.subscriptionId);
            return live
              ? { ...s, live: { status: live.status, regularPrice: live.regularPrice, planOverridden: live.planOverridden, nextBillingTime: live.nextBillingTime,
                  annualPlan: live.planId !== null && annualPlans.has(live.planId) } }
              : { ...s, error: "Live status unavailable." };
          })),
          Promise.all(unregistered.map(readAndRecord)),
        ])
      : [registered];
    const viewedAt = new Date();
    return Response.json({ environment: "sandbox", configured, planId: await getSetting("paypal.plan_id"), subscriptions, annualOffers: await listAnnualOfferViews(viewedAt) });
  } catch (e) {
    return errorResponse(e);
  }
}

import { connection } from "next/server";
import { recordObservation } from "@/execution/execute";
import { getSetting } from "@/ledger/operations";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getSubscription } from "@/paypal/subscriptions";
import { errorResponse } from "../../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

/** Live read of the registered sandbox subscriptions, straight from PayPal. */
export async function GET(request: Request) {
  const admission = admitHostedRequest(request, { limit: "poll" });
  if (admission) return admission;
  await connection();
  try {
    const configured = paypalConfigured();
    const registered = await listSandboxSubscribers();
    const subscriptions = configured
      ? await Promise.all(
          registered.map(async (s) => {
            const r = await getSubscription(s.subscriptionId);
            if (r.ok) await recordObservation(r.value, "paypal.status");
            return r.ok
              ? { ...s, live: { status: r.value.status, regularPrice: r.value.regularPrice, planOverridden: r.value.planOverridden, nextBillingTime: r.value.nextBillingTime } }
              : { ...s, error: "Live status unavailable." };
          }),
        )
      : registered;
    return Response.json({ environment: "sandbox", configured, planId: await getSetting("paypal.plan_id"), subscriptions });
  } catch (e) {
    return errorResponse(e);
  }
}

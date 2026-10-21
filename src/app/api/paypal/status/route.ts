import { connection } from "next/server";
import { recordObservation } from "@/execution/execute";
import { getSetting } from "@/ledger/db";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getSubscription } from "@/paypal/subscriptions";
import { errorResponse } from "../../_lib/http";

/** Live read of the registered sandbox subscriptions, straight from PayPal. */
export async function GET() {
  await connection();
  try {
    const configured = paypalConfigured();
    const registered = listSandboxSubscribers();
    const subscriptions = configured
      ? await Promise.all(
          registered.map(async (s) => {
            const r = await getSubscription(s.subscriptionId);
            if (r.ok) recordObservation(r.value, "paypal.status");
            return r.ok
              ? { ...s, live: { status: r.value.status, regularPrice: r.value.regularPrice, planOverridden: r.value.planOverridden, nextBillingTime: r.value.nextBillingTime } }
              : { ...s, error: `${r.error.name}: ${r.error.message}` };
          }),
        )
      : registered;
    return Response.json({ environment: "sandbox", configured, planId: getSetting("paypal.plan_id"), subscriptions });
  } catch (e) {
    return errorResponse(e);
  }
}

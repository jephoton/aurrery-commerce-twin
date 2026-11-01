import { connection } from "next/server";
import { admitHostedRequest } from "@/hosting/guard";
import { currentMerchant } from "@/merchant";
import { listAnnualOfferLinks } from "@/ledger/annual-offers";
import { draftAnnualOfferMessage } from "@/ledger/annual-offer-message";
import { listSandboxSubscribers } from "@/ledger/proposals";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Administrator only: display-only draft messages carrying the secret approval links of offers whose
 * window is still open (decision 5: pending offers only). Runs at request time, is never cached, and
 * logs nothing. Visitors get the guard's unauthorized response before any link is read. Errors return
 * a fixed body, so no link can surface through an error.
 */
export async function GET(request: Request) {
  await connection();
  const admission = await admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  // Browsers mark cross-site reads; refuse them before any link is read. Non-browser clients send no header.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return Response.json({ error: "CROSS_SITE_REQUEST" }, { status: 403, headers: NO_STORE });
  try {
    const { merchant } = currentMerchant().twin;
    const labels = new Map((await listSandboxSubscribers()).map((s) => [s.subscriptionId, s.label]));
    const offers = (await listAnnualOfferLinks()).map((offer) => ({
      id: offer.id, subscriptionId: offer.subscriptionId, label: labels.get(offer.subscriptionId) ?? null, expiresAt: offer.expiresAt,
      message: draftAnnualOfferMessage({
        merchantName: merchant.name, planName: merchant.planName, annualPrice: offer.annualPrice,
        discountPct: offer.discountPct, expiresAt: offer.expiresAt, approvalUrl: offer.approvalUrl,
      }),
    }));
    return Response.json({ offers }, { headers: NO_STORE });
  } catch {
    // Deliberately not errorResponse: it logs, and this route logs nothing. Fixed body, never cached.
    return Response.json({ error: "INTERNAL", message: "Request unavailable." }, { status: 500, headers: NO_STORE });
  }
}

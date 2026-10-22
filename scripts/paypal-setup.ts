// Creates the demo merchant's PayPal Sandbox catalog product, monthly plan, and a small pilot
// cohort of real sandbox subscriptions, then registers them in the ledger.
//
//   npm run paypal:setup   create product, plan, and pilot subscriptions (prints approval links)
//   npm run paypal:sync    read every registered subscription back from PayPal
//
// A sandbox *personal* account must open each approval link once, so the subscription becomes ACTIVE.

import { IntervalUnit, TenureType } from "@paypal/paypal-server-sdk";
import { getSetting, setSetting } from "@/ledger/db";
import { setupPilots, syncPilots } from "@/paypal/setup";
import { paypal, toFailure } from "@/paypal/client";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const RETURN_URL = process.env.APP_URL ? `${process.env.APP_URL}/?paypal=approved` : "http://localhost:3001/?paypal=approved";

async function accessToken(): Promise<string> {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`OAuth failed: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Catalog Products is not in the server SDK, so this one call uses the documented REST endpoint. */
async function ensureProduct(): Promise<string> {
  const existing = getSetting("paypal.product_id");
  if (existing) return existing;
  const res = await fetch(`${SANDBOX_API}/v1/catalogs/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": "aurrery-ridgeline-product-v1",
    },
    body: JSON.stringify({
      name: "Ridgeline Roasters Coffee Club",
      description: "Monthly specialty coffee subscription (demo merchant)",
      type: "PHYSICAL",
      category: "FOOD_RETAIL_AND_SERVICE",
    }),
  });
  if (!res.ok) throw new Error(`Create product failed: HTTP ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  setSetting("paypal.product_id", id);
  console.log("Created product", id);
  return id;
}

async function ensurePlan(productId: string): Promise<string> {
  const existing = getSetting("paypal.plan_id");
  if (existing) return existing;
  const res = await paypal().subscriptions.createBillingPlan({
    paypalRequestId: "aurrery-ridgeline-plan-v1",
    prefer: "return=representation",
    body: {
      productId,
      name: "Roaster's Choice (monthly)",
      description: "One 340g bag of single-origin coffee every month",
      billingCycles: [
        {
          frequency: { intervalUnit: IntervalUnit.Month, intervalCount: 1 },
          tenureType: TenureType.Regular,
          sequence: 1,
          totalCycles: 0,
          pricingScheme: { fixedPrice: { currencyCode: "USD", value: "24.00" } },
        },
      ],
      paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 2 },
    },
  });
  const id = res.result.id!;
  setSetting("paypal.plan_id", id);
  console.log("Created plan", id, res.result.status);
  return id;
}

async function setup() {
  const planId = await ensurePlan(await ensureProduct());
  await setupPilots({ planId, returnUrl: RETURN_URL, recoverMissing: process.argv.includes("--recover-missing"), onMessage: console.log });
  console.log("\nApprove any APPROVAL_PENDING pilots as a sandbox personal account, then run: npm run paypal:sync");
}

const command = process.argv[2] ?? "setup";
(command === "sync" ? syncPilots(console.log) : setup()).catch((e) => {
  const { httpStatus, name, message, debugId } = toFailure(e);
  console.error({ httpStatus, name, message, debugId });
  process.exit(1);
});

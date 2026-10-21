// Creates the demo merchant's PayPal Sandbox catalog product, monthly plan, and a small pilot
// cohort of real sandbox subscriptions, then registers them in the ledger.
//
//   npm run paypal:setup   create product, plan, and pilot subscriptions (prints approval links)
//   npm run paypal:sync    read every registered subscription back from PayPal
//
// A sandbox *personal* account must open each approval link once, so the subscription becomes ACTIVE.

import { IntervalUnit, TenureType } from "@paypal/paypal-server-sdk";
import { getSetting, setSetting } from "@/ledger/db";
import { listSandboxSubscribers, registerSandboxSubscriber } from "@/ledger/proposals";
import { paypal, toFailure } from "@/paypal/client";
import { getSubscription } from "@/paypal/subscriptions";
import { recordObservation } from "@/execution/execute";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const RETURN_URL = process.env.APP_URL ? `${process.env.APP_URL}/?paypal=approved` : "http://localhost:3000/?paypal=approved";

const PILOT_COHORT = [
  { label: "Pilot A (skipped 2 deliveries)", segment: "at_risk" },
  { label: "Pilot B (paused last month)", segment: "at_risk" },
  { label: "Pilot C (opened cancel flow)", segment: "at_risk" },
  { label: "Pilot D (loyal, 14 months)", segment: "core" },
];

async function accessToken(): Promise<string> {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status} ${await res.text()}`);
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
      "PayPal-Request-Id": "acl-ridgeline-product-v1",
    },
    body: JSON.stringify({
      name: "Ridgeline Roasters Coffee Club",
      description: "Monthly specialty coffee subscription (demo merchant)",
      type: "PHYSICAL",
      category: "FOOD_RETAIL_AND_SERVICE",
    }),
  });
  if (!res.ok) throw new Error(`Create product failed: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  setSetting("paypal.product_id", id);
  console.log("Created product", id);
  return id;
}

async function ensurePlan(productId: string): Promise<string> {
  const existing = getSetting("paypal.plan_id");
  if (existing) return existing;
  const res = await paypal().subscriptions.createBillingPlan({
    paypalRequestId: "acl-ridgeline-plan-v1",
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
  const registered = listSandboxSubscribers();
  for (const [i, member] of PILOT_COHORT.entries()) {
    if (registered.some((r) => r.label === member.label)) continue;
    const res = await paypal().subscriptions.createSubscription({
      paypalRequestId: `acl-ridgeline-sub-${i}-v1`,
      prefer: "return=representation",
      body: {
        planId,
        customId: `pilot-${i}`,
        applicationContext: { brandName: "Ridgeline Roasters", returnUrl: RETURN_URL, cancelUrl: RETURN_URL },
      },
    });
    const sub = res.result;
    registerSandboxSubscriber({ subscriptionId: sub.id!, label: member.label, segment: member.segment });
    const approve = sub.links?.find((l) => l.rel === "approve")?.href;
    console.log(`\n${member.label} [${member.segment}] ${sub.id} ${sub.status}\n  approve as a sandbox buyer: ${approve}`);
  }
  console.log("\nOpen each approval link while signed in as a sandbox personal account, then run: npm run paypal:sync");
}

async function sync() {
  for (const s of listSandboxSubscribers()) {
    const r = await getSubscription(s.subscriptionId);
    if (!r.ok) {
      console.log(s.subscriptionId, "ERROR", r.error);
      continue;
    }
    recordObservation(r.value, "paypal.sync");
    console.log(s.subscriptionId, s.segment.padEnd(16), r.value.status.padEnd(18), "price", r.value.regularPrice ?? "(plan default)", "overridden", r.value.planOverridden, "next", r.value.nextBillingTime);
  }
}

const command = process.argv[2] ?? "setup";
(command === "sync" ? sync() : setup()).catch((e) => {
  console.error(toFailure(e));
  process.exit(1);
});

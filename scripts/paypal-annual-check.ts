// scripts/paypal-annual-check.ts
// Live sandbox check for M7: can a monthly Ridgeline subscription switch to a yearly plan?
// It uses one DISPOSABLE subscription (never a registered pilot) and cancels it at the end.
//
//   npm run paypal:annual-check -- prepare  create the disposable monthly subscription; prints its approval link
//   npm run paypal:annual-check -- offer    ensure the yearly check plan, revise twice, print both approval links
//   npm run paypal:annual-check -- status   read the disposable subscription back (plan, price, billing)
//   npm run paypal:annual-check -- cancel   cancel it and GET-verify CANCELLED
//
// State (IDs only, never links or credentials) lives in ignored data/m7-annual-check.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getSetting } from "@/ledger/operations";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypal, toFailure } from "@/paypal/client";
import { createAnnualPlan, getPlan, reviseToPlan } from "@/paypal/plans";
import { getSubscription } from "@/paypal/subscriptions";

const STATE = resolve(process.cwd(), "data", "m7-annual-check.json");
const RETURN_URL = `${process.env.APP_URL ?? "http://localhost:3001"}/?paypal=annual-check`;
type State = { subscriptionId?: string; annualPlanId?: string };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };

async function disposable(): Promise<string> {
  const id = load().subscriptionId;
  if (!id) throw new Error("No disposable subscription yet. Run prepare first.");
  if ((await listSandboxSubscribers()).some((s) => s.subscriptionId === id)) throw new Error(`${id} is a registered pilot; refusing.`);
  return id;
}

async function prepare() {
  if (load().subscriptionId) throw new Error("A disposable subscription already exists; run status or cancel.");
  const planId = await getSetting("paypal.plan_id");
  if (!planId) throw new Error("No monthly plan recorded; run npm run paypal:setup first.");
  const res = await paypal().subscriptions.createSubscription({
    prefer: "return=representation",
    body: { planId, customId: "m7-annual-check", applicationContext: { brandName: "Ridgeline Roasters", returnUrl: RETURN_URL, cancelUrl: RETURN_URL } },
  });
  save({ subscriptionId: res.result.id! });
  console.log(`Disposable monthly subscription ${res.result.id} (${res.result.status}).`);
  const approveUrl = res.result.links?.find((l) => l.rel === "approve")?.href;
  if (approveUrl) console.log(`Approve it as the sandbox personal account: ${approveUrl}`);
  else console.log("PayPal returned no approval link; the subscription cannot be approved. Run cancel, then prepare again.");
}

async function offer() {
  const id = await disposable();
  const before = await getSubscription(id);
  if (!before.ok || before.value.status !== "ACTIVE") throw new Error(`Subscription must be ACTIVE first (${before.ok ? before.value.status : before.error.name}).`);
  const productId = await getSetting("paypal.product_id");
  if (!productId) throw new Error("No product recorded; run npm run paypal:setup first.");
  const state = load();
  let planId = state.annualPlanId;
  if (!planId) {
    const created = await createAnnualPlan({
      productId,
      annualPrice: "244.80",
      currency: "USD",
      requestId: "aurrery-m7-annual-check-plan-v1",
      name: "Roaster's Choice (annual prepay, check)",
      description: "One prepaid year of the monthly coffee subscription (check)",
    });
    if (!created.ok) throw new Error(`Plan creation failed: ${JSON.stringify(created.error)}`);
    planId = created.value.planId;
    save({ ...state, annualPlanId: planId });
  }
  const plan = await getPlan(planId);
  console.log("plan", plan.ok ? plan.value : plan.error);
  for (const attempt of [1, 2]) {
    const revised = await reviseToPlan({ subscriptionId: id, planId, returnUrl: RETURN_URL });
    console.log(`revise #${attempt}`, revised.ok ? { approvalUrl: revised.value.approvalUrl, planId: revised.value.planId, debugId: revised.debugId } : revised.error);
  }
  console.log("Open the SECOND approval link as the sandbox personal account, then run status. Afterwards, try the FIRST link and note what PayPal shows.");
}

async function status() {
  const id = await disposable();
  const r = await getSubscription(id);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const raw = r.value.raw as { statusUpdateTime?: string };
  console.log({ id, status: r.value.status, planId: r.value.planId, annualPlanId: load().annualPlanId, regularPrice: r.value.regularPrice, nextBillingTime: r.value.nextBillingTime, lastPayment: r.value.lastPayment, statusUpdateTime: raw.statusUpdateTime, debugId: r.debugId });
}

async function cancel() {
  const id = await disposable();
  await paypal().subscriptions.cancelSubscription({ id, body: { reason: "M7 annual-plan sandbox check complete" } });
  const r = await getSubscription(id);
  console.log(r.ok ? { id, status: r.value.status } : r.error);
  if (!r.ok || r.value.status !== "CANCELLED") { process.exitCode = 1; console.error("NOT CONFIRMED CANCELLED: check PayPal by hand."); }
}

const commands: Record<string, () => Promise<void>> = { prepare, offer, status, cancel };
const command = commands[process.argv[2] ?? ""];
if (!command) { console.error("Usage: paypal:annual-check -- prepare|offer|status|cancel"); process.exit(1); }
command().catch((e) => { console.error(e instanceof Error ? e.message : toFailure(e)); process.exit(1); });

// scripts/paypal-annual-check.ts
// Live sandbox check for M7: can a monthly Ridgeline subscription switch to a yearly plan?
// It uses one DISPOSABLE subscription (never a registered pilot) and cancels it at the end.
//
//   npm run paypal:annual-check -- prepare  create the disposable monthly subscription; prints its approval link
//   npm run paypal:annual-check -- offer    verify the yearly check plan, revise twice, print both approval links
//   npm run paypal:annual-check -- status   read the disposable subscription back (plan, price, billing)
//   npm run paypal:annual-check -- cancel   cancel it and GET-verify CANCELLED
//
// State (IDs only, never links or credentials) lives in ignored data/m7-annual-check.json.
// Approval links are printed deliberately for this sandbox-only manual check; the decision record
// must store only their shape (host, path, parameter names), never tokens.
// prepare uses a fixed PayPal request ID: rerunning it after deleting the state file, within PayPal's
// retention window, may return the same subscription. That is fine, and better than an orphan.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError, ResponseValidationError } from "@paypal/paypal-server-sdk";
import { getSetting } from "@/ledger/operations";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { paypal, toFailure } from "@/paypal/client";
import { createAnnualPlan, getPlan } from "@/paypal/plans";
import { getSubscription, type SubscriptionSnapshot } from "@/paypal/subscriptions";

const STATE = resolve(process.cwd(), "data", "m7-annual-check.json");
const RETURN_URL = `${process.env.APP_URL ?? "http://localhost:3001"}/?paypal=annual-check`;
const CUSTOM_ID = "m7-annual-check";
type State = { subscriptionId?: string; annualPlanId?: string };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };

/** SDK errors print as a normalised failure (never the raw SDK message); anything else prints its message. */
const isSdkError = (e: unknown) => e instanceof ApiError || e instanceof ResponseValidationError;
const describe = (e: unknown) => (isSdkError(e) ? toFailure(e) : e instanceof Error ? e.message : String(e));
/** A call that threw without a definitive client error may have taken effect at PayPal. */
const isAmbiguous = (e: unknown) => (isSdkError(e) ? toFailure(e).ambiguous === true : true);

type RawSubscription = {
  customId?: string;
  planOverridden?: boolean;
  startTime?: string;
  statusUpdateTime?: string;
  billingInfo?: { cycleExecutions?: unknown; outstandingBalance?: unknown };
  plan?: { billingCycles?: { tenureType?: string; frequency?: unknown }[] };
};

/** The disposable subscription, read back. Refuses registered pilots and anything this script did not create. */
async function disposable(): Promise<{ id: string; snap: SubscriptionSnapshot; raw: RawSubscription; debugId: string | null }> {
  const id = load().subscriptionId;
  if (!id) throw new Error("No disposable subscription yet. Run prepare first.");
  if ((await listSandboxSubscribers()).some((s) => s.subscriptionId === id)) throw new Error(`${id} is a registered pilot; refusing.`);
  const r = await getSubscription(id);
  if (!r.ok) throw new Error(`Could not read ${id}: ${JSON.stringify(r.error)}`);
  const raw = (r.value.raw ?? {}) as RawSubscription;
  if (raw.customId !== CUSTOM_ID) throw new Error(`${id} does not carry customId ${CUSTOM_ID}; refusing.`);
  return { id, snap: r.value, raw, debugId: r.debugId };
}

async function prepare() {
  if (load().subscriptionId) throw new Error("A disposable subscription already exists; run status or cancel.");
  const planId = await getSetting("paypal.plan_id");
  if (!planId) throw new Error("No monthly plan recorded; run npm run paypal:setup first.");
  const res = await paypal().subscriptions.createSubscription({
    paypalRequestId: "aurrery-m7-annual-check-sub-v1",
    prefer: "return=representation",
    body: { planId, customId: CUSTOM_ID, applicationContext: { brandName: "Ridgeline Roasters", returnUrl: RETURN_URL, cancelUrl: RETURN_URL } },
  });
  const id = res.result.id;
  if (!id) throw new Error("PayPal returned a subscription without an id; check PayPal by hand.");
  save({ subscriptionId: id });
  console.log(`Disposable monthly subscription ${id} (${res.result.status}).`);
  const approveUrl = res.result.links?.find((l) => l.rel === "approve")?.href;
  if (approveUrl) console.log(`Approve it as the sandbox personal account: ${approveUrl}`);
  else console.log("PayPal returned no approval link: delete data/m7-annual-check.json and run prepare again; the pending subscription will expire unapproved.");
}

function mismatches(checks: [string, unknown, unknown][]): string[] {
  return checks.filter(([, got, want]) => got !== want).map(([field, got, want]) => `${field}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** One revise call; prints everything the decision record needs. Returns the approve href, or null when none. */
async function reviseOnce(id: string, planId: string, attempt: number): Promise<{ ok: true; href: string | null } | { ok: false }> {
  try {
    const res = await paypal().subscriptions.reviseSubscription({
      id,
      body: { planId, applicationContext: { returnUrl: RETURN_URL, cancelUrl: RETURN_URL } },
    });
    const links = res.result.links ?? [];
    console.log(`revise #${attempt}`, {
      statusCode: res.statusCode,
      debugId: res.headers?.["paypal-debug-id"] ?? null,
      planId: res.result.planId ?? null,
      planOverridden: res.result.planOverridden ?? null,
      links: links.map((l) => ({ rel: l.rel, method: l.method, href: l.href })),
    });
    const href = links.find((l) => l.rel === "approve")?.href ?? null;
    if (href) {
      try {
        const u = new URL(href);
        console.log(`revise #${attempt} approve link shape`, { host: u.host, pathname: u.pathname, queryParamNames: [...u.searchParams.keys()] });
      } catch {
        console.log(`revise #${attempt} approve link is not a parseable URL`);
      }
    } else {
      console.log(`revise #${attempt} returned no approve link`);
    }
    return { ok: true, href };
  } catch (e) {
    console.error(`revise #${attempt} failed`, { failure: describe(e), ambiguous: isAmbiguous(e) });
    return { ok: false };
  }
}

const tokenOf = (href: string) => {
  try { return new URL(href).searchParams.get("token") ?? href; } catch { return href; }
};

async function offer() {
  const { id, snap } = await disposable();
  if (snap.status !== "ACTIVE") throw new Error(`Subscription must be ACTIVE first (${snap.status}).`);
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
  if (!plan.ok) throw new Error(`Could not read plan ${planId} back: ${JSON.stringify(plan.error)}`);
  console.log("plan", plan.value);
  const bad = mismatches([
    ["status", plan.value.status, "ACTIVE"],
    ["productId", plan.value.productId, productId],
    ["intervalUnit", plan.value.intervalUnit, "YEAR"],
    ["intervalCount", plan.value.intervalCount, 1],
    ["price", plan.value.price, "244.80"],
    ["currency", plan.value.currency, "USD"],
    ["regularCycleCount", plan.value.regularCycleCount, 1],
    ["cycleCount", plan.value.cycleCount, 1],
  ]);
  if (bad.length) throw new Error(`Plan ${planId} does not match the expected annual plan (no revise sent): ${bad.join("; ")}`);

  const first = await reviseOnce(id, planId, 1);
  if (!first.ok) {
    console.error("revise #1 failed; not repeating. Run status, then cancel.");
    process.exitCode = 1;
    return;
  }
  const second = await reviseOnce(id, planId, 2);
  if (!second.ok) {
    console.error("revise #2 failed. Run status before trying anything else.");
    process.exitCode = 1;
    return;
  }
  if (first.href && second.href) {
    console.log({ sameLink: first.href === second.href, sameToken: tokenOf(first.href) === tokenOf(second.href) });
  } else {
    console.log({ sameLink: null, sameToken: null, note: "at least one revise returned no approve link" });
  }
  console.log("Open the SECOND approval link as the sandbox personal account, then run status. Afterwards, try the FIRST link and note what PayPal shows.");
}

async function status() {
  const { id, snap, raw, debugId } = await disposable();
  const regularCycle = raw.plan?.billingCycles?.find((c) => c.tenureType === "REGULAR");
  console.log({
    observedAt: new Date().toISOString(),
    id,
    status: snap.status,
    planId: snap.planId,
    annualPlanId: load().annualPlanId,
    planOverridden: raw.planOverridden ?? snap.planOverridden,
    regularPrice: snap.regularPrice,
    planRegularFrequency: regularCycle?.frequency ?? null,
    startTime: raw.startTime,
    customId: raw.customId,
    nextBillingTime: snap.nextBillingTime,
    lastPayment: snap.lastPayment,
    cycleExecutions: raw.billingInfo?.cycleExecutions,
    outstandingBalance: raw.billingInfo?.outstandingBalance,
    statusUpdateTime: raw.statusUpdateTime,
    debugId,
  });
}

async function cancel() {
  const { id } = await disposable();
  try {
    await paypal().subscriptions.cancelSubscription({ id, body: { reason: "M7 annual-plan sandbox check complete" } });
  } catch (e) {
    process.exitCode = 1;
    console.error("cancel call failed (verifying anyway)", { failure: describe(e), ambiguous: isAmbiguous(e) });
  }
  const r = await getSubscription(id);
  console.log(r.ok ? { id, status: r.value.status } : r.error);
  if (r.ok && r.value.status === "CANCELLED") {
    const state = load();
    delete state.subscriptionId;
    save(state);
    console.log("Confirmed CANCELLED; subscriptionId removed from the state file (annualPlanId kept).");
  } else {
    process.exitCode = 1;
    console.error("NOT CONFIRMED CANCELLED: check PayPal by hand.");
  }
}

const commands: Record<string, () => Promise<void>> = { prepare, offer, status, cancel };
const command = commands[process.argv[2] ?? ""];
if (!command) { console.error("Usage: paypal:annual-check -- prepare|offer|status|cancel"); process.exit(1); }
command().catch((e) => { console.error(describe(e)); process.exit(1); });

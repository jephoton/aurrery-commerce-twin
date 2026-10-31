# M7: Annual-plan offers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the annual prepay plan a real, consent-based PayPal action whose customer outcomes feed the twin. Spec: `docs/superpowers/specs/2026-10-31-m7-annual-plan-design.md`.

**Architecture:** Approach A.
- **Action:** a new hash-bound action (`annual_plan_offer`) goes through the existing approve → claim → execute path. Execution creates a yearly plan and requests a PayPal `revise` approval link per target.
- **Tracking:** a separate offer tracker works out pending, switched or expired from PayPal read-backs.
- **Learning:** resolved offers update the twin's per-segment `annualUptake` Beta prior on a read-time copy.

**Tech stack:** TypeScript, Next.js 16, Zod 4, `@paypal/paypal-server-sdk` 2.5, Vitest, Node 24.

**Phasing:** Phase 1 (this document, fully specified) is the live sandbox check and self-contained building blocks with no user-visible change. Phase 2 (integration) is written as its own plan after Task 3 reports, because its ledger, execution and tracker details depend on the check's findings: link format and expiry, `revise` retry behaviour, and when `plan_id` changes. Phase 2's scope is listed at the end so nothing in the spec is lost.

**Conventions:**
- Branch `feat/m7-annual-plan`.
- Conventional Commits, with **no** AI co-author trailers.
- Preserve each file's line endings.
- Never log, commit or return approval links outside the live check's console output.
- After each task: `npm test -- --maxWorkers=2`, `npm run typecheck`, `npm run lint`, and update `docs/current-state.md`.

---

## File map (Phase 1)

| File | Responsibility |
| --- | --- |
| `src/paypal/plans.ts` (new) | Create and read the yearly plan; request a subscriber's switch to it (`revise`) |
| `src/paypal/plans.test.ts` (new) | Adapter tests against a fake SDK |
| `scripts/paypal-annual-check.ts` (new) | Live sandbox check on a disposable subscription |
| `src/ledger/annual-offer-action.ts` (new) | `annual_plan_offer` payload schema, price maths, pure builder |
| `src/ledger/annual-offer-action.test.ts` (new) | Payload tests |
| `src/ledger/annual-offer-status.ts` (new) | Pure offer status from reads, expiry, per-segment counts |
| `src/ledger/annual-offer-status.test.ts` (new) | Status tests |
| `src/twin/calibrate.ts` (modify) | `updateAnnualUptake` Beta update |
| `src/twin/calibrate.test.ts` (modify) | Uptake update tests |
| `docs/decisions/0008-annual-plan-offers.md` (new) | Sandbox check findings and go/no-go |

---

### Task 1: PayPal plan and revise adapter

**Files:** create `src/paypal/plans.ts` and `src/paypal/plans.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/paypal/plans.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = { createBillingPlan: vi.fn(), getBillingPlan: vi.fn(), reviseSubscription: vi.fn() };
vi.mock("./client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./client")>()), paypal: () => ({ subscriptions: sdk }) }));
const { createAnnualPlan, getPlan, reviseToPlan } = await import("./plans");

const plan = {
  id: "P-ANNUAL0000000000000000000", status: "ACTIVE", productId: "PROD-RIDGELINE00000000",
  billingCycles: [{ tenureType: "REGULAR", sequence: 1, frequency: { intervalUnit: "YEAR", intervalCount: 1 }, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }],
};

describe("annual plan adapter", () => {
  beforeEach(() => { for (const fn of Object.values(sdk)) fn.mockReset(); });

  it("creates one yearly regular cycle at the exact price under the given request ID", async () => {
    sdk.createBillingPlan.mockResolvedValue({ result: plan, statusCode: 201, headers: { "paypal-debug-id": "dbg1" } });
    const r = await createAnnualPlan({ productId: "PROD-RIDGELINE00000000", annualPrice: "244.80", requestId: "req-1", name: "Annual" });
    expect(r).toEqual({ ok: true, debugId: "dbg1", value: { planId: plan.id, status: "ACTIVE", productId: plan.productId, price: "244.80", intervalUnit: "YEAR", intervalCount: 1 } });
    const call = sdk.createBillingPlan.mock.calls[0][0];
    expect(call.paypalRequestId).toBe("req-1");
    expect(call.body.billingCycles).toEqual([{ frequency: { intervalUnit: "YEAR", intervalCount: 1 }, tenureType: "REGULAR", sequence: 1, totalCycles: 0, pricingScheme: { fixedPrice: { currencyCode: "USD", value: "244.80" } } }]);
    expect(call.body.productId).toBe("PROD-RIDGELINE00000000");
  });

  it("reads a plan back into the same snapshot shape", async () => {
    sdk.getBillingPlan.mockResolvedValue({ result: plan, statusCode: 200, headers: {} });
    expect(await getPlan(plan.id)).toMatchObject({ ok: true, value: { planId: plan.id, price: "244.80", intervalUnit: "YEAR" } });
    expect(sdk.getBillingPlan).toHaveBeenCalledWith(plan.id);
  });

  it("requests a switch and returns the customer approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue({ result: { planId: plan.id, links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve?token=x" }, { rel: "self", href: "https://api" }] }, statusCode: 200, headers: { "paypal-debug-id": "dbg2" } });
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://aurrery.example/return")).toEqual({ ok: true, debugId: "dbg2", value: { approvalUrl: "https://www.sandbox.paypal.com/approve?token=x", planId: plan.id } });
    expect(sdk.reviseSubscription).toHaveBeenCalledWith({ id: "I-SUB0000001", body: { planId: plan.id, applicationContext: { returnUrl: "https://aurrery.example/return", cancelUrl: "https://aurrery.example/return" } } });
  });

  it("fails closed when PayPal returns no approval link", async () => {
    sdk.reviseSubscription.mockResolvedValue({ result: { planId: plan.id, links: [] }, statusCode: 200, headers: {} });
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://x.example/r")).toMatchObject({ ok: false, error: { name: "MISSING_APPROVAL_LINK" } });
  });

  it("normalises SDK errors", async () => {
    sdk.reviseSubscription.mockRejectedValue(new Error("socket hang up"));
    expect(await reviseToPlan("I-SUB0000001", plan.id, "https://x.example/r")).toMatchObject({ ok: false, error: { name: "NETWORK_OR_CLIENT_ERROR", httpStatus: null } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/paypal/plans.test.ts`
Expected: FAIL (`Cannot find module './plans'`).

- [ ] **Step 3: Implement**

```ts
// src/paypal/plans.ts
import "server-only";
import { IntervalUnit, TenureType, type BillingPlan } from "@paypal/paypal-server-sdk";
import { paypal, toFailure } from "./client";
import type { Result } from "./subscriptions";

// Annual-plan offers: create the yearly plan an approved offer names, and ask PayPal to switch a
// subscriber to it. The switch needs the subscriber's consent, so PayPal returns an approval link.

export interface PlanSnapshot {
  planId: string;
  status: string;
  productId: string | null;
  price: string | null;
  intervalUnit: string | null;
  intervalCount: number | null;
}

function planSnapshot(p: BillingPlan): PlanSnapshot {
  const regular = p.billingCycles?.find((c) => c.tenureType === "REGULAR");
  return {
    planId: p.id ?? "",
    status: String(p.status ?? "UNKNOWN"),
    productId: p.productId ?? null,
    price: regular?.pricingScheme?.fixedPrice?.value ?? null,
    intervalUnit: regular?.frequency?.intervalUnit ?? null,
    intervalCount: regular?.frequency?.intervalCount ?? null,
  };
}

/** Create a yearly plan. A repeated `requestId` makes PayPal return the original plan. */
export async function createAnnualPlan(input: { productId: string; annualPrice: string; requestId: string; name: string }): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.createBillingPlan({
      paypalRequestId: input.requestId,
      prefer: "return=representation",
      body: {
        productId: input.productId,
        name: input.name,
        description: "One prepaid year of the monthly coffee subscription",
        billingCycles: [{
          frequency: { intervalUnit: IntervalUnit.Year, intervalCount: 1 },
          tenureType: TenureType.Regular,
          sequence: 1,
          totalCycles: 0,
          pricingScheme: { fixedPrice: { currencyCode: "USD", value: input.annualPrice } },
        }],
        paymentPreferences: { autoBillOutstanding: true, paymentFailureThreshold: 2 },
      },
    });
    return { ok: true, value: planSnapshot(res.result), debugId: res.headers?.["paypal-debug-id"] ?? null };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export async function getPlan(planId: string): Promise<Result<PlanSnapshot>> {
  try {
    const res = await paypal().subscriptions.getBillingPlan(planId);
    return { ok: true, value: planSnapshot(res.result), debugId: res.headers?.["paypal-debug-id"] ?? null };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}

export interface ReviseOffer {
  /** Secret, per-subscriber customer approval link. Never log or return it to visitors. */
  approvalUrl: string;
  planId: string | null;
}

/** Ask PayPal to switch a subscription to `planId`. The customer must open the approval link. */
export async function reviseToPlan(subscriptionId: string, planId: string, returnUrl: string): Promise<Result<ReviseOffer>> {
  try {
    const res = await paypal().subscriptions.reviseSubscription({
      id: subscriptionId,
      body: { planId, applicationContext: { returnUrl, cancelUrl: returnUrl } },
    });
    const debugId = res.headers?.["paypal-debug-id"] ?? null;
    const approvalUrl = res.result.links?.find((l) => l.rel === "approve")?.href;
    if (!approvalUrl) {
      return { ok: false, error: { httpStatus: res.statusCode, name: "MISSING_APPROVAL_LINK", message: "PayPal accepted the revision without an approval link.", debugId, details: null } };
    }
    return { ok: true, value: { approvalUrl, planId: res.result.planId ?? null }, debugId };
  } catch (e) {
    return { ok: false, error: toFailure(e) };
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/paypal/plans.test.ts && npm run typecheck`
Expected: 5 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/paypal/plans.ts src/paypal/plans.test.ts
git commit -m "feat(paypal): add annual plan creation and revise adapter"
```

### Task 2: Live sandbox check script

**Files:** create `scripts/paypal-annual-check.ts`; modify `package.json`.

- [ ] **Step 1: Write the script**

```ts
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
  console.log(`Approve it as the sandbox personal account: ${res.result.links?.find((l) => l.rel === "approve")?.href}`);
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
    const created = await createAnnualPlan({ productId, annualPrice: "244.80", requestId: "aurrery-m7-annual-check-plan-v1", name: "Roaster's Choice (annual prepay, check)" });
    if (!created.ok) throw new Error(`Plan creation failed: ${JSON.stringify(created.error)}`);
    planId = created.value.planId;
    save({ ...state, annualPlanId: planId });
  }
  const plan = await getPlan(planId);
  console.log("plan", plan.ok ? plan.value : plan.error);
  for (const attempt of [1, 2]) {
    const revised = await reviseToPlan(id, planId, RETURN_URL);
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
```

```bash
npm pkg set scripts.paypal:annual-check="tsx --env-file-if-exists=.env.local --conditions=react-server scripts/paypal-annual-check.ts"
```

- [ ] **Step 2: Typecheck, lint and check usage without network**

Run: `npm run typecheck && npm run lint && npm run paypal:annual-check`
Expected: no errors. The last command prints the usage line and exits 1 with no network call.

- [ ] **Step 3: Commit**

```bash
git add scripts/paypal-annual-check.ts package.json
git commit -m "feat(paypal): add live annual-plan sandbox check script"
```

### Task 3 (needs Jethro): run the sandbox check and decide go/no-go

This creates one disposable Sandbox subscription (needing Jethro's permission and two buyer approvals) and cancels it at the end. Pilots A–D are never touched.

- [ ] **Step 1:** `npm run paypal:annual-check -- prepare`. Jethro opens the printed link as the **sandbox personal** account and approves.
- [ ] **Step 2:** `npm run paypal:annual-check -- status`. Expected: `ACTIVE` on the monthly plan.
- [ ] **Step 3:** `npm run paypal:annual-check -- offer`. Record:
  - the plan snapshot (YEAR, 244.80);
  - both revise results: HTTP outcome, whether the links differ, any expiry hint in the link or response.

  **If either revise fails with `PLAN_PRODUCT_NOT_COMPATIBLE` or any other refusal, stop here, cancel, and report: M7 needs redesign.**
- [ ] **Step 4:** Run `status` *before* approval and record `planId`. Jethro then approves the **second** link as the sandbox customer. Run `status` again and record `planId`, `regularPrice`, `nextBillingTime`, `lastPayment` and timing. Jethro then tries the **first** link and reports what PayPal shows.
- [ ] **Step 5:** `npm run paypal:annual-check -- cancel`. Expected: `CANCELLED`, GET-verified.
- [ ] **Step 6: Record the findings** in `docs/decisions/0008-annual-plan-offers.md`. Use these headings, filled with the observed values:
  - Status (go / no-go, with date)
  - Switch accepted (monthly → yearly)
  - Approval link format and expiry
  - Repeated `revise` behaviour
  - When `plan_id` changes on read-back
  - Charge timing
  - Disposable subscription cancelled (verified)
  - Implications for Phase 2

  Also update `docs/current-state.md`.
- [ ] **Step 7: Commit**

```bash
git add docs/decisions/0008-annual-plan-offers.md docs/current-state.md
git commit -m "docs(m7): record annual-plan sandbox check findings"
```

### Task 4: `annual_plan_offer` payload schema and builder

**Files:** create `src/ledger/annual-offer-action.ts` and `src/ledger/annual-offer-action.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ledger/annual-offer-action.test.ts
import { describe, expect, it } from "vitest";
import type { Strategy } from "@/twin/interventions";
import { AnnualOfferActionSchema, annualPriceCents, buildAnnualOfferAction } from "./annual-offer-action";

const annual: Strategy = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] } };
const eligible = [
  { subscriptionId: "I-AAAAAAAAAA01", label: "Pilot A", segment: "cancel_intent", reason: "price" },
  { subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other" },
  { subscriptionId: "I-EEEEEEEEEE05", label: "Pilot E", segment: "core", reason: "other" },
];
const input = { strategy: annual, listPrice: 24, productId: "PROD-RIDGELINE00000000", monthlyPlanId: "P-MONTHLY0000000000000000000", offerWindowDays: 7, eligible };

describe("annual offer action", () => {
  it("targets eligible pilots in the strategy's segments at list × 12 × (1 − discount)", () => {
    expect(buildAnnualOfferAction(input)).toEqual({
      type: "annual_plan_offer", productId: input.productId, monthlyPlanId: input.monthlyPlanId, currency: "USD",
      listPrice: "24.00", discountPct: 15, annualPrice: "244.80", offerWindowDays: 7, segments: ["core", "price_sensitive"],
      targets: [
        { subscriptionId: "I-DDDDDDDDDD04", label: "Pilot D", segment: "core", reason: "other" },
        { subscriptionId: "I-EEEEEEEEEE05", label: "Pilot E", segment: "core", reason: "other" },
      ],
    });
  });

  it("computes the annual price in exact cents", () => {
    expect(annualPriceCents("24.00", 15)).toBe(24480);
    expect(annualPriceCents("19.99", 10)).toBe(21589);
    expect(annualPriceCents("bad", 10)).toBeNull();
  });

  it("refuses non-annual strategies and empty target sets", () => {
    expect(() => buildAnnualOfferAction({ ...input, strategy: { ...annual, intervention: { kind: "list_price_change", newPrice: 27 } } })).toThrow("Not an annual-plan strategy");
    expect(() => buildAnnualOfferAction({ ...input, eligible: eligible.slice(0, 1) })).toThrow("No eligible subscribers");
  });

  it("rejects tampered or invalid payloads", () => {
    const valid = buildAnnualOfferAction(input);
    for (const bad of [
      { ...valid, annualPrice: "200.00" },
      { ...valid, offerWindowDays: 0 },
      { ...valid, offerWindowDays: 31 },
      { ...valid, targets: [valid.targets[0], valid.targets[0]] },
      { ...valid, targets: [{ ...valid.targets[0], segment: "at_risk" }] },
      { ...valid, currency: "EUR" },
      { ...valid, extra: true },
    ]) expect(AnnualOfferActionSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts`
Expected: FAIL (`Cannot find module './annual-offer-action'`).

- [ ] **Step 3: Implement**

```ts
// src/ledger/annual-offer-action.ts
import { z } from "zod";
import type { Strategy } from "@/twin/interventions";
import { REASONS, SEGMENTS } from "@/twin/types";
import { usdCents } from "@/paypal/prices";

// The exact payload a merchant approves for an annual-plan offer. Its SHA-256 hash binds the
// approval; execution may only do what this payload says.

export const MAX_ANNUAL_TARGETS = 25;
const Money = z.string().regex(/^\d+\.\d{2}$/);

export const AnnualOfferTargetSchema = z.object({
  subscriptionId: z.string().regex(/^I-[A-Z0-9]+$/),
  label: z.string().min(1),
  segment: z.enum(SEGMENTS),
  reason: z.enum(REASONS),
}).strict();

/** list × 12 × (1 − discount%), rounded to the cent, without float drift. */
export function annualPriceCents(listPrice: string, discountPct: number): number | null {
  const list = usdCents(listPrice);
  return list === null ? null : Math.round((list * 12 * (100 - discountPct)) / 100);
}

const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export const AnnualOfferActionSchema = z.object({
  type: z.literal("annual_plan_offer"),
  productId: z.string().regex(/^PROD-[A-Z0-9]+$/),
  monthlyPlanId: z.string().regex(/^P-[A-Z0-9]+$/),
  currency: z.literal("USD"),
  listPrice: Money,
  discountPct: z.number().min(0).max(40),
  annualPrice: Money,
  offerWindowDays: z.number().int().min(1).max(30),
  segments: z.array(z.enum(SEGMENTS)).min(1),
  targets: z.array(AnnualOfferTargetSchema).min(1).max(MAX_ANNUAL_TARGETS),
}).strict().superRefine((action, ctx) => {
  if (usdCents(action.annualPrice) !== annualPriceCents(action.listPrice, action.discountPct))
    ctx.addIssue({ code: "custom", message: "Annual price does not match the list price and discount", path: ["annualPrice"] });
  if (new Set(action.targets.map((t) => t.subscriptionId)).size !== action.targets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate annual offer target", path: ["targets"] });
  if (action.targets.some((t) => !action.segments.includes(t.segment)))
    ctx.addIssue({ code: "custom", message: "Target outside the offered segments", path: ["targets"] });
});
export type AnnualOfferAction = z.infer<typeof AnnualOfferActionSchema>;

export interface AnnualOfferCandidate { subscriptionId: string; label: string; segment: string; reason: string }

/**
 * Build the payload from candidates that the caller has ALREADY checked are eligible:
 * registered, ACTIVE, at list price, on `monthlyPlanId`, with no unresolved claim.
 */
export function buildAnnualOfferAction(input: {
  strategy: Strategy; listPrice: number; productId: string; monthlyPlanId: string; offerWindowDays: number; eligible: AnnualOfferCandidate[];
}): AnnualOfferAction {
  const iv = input.strategy.intervention;
  if (iv.kind !== "annual_plan") throw new Error("Not an annual-plan strategy.");
  const listPrice = input.listPrice.toFixed(2);
  const targets = input.eligible
    .filter((s) => (iv.segments as readonly string[]).includes(s.segment))
    .slice(0, MAX_ANNUAL_TARGETS)
    .map(({ subscriptionId, label, segment, reason }) => ({ subscriptionId, label, segment, reason }));
  if (targets.length === 0) throw new Error(`No eligible subscribers in segments ${iv.segments.join(", ")}.`);
  const cents = annualPriceCents(listPrice, iv.discountPct);
  if (cents === null) throw new Error("Invalid list price.");
  return AnnualOfferActionSchema.parse({
    type: "annual_plan_offer", productId: input.productId, monthlyPlanId: input.monthlyPlanId, currency: "USD",
    listPrice, discountPct: iv.discountPct, annualPrice: money(cents), offerWindowDays: input.offerWindowDays,
    segments: [...iv.segments], targets,
  });
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts && npm run typecheck`
Expected: 4 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/annual-offer-action.ts src/ledger/annual-offer-action.test.ts
git commit -m "feat(ledger): add annual-plan offer payload schema and builder"
```

### Task 5: Offer status from PayPal reads

**Files:** create `src/ledger/annual-offer-status.ts` and `src/ledger/annual-offer-status.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ledger/annual-offer-status.test.ts
import { describe, expect, it } from "vitest";
import { countResolvedOffers, offerExpiry, offerStatus } from "./annual-offer-status";

const offer = { annualPlanId: "P-ANNUAL", expiresAt: "2026-11-08T00:00:00.000Z" };
const read = (observedAt: string, status: string, planId: string | null) => ({ observedAt, status, planId });

describe("annual offer status", () => {
  it("is pending until a switch is observed or the offer expires", () => {
    expect(offerStatus(offer, [read("2026-11-02T00:00:00Z", "ACTIVE", "P-MONTHLY")], new Date("2026-11-03T00:00:00Z"))).toEqual({ status: "pending", resolvedAt: null });
  });
  it("is switched at the first ACTIVE read on the annual plan", () => {
    const reads = [read("2026-11-04T00:00:00Z", "ACTIVE", "P-ANNUAL"), read("2026-11-03T00:00:00Z", "ACTIVE", "P-ANNUAL")];
    expect(offerStatus(offer, reads, new Date("2026-11-05T00:00:00Z"))).toEqual({ status: "switched", resolvedAt: "2026-11-03T00:00:00Z" });
  });
  it("ignores annual-plan reads that are not ACTIVE", () => {
    expect(offerStatus(offer, [read("2026-11-03T00:00:00Z", "APPROVAL_PENDING", "P-ANNUAL")], new Date("2026-11-04T00:00:00Z")).status).toBe("pending");
  });
  it("expires at the deadline, but a later observed switch still counts", () => {
    expect(offerStatus(offer, [], new Date("2026-11-08T00:00:00Z"))).toEqual({ status: "expired", resolvedAt: offer.expiresAt });
    expect(offerStatus(offer, [read("2026-11-09T00:00:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-10T00:00:00Z")).status).toBe("switched");
  });
  it("expires at the earlier of the offer window and PayPal's link expiry", () => {
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7)).toBe("2026-11-08T00:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-11-01T03:00:00.000Z")).toBe("2026-11-01T03:00:00.000Z");
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7, "2026-12-01T00:00:00.000Z")).toBe("2026-11-08T00:00:00.000Z");
  });
  it("counts resolved offers per segment and ignores pending ones", () => {
    expect(countResolvedOffers([
      { segment: "core", status: "switched" }, { segment: "core", status: "expired" },
      { segment: "core", status: "pending" }, { segment: "price_sensitive", status: "expired" },
    ])).toEqual([
      { segment: "core", accepted: 1, expired: 1, pending: 1 },
      { segment: "price_sensitive", accepted: 0, expired: 1, pending: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ledger/annual-offer-status.test.ts`
Expected: FAIL (`Cannot find module './annual-offer-status'`).

- [ ] **Step 3: Implement**

```ts
// src/ledger/annual-offer-status.ts
import { SEGMENTS, type SegmentId } from "@/twin/types";

// An offer's status is derived from recorded PayPal reads, never stored as truth. A switch counts
// only when PayPal reads the subscription back ACTIVE on the offered annual plan.

export type OfferStatus = "pending" | "switched" | "expired";
export interface OfferFacts { annualPlanId: string; expiresAt: string }
export interface OfferRead { observedAt: string; status: string; planId: string | null }

export function offerStatus(offer: OfferFacts, reads: OfferRead[], now: Date): { status: OfferStatus; resolvedAt: string | null } {
  const switched = reads
    .filter((r) => r.status === "ACTIVE" && r.planId === offer.annualPlanId)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
  if (switched) return { status: "switched", resolvedAt: switched.observedAt };
  if (now.getTime() >= Date.parse(offer.expiresAt)) return { status: "expired", resolvedAt: offer.expiresAt };
  return { status: "pending", resolvedAt: null };
}

/** The earlier of the merchant's offer window and any expiry PayPal attaches to the approval link. */
export function offerExpiry(offeredAt: string, windowDays: number, paypalExpiresAt?: string | null): string {
  const window = Date.parse(offeredAt) + windowDays * 86_400_000;
  const paypal = paypalExpiresAt ? Date.parse(paypalExpiresAt) : Number.POSITIVE_INFINITY;
  return new Date(Math.min(window, paypal)).toISOString();
}

export interface SegmentOfferCounts { segment: SegmentId; accepted: number; expired: number; pending: number }

export function countResolvedOffers(offers: { segment: SegmentId; status: OfferStatus }[]): SegmentOfferCounts[] {
  return SEGMENTS
    .map((segment) => {
      const own = offers.filter((o) => o.segment === segment);
      return {
        segment,
        accepted: own.filter((o) => o.status === "switched").length,
        expired: own.filter((o) => o.status === "expired").length,
        pending: own.filter((o) => o.status === "pending").length,
      };
    })
    .filter((c) => c.accepted + c.expired + c.pending > 0);
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/ledger/annual-offer-status.test.ts && npm run typecheck`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/annual-offer-status.ts src/ledger/annual-offer-status.test.ts
git commit -m "feat(ledger): derive annual offer status from PayPal reads"
```

### Task 6: Annual-uptake learning

**Files:** modify `src/twin/calibrate.ts` and `src/twin/calibrate.test.ts`.

- [ ] **Step 1: Write the failing tests** (append to `src/twin/calibrate.test.ts`; add any missing imports at the top: `buildDemoTwin` from `@/merchant/demo`, and `updateAnnualUptake` and `betaMean` from `./calibrate`)

```ts
describe("annual uptake learning", () => {
  const twin = buildDemoTwin().twin;
  it("adds accepted and expired offers to the segment's Beta prior and marks it observed", () => {
    const before = twin.params.segments.core.annualUptake;
    const { twin: updated, changes } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, expired: 1 }]);
    expect(updated.params.segments.core.annualUptake).toEqual({ alpha: before.alpha + 1, beta: before.beta + 1 });
    expect(updated.provenance["annualUptake.core"]).toMatchObject({ source: "observed", evidenceCount: 2 });
    expect(updated.provenance["annualUptake.core"].note).toContain("1 accepted of 2 resolved");
    expect(changes).toEqual([expect.objectContaining({ parameter: "annualUptake.core", evidence: "1 accepted of 2 resolved annual offer(s)" })]);
    expect(changes[0].before.mean).toBeCloseTo(betaMean(before));
  });
  it("leaves other segments and the canonical twin untouched, and ignores empty counts", () => {
    const original = structuredClone(twin);
    const { twin: updated, changes } = updateAnnualUptake(twin, [{ segment: "core", accepted: 1, expired: 0 }, { segment: "new", accepted: 0, expired: 0 }]);
    expect(updated.params.segments.new).toEqual(twin.params.segments.new);
    expect(changes.map((c) => c.parameter)).toEqual(["annualUptake.core"]);
    expect(twin).toEqual(original);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/twin/calibrate.test.ts -t "annual uptake"`
Expected: FAIL (`updateAnnualUptake` is not exported).

- [ ] **Step 3: Implement.** Append to `src/twin/calibrate.ts`, reusing the existing `betaMean`, `betaSd`, `ParameterChange`, `MerchantTwin` and `SegmentId` imports in that file:

```ts
export interface AnnualOfferOutcome { segment: SegmentId; accepted: number; expired: number }

/**
 * Annual-plan uptake per segment: Beta(prior α + accepted, prior β + expired). Only offers whose
 * outcome PayPal has resolved count; pending offers are excluded by the caller.
 */
export function updateAnnualUptake(twin: MerchantTwin, outcomes: AnnualOfferOutcome[]): { twin: MerchantTwin; changes: ParameterChange[] } {
  let params = twin.params;
  let provenance = twin.provenance;
  const changes: ParameterChange[] = [];
  for (const { segment, accepted, expired } of outcomes) {
    if (accepted + expired === 0) continue;
    const before = params.segments[segment].annualUptake;
    const after = { alpha: before.alpha + accepted, beta: before.beta + expired };
    const parameter = `annualUptake.${segment}`;
    const evidence = `${accepted} accepted of ${accepted + expired} resolved annual offer(s)`;
    params = { ...params, segments: { ...params.segments, [segment]: { ...params.segments[segment], annualUptake: after } } };
    provenance = { ...provenance, [parameter]: { source: "observed", note: `Prior assumption updated with ${evidence} (sandbox demonstration).`, evidenceCount: accepted + expired } };
    changes.push({ parameter, before: { mean: betaMean(before), sd: betaSd(before) }, after: { mean: betaMean(after), sd: betaSd(after) }, evidence });
  }
  return { twin: { ...twin, params, provenance }, changes };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/twin/calibrate.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/twin/calibrate.ts src/twin/calibrate.test.ts
git commit -m "feat(twin): learn annual-plan uptake from resolved offers"
```

---

## Phase 2 scope (separate plan, written after Task 3)

Each item maps to a section of the spec. The detailed tasks depend on Task 3's findings.

1. **Ledger:**
   - `annual_plan_offer` joins `ProposalAction` (parse, hash, claims and conflict rules);
   - `annual_offers` and `annual_offer_reads` tables in the canonical schema;
   - eligibility check (ACTIVE, list price, on `paypal.plan_id`, no unresolved claim) at build time and just before `revise`.
2. **Execution:** plan creation with a request ID derived from the action hash, plus read-back verification; per-target `revise`; storing links and expiries; terminal statuses and reconciliation for ambiguous responses. `revise` retry behaviour follows Task 3.
3. **Tracker:** the PayPal status refresh also reads subscriptions with pending offers and appends reads; derived statuses come from Task 5.
4. **Learning:** the observed-merchant path applies `updateAnnualUptake` from `countResolvedOffers` on a copy; the evidence panel adds an "Annual offers" line.
   - **From the Task 6 review:** `ObservedSnapshot.changes` is capped at `.max(2)` (`src/merchant/observed-snapshot.ts`), sized for the two discount reasons. Keep annual changes in their own field (or raise the cap) or snapshots throw.
   - `EvidencePanel` puts every change under the discount block, and `observed.ts` adds the discount `OUTCOME_LIMITATION` to every changed note. Annual changes need their own "Annual offers" block and their own limitation text.
   - Reword the group `annualUptake` assumption note in `src/merchant/demo.ts` ("no annual plan has been tried") so it doesn't contradict observed per-segment rows.
   - Task 6 as built uses `accepted`/`declined` and the key `segments.<segment>.annualUptake`; the Task 6 code sample above predates the spec amendments.
5. **Routes and UI:**
   - an admin-guarded links endpoint; the public status payload carries no links;
   - an approval card for annual offers (window 1–30, consent statements);
   - an "Annual offers" panel with a draft customer message and copy button for administrators;
   - headline: `isExecutable` includes annual plans, the budget rule covers retention discounts only, and "Also executable within your rules" is added.
6. **Agent:** instructions and `recommend` allow `annual_plan_offer` proposals.
7. **Ledger tools:** export/import of both tables with strict validation; the admin reset skips annual-plan subscribers with an explicit report.
8. **Setup:** Pilot E (core, other) added to `PILOT_COHORT` and created through `paypal:setup` (one buyer approval).
9. **Acceptance:** run the full suite and CI, deploy, approve on the hosted demo as administrator, approve E's link as the sandbox customer, then check that E is switched, D is pending, and the evidence update shows in the browser.

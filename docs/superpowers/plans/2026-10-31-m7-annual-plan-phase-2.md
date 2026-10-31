# M7 Phase 2: Annual-plan offers integration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 building blocks into a working, consent-based annual-plan offer. An administrator approves an exact offer. Aurrery creates the yearly plan, asks PayPal to switch each eligible pilot, tracks each customer's choice from PayPal read-backs, and feeds resolved offers into the twin's per-segment annual uptake.

**Architecture:** Approach A from the spec.
- **Action:** `annual_plan_offer` joins the hash-bound proposal union. It uses the unchanged approve → claim → execute state machine and claims.
- **Execution:** a separate annual executor creates and verifies the yearly plan, then calls `revise` at most once per target. Each secret approval link is stored only in `annual_offers.approval_url`.
- **Tracking:** every successful PayPal status GET appends one read per offer to `annual_offer_reads`. Status and learning outcomes are derived from those reads (Phase 1's `annual-offer-status.ts`).
- **Learning:** the observed-merchant path applies `updateAnnualUptake(countResolvedOffers(...))` on a request-owned copy, kept separate from discount evidence.

**Tech Stack:** TypeScript, Next.js 16.4 (App Router, Cache Components), React 19.3, Zod 4, `@paypal/paypal-server-sdk` 2.5, `node:sqlite` and `@libsql/client` (Turso), Vitest 5, Node 24.

**Inputs (binding):**
- Spec: `docs/superpowers/specs/2026-10-31-m7-annual-plan-design.md`, with its amendments.
- Decision: `docs/decisions/0008-annual-plan-offers.md` (live sandbox findings).
- Phase 1 plan: `docs/superpowers/plans/2026-10-31-m7-annual-plan.md`, section "Phase 2 scope".
- **The committed Phase 1 code is the source of truth**, not the Phase 1 plan's samples: `src/paypal/plans.ts`, `src/paypal/client.ts`, `src/paypal/prices.ts`, `src/ledger/annual-offer-action.ts`, `src/ledger/annual-offer-status.ts`, `src/twin/calibrate.ts` (`updateAnnualUptake`).

---

## Conventions

- **Branch:** `feat/m7-annual-plan`, local only. Nothing is pushed, merged or deployed before Task 23's explicit approval from Jethro.
- **Commits:** Conventional Commits, one logical change each. **Never** add `Co-Authored-By` or any AI trailer, and no "Generated with" lines.
- **Line endings:** preserve each file's existing line endings; new files use LF.
- **Secrets:** never log, commit or return approval links. Tests use fake links containing `ba_token=BA-TEST...` or `BA-FIXTURE...`; real tokens never enter the repository. Never touch `data/` (private, git-ignored).
- **Sandbox only:** no task calls PayPal except the human checkpoints (Tasks 22 and 23).
- **Next.js 16:** this is not the Next.js in training data.
  - Before changing a route or page, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `.../08-caching.md`.
  - `cacheComponents` is on (`next.config.ts`). Every GET handler that touches storage or PayPal calls `await connection()` from `next/server` **first**, as `src/app/api/paypal/status/route.ts` already does.
- **Workers:** run `npm run build:workers` once at the start of a session. Targeted `npx vitest run <file>` commands assume the worker bundle exists.
- **After every task:**
  1. Run `npm test -- --maxWorkers=2`, `npm run typecheck` and `npm run lint`. All must pass.
  2. Append a short entry under a `## M7 Phase 2` heading in `docs/current-state.md`: what changed, the test count, and the next task. No user-specific paths, secrets or links.
  3. Commit it on its own as `docs: record M7 Phase 2 Task N`.

  Task steps below show only the code commit; this handoff commit always follows it.

## Design decisions this plan locks in

Where the spec is silent, this plan decides as follows. Task 21 records these in decision 0008.

1. **Pre-revise failures fail the proposal.** Until the first `revise`, nothing customer-facing has happened. So these finish the proposal `failed`, with one recorded outcome per target ending "no offer was made":
   - a changed `paypal.plan_id`;
   - a monthly plan on another product;
   - a refused plan creation;
   - an unreadable or mismatched plan read-back.

   An orphan yearly plan is harmless. The same action hash always reuses the same `PayPal-Request-Id`.
2. **Ambiguity follows the existing convention.** These leave the proposal `executing` with its claims kept, and no retry (`ExecutionReconciliationRequired`):
   - a failed subscription pre-read;
   - a non-definitive `revise` failure, including HTTP 200 without a usable link;
   - a mismatched returned `planId`;
   - any storage failure.

   Definitive failures are exactly `execute.ts`'s list (400, 401, 403, 404, 422), extracted as `isDefinitiveFailure`.
3. **Open offer.** Any offer that is not a confirmed decline (pending, awaiting final check, invalid or switched) blocks another offer to the same subscriber. This check runs at build time, in the claim, and just before `revise`.
4. **Export includes approval links.** `ledger:export` is the authoritative private backup, at the same trust level as the hosted session fingerprints it already holds.
   - Dropping links would change row hashes and make restored open offers unservable.
   - The export and import CLIs print only counts and hashes.
   - The importer refuses any ledger where a link, or a `ba_token`, appears outside `annual_offers.approval_url`.
5. **Links are served only while the window is open.** The admin endpoint returns drafts only for `pending` offers. After the window, the UI says "offer window closed", never that a link is dead.
6. **Execution record.** Each `revise` writes one `executions` row with operation `POST subscription revise (annual plan)`.
   - It has `verified = 0`, because the switch is verified only by a later read-back.
   - Its outcome carries `offer: { annualPlanId, expiresAt }`.
   - `UNIQUE (proposal_id, target_id, operation)` makes a second record for the same target impossible.
7. **Offer window.** The merchant chooses it when preparing the offer (default 7, range 1–30), and it is bound into the hash. The agent uses the default.
8. **Snapshot compatibility.** `ObservedSnapshot.annual` is optional, so recorded agent streams that predate it stay valid. The discount `changes` cap stays `.max(2)`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/ledger/annual-offer-action.ts` (modify) | Exact annual price string, live eligibility check, plan read-back check |
| `src/ledger/annual-offer-status.ts` (modify) | `offerExpiry` without the unused PayPal expiry; `offerView` (derived public view) |
| `src/ledger/annual-offer-message.ts` (new) | Display-only draft customer message (pure) |
| `src/paypal/approval-link.ts` (new) | `isPayPalApprovalUrl`, shared by the adapter and the importer |
| `src/paypal/plans.ts` (modify) | `reviseToPlan` returns the HTTP status |
| `src/execution/outcomes.ts` (new) | `TargetOutcome`, `ExecutionReport`, `ExecutionReconciliationRequired`, definitive-4xx rule |
| `src/execution/annual-offer.ts` (new) | Annual executor (dependency-injected): plan, eligibility re-check, one `revise` per target |
| `src/execution/annual-proposal.ts` (new) | Live-eligibility proposal preparation; `proposeStrategy` dispatch |
| `src/execution/execute.ts` (modify) | Dispatch to the annual executor; refuse annual subscribers in price changes |
| `src/execution/reset.ts` (modify) | Reset preview skips annual subscribers explicitly |
| `src/ledger/db.ts` (modify) | `annual_offers`, `annual_offer_reads` in the canonical schema |
| `src/ledger/annual-offers.ts` (new) | Offer and read records, public views, admin links, evidence, open-offer set |
| `src/ledger/proposals.ts` (modify) | Union member, claim and target checks, outstanding list, annual proposal creation |
| `src/ledger/import.ts` (modify) | Tables, strict annual validation, link secrecy |
| `src/app/api/paypal/status/route.ts` (modify) | Append reads; public offer views; no links |
| `src/app/api/annual-offers/links/route.ts` (new) | Admin-guarded draft messages with links |
| `src/app/api/proposals/route.ts` (modify) | `offerWindowDays`; `proposeStrategy` |
| `src/merchant/observed.ts`, `observed-snapshot.ts`, `demo.ts` (modify) | Annual learning on a copy; separate snapshot field; reworded prior note |
| `src/components/headline.ts`, `DecisionSummary.tsx` (modify) | Annual executable; budget for discounts only; "Also executable within your rules" |
| `src/components/AnnualOfferCard.tsx` (new) | Approval card for an annual offer |
| `src/components/annual-offers-view.ts` (new) | Status labels, counts, UTC formatting (pure) |
| `src/components/AnnualOffersPanel.tsx` (new) | Per-target status for everyone; drafts and copy button for admins |
| `src/components/EvidencePanel.tsx`, `Lab.tsx`, `RecoveryPanel.tsx` (modify) | Annual evidence block, approval and report wiring, "/yr", reset skip text |
| `src/agent/tools.ts`, `src/agent/run.ts` (modify) | `recommend` may propose an annual offer; instructions updated |
| `src/paypal/pilot-cohort.ts` (modify) | Pilot E |
| `src/test/annual-offer-fixture.ts` (new) | Shared offline fixture: one executed annual offer on Pilot D |

## Phase 2 scope coverage

| Phase 1 "Phase 2 scope" item | Task |
| --- | --- |
| 1 Union, parse, hash, claims, conflict rules | 8 |
| 1 Tables in canonical schema | 6 |
| 1 Eligibility at build time and before `revise` | 2, 7, 9 |
| 2 Plan creation (hash request ID), read-back, per-target `revise`, link storage, terminal statuses, ambiguity | 4, 5, 7, 8 |
| 3 Status refresh reads and appends | 12 |
| 4 Observed learning on a copy; evidence "Annual offers" | 14, 15 |
| 4 (Task 6 review) `.max(2)` cap: own field | 14 |
| 4 (Task 6 review) own evidence block and limitation text | 14, 15 |
| 4 (Task 6 review) reword `demo.ts` group note | 14 |
| 4 (final review) unresolved offer blocks another offer | 6, 8, 9 |
| 4 (final review) re-check `paypal.plan_id`, monthly plan's product, returned `planId` | 7, 8 |
| 4 (final review) 200 without usable link: unresolved, operator step documented | 7, 21 |
| 4 (final review) every successful GET appends a read per offer | 6, 12 |
| 4 (final review) `annualPrice` in descriptions; "/yr" in Lab | 1, 18 |
| 4 (final review) override, revert and reset refuse annual subscribers by `planId` | 11 |
| 4 (final review) import validates `segment` and strict `expires_at` | 10 |
| 4 (final review) drop or document `paypalExpiresAt` | 1 (dropped) |
| 5 Admin links endpoint; public payload without links | 12, 13 |
| 5 Approval card (window 1–30, consent statements) | 17 |
| 5 "Annual offers" panel, draft message, copy button | 3, 18 |
| 5 Headline rules and "Also executable within your rules" | 16 |
| 6 Agent may propose; instructions | 19 |
| 7 Export/import strict validation; reset skip report | 10, 11 |
| 8 Pilot E and `paypal:setup` (buyer approval) | 20, 22 |
| 9 Live acceptance | 23 |

Nothing is dropped.

---

### Task 1: Exact annual price, expiry cleanup and offer views (pure)

The final Phase 1 review found two problems:
- `describeIntervention` shows a float-rounded yearly price that can differ from the hashed `action.annualPrice`.
- `offerExpiry` takes a PayPal expiry that decision 0008 proved never exists.

This task also adds the derived offer view used by every later reader.

**Files:**
- Modify: `src/ledger/annual-offer-action.ts`, `src/ledger/annual-offer-status.ts`, `src/twin/interventions.ts`
- Test: `src/ledger/annual-offer-action.test.ts`, `src/ledger/annual-offer-status.test.ts`, create `src/twin/interventions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/ledger/annual-offer-action.test.ts`, and add `annualPriceFor` to its import from `./annual-offer-action`:

```ts
describe("annualPriceFor", () => {
  it("formats the exact cents-based annual price", () => {
    expect(annualPriceFor(24, 15)).toBe("244.80");
    expect(annualPriceFor(19.99, 12.5)).toBe("209.90");
    expect(annualPriceFor(9.99, 5)).toBe("113.89");
    expect(annualPriceFor(Number.NaN, 5)).toBeNull();
  });
});
```

Create `src/twin/interventions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeIntervention } from "./interventions";

describe("describeIntervention", () => {
  it("shows the exact annual price an offer would carry, not a float rounding", () => {
    expect(describeIntervention({ kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] }, 24))
      .toBe("Offer core, price sensitive subscribers an annual prepay plan at 15% off ($244.80/yr).");
    // 19.99 × 12 × 0.875 is 209.894999… in floating point; the offer charges 20990 cents.
    expect(describeIntervention({ kind: "annual_plan", discountPct: 12.5, segments: ["core"] }, 19.99)).toContain("($209.90/yr)");
  });
});
```

In `src/ledger/annual-offer-status.test.ts`:
- add `offerView` to the import list;
- replace the whole `describe("offerExpiry", ...)` block with the block below;
- append the `offerView` block.

```ts
describe("offerExpiry", () => {
  it("expires exactly one merchant offer window after the offer (PayPal gives no link expiry)", () => {
    expect(offerExpiry("2026-11-01T00:00:00.000Z", 7)).toBe("2026-11-08T00:00:00.000Z");
    expect(offerExpiry("2026-11-01T08:00:00+08:00", 1)).toBe("2026-11-02T00:00:00.000Z");
    expect(offerExpiry.length).toBe(2);
  });
  it("rejects invalid inputs with a clear RangeError per cause", () => {
    expect(() => offerExpiry("garbage", 7)).toThrow(/offeredAt/);
    expect(() => offerExpiry("2026-11-01T00:00:00", 7)).toThrow(RangeError);
    for (const days of [0, 31, 1.5, Number.NaN]) {
      expect(() => offerExpiry("2026-11-01T00:00:00.000Z", days)).toThrow(/windowDays/);
    }
  });
});

describe("offerView", () => {
  const record = { id: 1, proposalId: "prop_x", subscriptionId: "I-E", segment: "core" as const, annualPlanId: "P-ANNUAL", offeredAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-08T00:00:00.000Z" };
  it("derives status, outcome and read need from reads without storing them", () => {
    expect(offerView(record, [], new Date("2026-11-02T00:00:00Z")))
      .toEqual({ ...record, status: "pending", outcome: "unresolved", resolvedAt: null, needsRead: true });
    expect(offerView(record, [read("2026-11-01T00:05:00Z", "ACTIVE", "P-ANNUAL")], new Date("2026-11-02T00:00:00Z")))
      .toEqual({ ...record, status: "switched", outcome: "accepted", resolvedAt: "2026-11-01T00:05:00Z", needsRead: false });
    expect(offerView(record, [read("2026-11-08T07:00:00Z", "ACTIVE", "P-MONTHLY")], new Date("2026-11-08T08:00:00Z")))
      .toEqual({ ...record, status: "expired", outcome: "declined", resolvedAt: "2026-11-08T00:00:00.000Z", needsRead: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts src/ledger/annual-offer-status.test.ts src/twin/interventions.test.ts`

Expected: FAIL.
- `annualPriceFor` and `offerView` are not exported.
- `offerExpiry.length` is 3.
- The description shows `$209.89/yr`.

- [ ] **Step 3: Implement**

In `src/ledger/annual-offer-action.ts`, add this directly after the `money` constant:

```ts
/** The exact annual price string an offer for this list price would carry, or null for an invalid price. */
export function annualPriceFor(listPrice: number, discountPct: number): string | null {
  const cents = annualPriceCents(listPrice.toFixed(2), discountPct);
  return cents === null ? null : money(cents);
}
```

In `src/twin/interventions.ts`:
- add `import { annualPriceFor } from "@/ledger/annual-offer-action";`. This is not a runtime cycle: that module imports only `type Strategy` from here.
- replace the `annual_plan` case of `describeIntervention` with:

```ts
    case "annual_plan":
      return `Offer ${intervention.segments.join(", ").replaceAll("_", " ")} subscribers an annual prepay plan at ${intervention.discountPct}% off ($${annualPriceFor(listPrice, intervention.discountPct) ?? "—"}/yr).`;
```

In `src/ledger/annual-offer-status.ts`, replace `offerExpiry` with:

```ts
/** The merchant's offer window is the only expiry: PayPal attaches none to a revise approval link (decision 0008). */
export function offerExpiry(offeredAt: string, windowDays: number): string {
  const offeredMs = parseIsoInstant(offeredAt);
  if (offeredMs === null) throw new RangeError("Invalid offeredAt: expected an ISO-8601 instant with Z or an offset");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    throw new RangeError("Invalid windowDays: expected an integer from 1 to 30");
  }
  return new Date(offeredMs + windowDays * 86_400_000).toISOString();
}
```

Then append to the same file:

```ts
/** One stored offer, without its approval link. */
export interface OfferRecord {
  id: number; proposalId: string; subscriptionId: string; segment: SegmentId;
  annualPlanId: string; offeredAt: string; expiresAt: string;
}
/** Everything a visitor may see about an offer: facts plus derived status. Never the approval link. */
export interface AnnualOfferView extends OfferRecord {
  status: OfferStatus; outcome: OfferOutcome; resolvedAt: string | null; needsRead: boolean;
}

export function offerView(offer: OfferRecord, reads: OfferRead[], now: Date): AnnualOfferView {
  const { status, resolvedAt } = offerStatus(offer, reads, now);
  return { ...offer, status, resolvedAt, outcome: offerOutcome(offer, reads, now), needsRead: needsRead(offer, reads, now) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts src/ledger/annual-offer-status.test.ts src/twin/interventions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/annual-offer-action.ts src/ledger/annual-offer-action.test.ts src/ledger/annual-offer-status.ts src/ledger/annual-offer-status.test.ts src/twin/interventions.ts src/twin/interventions.test.ts
git commit -m "feat(m7): show exact annual prices and derive offer views"
```

---

### Task 2: Live eligibility and plan read-back checks (pure)

These are pure rules applied at build time (Task 9) and again just before `revise` (Task 7). Prices compare by cents, because PayPal reads back `"244.8"`.

**Files:**
- Modify: `src/ledger/annual-offer-action.ts`
- Test: `src/ledger/annual-offer-action.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/ledger/annual-offer-action.test.ts`. Add `annualIneligibility, annualPlanMismatch, INELIGIBILITY_TEXT` to the import, and add `import type { PlanSnapshot } from "@/paypal/plans";`.

```ts
describe("annual offer eligibility from a live read", () => {
  const expected = { subscriptionId: "I-EEEEEEEEEE05", monthlyPlanId: "P-MONTHLY0000000000000000000", listPrice: "24.00" };
  const live = { id: "I-EEEEEEEEEE05", status: "ACTIVE", planId: "P-MONTHLY0000000000000000000", regularPrice: "24.0" };
  it("accepts an ACTIVE subscriber on the monthly plan at list price by cents", () => {
    expect(annualIneligibility(live, expected)).toBeNull();
  });
  it.each([
    [{ ...live, id: "I-OTHER" }, "identity_mismatch"],
    [{ ...live, status: "SUSPENDED" }, "not_active"],
    [{ ...live, planId: "P-ANNUAL0000000000000000000", regularPrice: "244.8" }, "not_monthly_plan"],
    [{ ...live, regularPrice: "18.00" }, "not_list_price"],
    [{ ...live, regularPrice: null }, "not_list_price"],
  ] as const)("refuses %j as %s", (observed, reason) => {
    expect(annualIneligibility(observed, expected)).toBe(reason);
    expect(INELIGIBILITY_TEXT[reason]).toMatch(/no offer was made/);
  });
});

describe("annual plan read-back", () => {
  const action = { productId: "PROD-RIDGELINE00000000", annualPrice: "244.80", currency: "USD" as const };
  const plan: PlanSnapshot = { planId: "P-ANNUAL0000000000000000000", status: "ACTIVE", name: "Annual", productId: action.productId, price: "244.8",
    currency: "USD", intervalUnit: "YEAR", intervalCount: 1, totalCycles: 0, regularCycleCount: 1, cycleCount: 1 };
  it("accepts the exact plan, comparing price by cents", () => expect(annualPlanMismatch(plan, action)).toBeNull());
  it.each([
    [{ planId: "not-a-plan" }, "plan id"], [{ status: "CREATED" }, "status"], [{ productId: "PROD-OTHER" }, "product"],
    [{ currency: "EUR" }, "currency"], [{ price: "244.81" }, "price"], [{ intervalUnit: "MONTH" }, "interval"],
    [{ intervalCount: 2 }, "interval"], [{ cycleCount: 2 }, "billing cycles"], [{ totalCycles: 1 }, "billing cycles"],
  ] as const)("reports %j as a %s mismatch", (change, reason) => {
    expect(annualPlanMismatch({ ...plan, ...change }, action)).toBe(reason);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts`

Expected: FAIL. `annualIneligibility` is not exported.

- [ ] **Step 3: Implement**

In `src/ledger/annual-offer-action.ts`:
- change the prices import to `import { sameUsdAmount, usdCents } from "@/paypal/prices";`;
- add `import type { PlanSnapshot } from "@/paypal/plans";`. It is type-only, so this module stays free of `server-only`.
- append:

```ts
export type AnnualIneligibility = "identity_mismatch" | "not_active" | "not_monthly_plan" | "not_list_price";
export const INELIGIBILITY_TEXT: Record<AnnualIneligibility, string> = {
  identity_mismatch: "PayPal returned a different subscription; no offer was made.",
  not_active: "Subscription is not ACTIVE; no offer was made.",
  not_monthly_plan: "Subscription is not on the registered monthly plan (it may already be annual); no offer was made.",
  not_list_price: "Subscription is not at the list price (for example an active discount); no offer was made.",
};

/**
 * Eligibility from a live PayPal read: same subscription, ACTIVE, on the registered monthly plan and at
 * list price by cents. A plan switch drops price overrides, so a discounted subscriber is never offered one.
 */
export function annualIneligibility(
  observed: { id: string; status: string; planId: string | null; regularPrice: string | null },
  expected: { subscriptionId: string; monthlyPlanId: string; listPrice: string },
): AnnualIneligibility | null {
  if (observed.id !== expected.subscriptionId) return "identity_mismatch";
  if (observed.status !== "ACTIVE") return "not_active";
  if (observed.planId !== expected.monthlyPlanId) return "not_monthly_plan";
  if (!sameUsdAmount(observed.regularPrice, expected.listPrice)) return "not_list_price";
  return null;
}

/** Which field of a read-back yearly plan differs from the approved offer, or null when it matches exactly. */
export function annualPlanMismatch(plan: PlanSnapshot, action: Pick<AnnualOfferAction, "productId" | "annualPrice" | "currency">): string | null {
  if (!/^P-[A-Z0-9]+$/.test(plan.planId)) return "plan id";
  if (plan.status !== "ACTIVE") return "status";
  if (plan.productId !== action.productId) return "product";
  if (plan.currency !== action.currency) return "currency";
  if (!sameUsdAmount(plan.price, action.annualPrice)) return "price";
  if (plan.intervalUnit !== "YEAR" || plan.intervalCount !== 1) return "interval";
  if (plan.regularCycleCount !== 1 || plan.cycleCount !== 1 || plan.totalCycles !== 0) return "billing cycles";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ledger/annual-offer-action.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/annual-offer-action.ts src/ledger/annual-offer-action.test.ts
git commit -m "feat(m7): check annual eligibility and plan read-back by cents"
```

---

### Task 3: Draft customer message (pure)

**Files:**
- Create: `src/ledger/annual-offer-message.ts`
- Test: `src/ledger/annual-offer-message.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { draftAnnualOfferMessage } from "./annual-offer-message";

const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST0000000001";
const input = { merchantName: "Ridgeline Roasters", planName: "Roaster's Choice (monthly)", annualPrice: "244.80", discountPct: 15, expiresAt: "2026-11-08T00:00:00.000Z", approvalUrl: LINK };

it("drafts a consent message with the yearly price, renewal timing, window and link", () => {
  const text = draftAnnualOfferMessage(input);
  expect(text).toContain("Ridgeline Roasters");
  expect(text).toContain("$244.80 a year");
  expect(text).toContain("15% less than twelve monthly payments");
  expect(text).toContain("Nothing changes unless you agree in PayPal");
  expect(text).toContain("charged from your next renewal date");
  expect(text).toContain("November 8, 2026 (UTC)");
  expect(text.endsWith(LINK)).toBe(true);
});

it("refuses an unparseable deadline", () => {
  expect(() => draftAnnualOfferMessage({ ...input, expiresAt: "soon" })).toThrow(RangeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ledger/annual-offer-message.test.ts`

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement** `src/ledger/annual-offer-message.ts`

```ts
// Display-only draft an administrator copies and sends by hand. Aurrery never sends it. The text
// carries the subscriber's secret approval link: never log it or show it to visitors.

export function draftAnnualOfferMessage(input: {
  merchantName: string; planName: string; annualPrice: string; discountPct: number; expiresAt: string; approvalUrl: string;
}): string {
  const closes = new Date(input.expiresAt);
  if (Number.isNaN(closes.getTime())) throw new RangeError("Invalid expiresAt");
  const date = closes.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return [
    `Hi from ${input.merchantName}.`,
    `You can switch your ${input.planName} subscription to a yearly plan for $${input.annualPrice} a year, ${input.discountPct}% less than twelve monthly payments.`,
    "Nothing changes unless you agree in PayPal. If you do, the yearly price is charged from your next renewal date.",
    `This offer is open until ${date} (UTC). Review and approve it here: ${input.approvalUrl}`,
  ].join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ledger/annual-offer-message.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/annual-offer-message.ts src/ledger/annual-offer-message.test.ts
git commit -m "feat(m7): draft the annual offer customer message"
```

---

### Task 4: Shared approval-link check and the revise HTTP status

The importer (Task 10) must recognise a PayPal approval link without loading the SDK, and the executor reports `revise`'s real HTTP status.

**Files:**
- Create: `src/paypal/approval-link.ts`, `src/paypal/approval-link.test.ts`
- Modify: `src/paypal/plans.ts`, `src/paypal/plans.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/paypal/approval-link.test.ts`:

```ts
import { expect, it } from "vitest";
import { isPayPalApprovalUrl } from "./approval-link";

it.each([
  ["https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST", true],
  ["https://paypal.com/approve", true],
  ["http://www.paypal.com/approve", false],
  ["https://notpaypal.com/approve", false],
  ["https://evil.example/approve", false],
  ["not a url", false],
])("treats %s as a PayPal approval link: %s", (href, expected) => {
  expect(isPayPalApprovalUrl(href)).toBe(expected);
});
```

In `src/paypal/plans.test.ts`, change the expectation in "requests a switch and returns the customer approval link" to:

```ts
    expect(await reviseToPlan(revise)).toEqual({ ok: true, debugId: "dbg2", value: { approvalUrl: "https://www.sandbox.paypal.com/approve?token=x", planId: plan.id, httpStatus: 200 } });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/paypal/approval-link.test.ts src/paypal/plans.test.ts`

Expected: FAIL. The module is missing, and `httpStatus` is absent.

- [ ] **Step 3: Implement**

Create `src/paypal/approval-link.ts`:

```ts
/** A customer approval link must be a PayPal https URL. It is a per-subscriber secret: never log or echo it. */
export function isPayPalApprovalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}
```

In `src/paypal/plans.ts`:
- delete the local `isPayPalApprovalUrl` function and add `import { isPayPalApprovalUrl } from "./approval-link";`;
- add `httpStatus: number;` to `interface ReviseOffer`;
- change the success return in `reviseToPlan` to:

```ts
    return { ok: true, value: { approvalUrl, planId: res.result.planId ?? null, httpStatus: res.statusCode }, debugId };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/paypal/approval-link.test.ts src/paypal/plans.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paypal/approval-link.ts src/paypal/approval-link.test.ts src/paypal/plans.ts src/paypal/plans.test.ts
git commit -m "refactor(paypal): share the approval link check and report revise status"
```

---

### Task 5: Execution outcome module and the single definitive-failure rule

Decision 0008 makes `execute.ts`'s 400/401/403/404/422 list the only rule for definitive failures. This task extracts it, with the shared outcome types, so the annual executor can use them without an import cycle. There is no behaviour change.

**Files:**
- Create: `src/execution/outcomes.ts`, `src/execution/outcomes.test.ts`
- Modify: `src/execution/execute.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { ExecutionReconciliationRequired, isDefinitiveFailure } from "./outcomes";

it.each([[400, true], [401, true], [403, true], [404, true], [422, true], [200, false], [409, false], [429, false], [500, false], [null, false]] as const)(
  "classifies HTTP %s as definitive: %s", (status, expected) => expect(isDefinitiveFailure(status)).toBe(expected));

it("names the proposal that needs reconciliation", () => {
  expect(new ExecutionReconciliationRequired("prop_x")).toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: "prop_x" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/execution/outcomes.test.ts`

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

Create `src/execution/outcomes.ts`:

```ts
import type { Proposal } from "@/ledger/proposals";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";

// Shared execution results. No secrets: an annual offer's approval link never appears here.

export interface TargetOutcome {
  subscriptionId: string;
  ok: boolean;
  skipped?: boolean;
  httpStatus: number | null;
  debugId: string | null;
  verified: boolean;
  observed: Pick<SubscriptionSnapshot, "status" | "regularPrice" | "planOverridden" | "nextBillingTime"> | null;
  error: string | null;
  /** Present when an annual-plan offer was issued. The switch itself is verified only by later reads. */
  offer?: { annualPlanId: string; expiresAt: string };
}
export interface ExecutionReport { proposal: Proposal; outcomes: TargetOutcome[] }

export class ExecutionReconciliationRequired extends Error {
  constructor(readonly proposalId: string) { super("Approval or execution outcome is unconfirmed; reconcile the ledger and PayPal before any further action."); this.name = "ExecutionReconciliationRequired"; }
}

/** Client errors PayPal rejects before mutating: the single definitive-failure rule (decision 0008). */
export const DEFINITIVE_HTTP_FAILURES: readonly number[] = [400, 401, 403, 404, 422];
export const isDefinitiveFailure = (httpStatus: number | null): boolean => httpStatus !== null && DEFINITIVE_HTTP_FAILURES.includes(httpStatus);
```

In `src/execution/execute.ts`:
1. Delete the local `TargetOutcome` and `ExecutionReport` interfaces and the `ExecutionReconciliationRequired` class.
2. Add near the imports:

```ts
import { ExecutionReconciliationRequired, isDefinitiveFailure, type ExecutionReport, type TargetOutcome } from "./outcomes";
export { ExecutionReconciliationRequired, type ExecutionReport, type TargetOutcome } from "./outcomes";
```

3. Replace `const knownFailure = !outcome.ok && [400, 401, 403, 404, 422].includes(outcome.httpStatus ?? 0);` with:

```ts
    const knownFailure = !outcome.ok && isDefinitiveFailure(outcome.httpStatus);
```

Existing importers of these names from `@/execution/execute` (routes, `Lab.tsx`, `RecoveryPanel.tsx`, `src/app/api/_lib/http.ts`) keep working through the re-export.

- [ ] **Step 4: Run the tests to verify everything passes**

Run: `npx vitest run src/execution`

Expected: PASS, including every existing executor test.

- [ ] **Step 5: Commit**

```bash
git add src/execution/outcomes.ts src/execution/outcomes.test.ts src/execution/execute.ts
git commit -m "refactor(execution): extract outcomes and the definitive failure rule"
```

---

### Task 6: Offer tables and offer records

This task adds both tables to the canonical schema. The importer must know them in the same commit, because any ledger created from the new schema contains them.

**Files:**
- Modify: `src/ledger/db.ts`, `src/ledger/import.ts` (`TABLES`, `OPTIONAL` only), `src/ledger/export.test.ts`, `src/ledger/import.test.ts`
- Create: `src/ledger/annual-offers.ts`, `src/ledger/annual-offers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/ledger/annual-offers.test.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import type { TargetOutcome } from "@/execution/outcomes";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "./annual-offer-action";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "./connection";
import {
  appendOfferReads, listAnnualOfferLinks, listAnnualOfferViews, listAnnualPlanIds, openOfferSubscriptionIds,
  readAnnualOfferEvidence, recordAnnualOffer, recordAnnualTarget,
} from "./annual-offers";

const PROPOSAL = "prop_00000000-0000-4000-8000-0000000000a1";
const ANNUAL = "P-ANNUAL0000000000000000001";
const MONTHLY = "P-MONTHLY000000000000000001";
const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST";
const OFFERED = "2026-11-01T00:00:00.000Z";
const EXPIRES = "2026-11-08T00:00:00.000Z";
const CREATED = "2026-10-22T00:00:00.000Z";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7, eligible: [
  { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other", createdAt: CREATED },
  { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: CREATED },
] });
const dir = mkdtempSync(join(tmpdir(), "aurrery-annual-offers-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows libSQL handles may outlive close(). */ } });

async function seed(connection: LedgerConnection) {
  await initializeLedgerSchema(connection);
  const json = JSON.stringify(action);
  await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,'executing')",
    [PROPOSAL, OFFERED, JSON.stringify(strategy), "{}", action.type, json, createHash("sha256").update(json).digest("hex")]);
}
const issued = (subscriptionId: string): TargetOutcome => ({ subscriptionId, ok: true, httpStatus: 200, debugId: "dbg-revise", verified: false, observed: null, error: null, offer: { annualPlanId: ANNUAL, expiresAt: EXPIRES } });
const offer = (subscriptionId: string) => ({ proposalId: PROPOSAL, subscriptionId, segment: "core" as const, annualPlanId: ANNUAL, approvalUrl: `${LINK}${subscriptionId.slice(2)}`,
  offeredAt: OFFERED, expiresAt: EXPIRES, request: { subscriptionId, operation: "revise", planId: ANNUAL }, outcome: issued(subscriptionId) });
const read = (status: string, planId: string | null) => ({ status, planId, debugId: "dbg-read" });

async function withLocal(work: (connection: LedgerConnection) => Promise<void>) {
  const db = new DatabaseSync(":memory:");
  try { const connection = createLocalConnection(db); await seed(connection); await work(connection); } finally { db.close(); }
}

describe("annual offer records", () => {
  it("records the execution, offer and audit together and keeps the link out of every other column", () => withLocal(async (c) => {
    const id = await recordAnnualOffer(offer("I-PILOTD"), c);
    expect(await c.query("SELECT subscription_id,segment,annual_plan_id,approval_url,offered_at,expires_at FROM annual_offers WHERE id=?", [id]))
      .toEqual([{ subscription_id: "I-PILOTD", segment: "core", annual_plan_id: ANNUAL, approval_url: `${LINK}PILOTD`, offered_at: OFFERED, expires_at: EXPIRES }]);
    const elsewhere = JSON.stringify([await c.query("SELECT * FROM executions"), await c.query("SELECT * FROM audit_events")]);
    expect(elsewhere).toContain("annual_offer.issued");
    expect(elsewhere).toContain("POST subscription revise (annual plan)");
    expect(elsewhere).not.toContain("ba_token");
  }));

  it("refuses a second revise record for the same target in one proposal and rolls back", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await expect(recordAnnualOffer(offer("I-PILOTD"), c)).rejects.toThrow();
    expect(await c.query("SELECT COUNT(*) AS n FROM annual_offers")).toEqual([{ n: 1 }]);
  }));

  it("refuses to store a link anywhere but annual_offers", () => withLocal(async (c) => {
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), request: { link: LINK } }, c)).rejects.toThrow(/only in annual_offers/);
    await expect(recordAnnualTarget(PROPOSAL, {}, { ...issued("I-PILOTD"), ok: false, offer: undefined, error: LINK }, c)).rejects.toThrow();
    expect(await c.query("SELECT COUNT(*) AS n FROM executions")).toEqual([{ n: 0 }]);
  }));

  it("appends one read per offer on every successful GET, even after the offer resolved", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    expect(await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c)).toBe(1);
    expect(await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:20:00.000Z", c)).toBe(1);
    expect(await appendOfferReads("I-UNKNOWN", read("ACTIVE", MONTHLY), "2026-11-01T00:20:00.000Z", c)).toBe(0);
    await expect(appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01 00:30", c)).rejects.toThrow(RangeError);
    expect(await c.query("SELECT observed_at,status,plan_id,debug_id FROM annual_offer_reads ORDER BY id")).toHaveLength(2);
    const [view] = await listAnnualOfferViews(new Date("2026-11-02T00:00:00Z"), c);
    expect(view).toMatchObject({ subscriptionId: "I-PILOTD", status: "switched", outcome: "accepted", resolvedAt: "2026-11-01T00:10:00.000Z" });
    expect(JSON.stringify(view)).not.toContain("ba_token");
  }));

  it("counts learning outcomes per segment and frees a subscriber only after a confirmed decline", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await recordAnnualOffer(offer("I-PILOTE"), c);
    await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c);
    expect(await readAnnualOfferEvidence(c, "2026-11-02T00:00:00.000Z")).toEqual({
      offers: [{ segment: "core", accepted: 1, declined: 0, unresolved: 1 }], limitation: expect.stringContaining("not a randomized"),
    });
    expect(await openOfferSubscriptionIds(c, new Date("2026-11-02T00:00:00Z"))).toEqual(new Set(["I-PILOTD", "I-PILOTE"]));
    await appendOfferReads("I-PILOTE", read("ACTIVE", MONTHLY), "2026-11-08T07:00:00.000Z", c);
    expect((await readAnnualOfferEvidence(c, "2026-11-08T08:00:00.000Z")).offers).toEqual([{ segment: "core", accepted: 1, declined: 1, unresolved: 0 }]);
    expect(await openOfferSubscriptionIds(c, new Date("2026-11-08T08:00:00Z"))).toEqual(new Set(["I-PILOTD"]));
    expect(await listAnnualPlanIds(c)).toEqual(new Set([ANNUAL]));
  }));

  it("serves links only while an offer window is open, with the approved price", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await recordAnnualOffer(offer("I-PILOTE"), c);
    await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c);
    expect(await listAnnualOfferLinks(new Date("2026-11-02T00:00:00Z"), c)).toEqual([
      expect.objectContaining({ subscriptionId: "I-PILOTE", status: "pending", approvalUrl: `${LINK}PILOTE`, annualPrice: "244.80", discountPct: 15 }),
    ]);
    expect(await listAnnualOfferLinks(new Date("2026-11-09T00:00:00Z"), c)).toEqual([]);
  }));

  it("records offers and reads through a checked libSQL connection", async () => {
    const client = createClient({ url: `file:${join(dir, "libsql.sqlite")}` });
    try {
      const c = createLibsqlConnection(client);
      await seed(c);
      await recordAnnualOffer(offer("I-PILOTD"), c);
      await appendOfferReads("I-PILOTD", read("APPROVAL_PENDING", MONTHLY), "2026-11-01T00:10:00.000Z", c);
      expect(await listAnnualOfferViews(new Date("2026-11-02T00:00:00Z"), c)).toEqual([expect.objectContaining({ status: "pending", needsRead: true })]);
    } finally { client.close(); }
  });
});
```

In `src/ledger/export.test.ts`, change `expect(manifest.tables).toHaveLength(13);` to `expect(manifest.tables).toHaveLength(15);`.

Append to `src/ledger/import.test.ts`:

```ts
it("accepts a legacy ledger without annual offer tables", async () => {
  const path = join(dir, "legacy-annual.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.exec("DROP TABLE annual_offer_reads; DROP TABLE annual_offers;");
  source.close();
  const manifest = await importLedger({ sourcePath: path, dryRun: true });
  expect(manifest.tables.filter((row) => row.table.startsWith("annual_offer")).map((row) => [row.table, row.count]))
    .toEqual([["annual_offers", 0], ["annual_offer_reads", 0]]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ledger/annual-offers.test.ts src/ledger/export.test.ts src/ledger/import.test.ts`

Expected: FAIL.
- `./annual-offers` is missing.
- The export test sees 13 tables.
- The legacy test fails because the tables do not exist.

- [ ] **Step 3: Implement the schema**

In `src/ledger/db.ts`, insert directly after the `discount_episodes` table in `LEDGER_SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS annual_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  execution_id INTEGER NOT NULL UNIQUE REFERENCES executions(id),
  subscription_id TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('new','core','price_sensitive','at_risk','cancel_intent')),
  annual_plan_id TEXT NOT NULL,
  approval_url TEXT NOT NULL,
  offered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (proposal_id, subscription_id)
);
CREATE TABLE IF NOT EXISTS annual_offer_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES annual_offers(id),
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id TEXT,
  debug_id TEXT
);
```

`CREATE TABLE IF NOT EXISTS` migrates hosted Turso on its next `initializeLedgerSchema`. Task 23 orders the backup accordingly.

In `src/ledger/import.ts`:
- add `["annual_offers", "id"], ["annual_offer_reads", "id"],` to `TABLES` directly after `["discount_episodes", "execution_id"],`. That order satisfies the foreign keys.
- add `"annual_offers", "annual_offer_reads"` to `OPTIONAL`.

- [ ] **Step 4: Implement** `src/ledger/annual-offers.ts`

```ts
import "server-only";
import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import type { TargetOutcome } from "@/execution/outcomes";
import type { PlanSnapshot } from "@/paypal/plans";
import { AnnualOfferActionSchema } from "./annual-offer-action";
import { countResolvedOffers, offerView, parseIsoInstant, type AnnualOfferView, type OfferRead, type OfferRecord, type SegmentOfferCounts } from "./annual-offer-status";
import { now } from "./db";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor } from "./connection";
import { auditOn, authoritativeWrite } from "./operations";

// Annual-plan offers and the PayPal reads that resolve them. The approval link is a per-subscriber
// secret: it is written only to annual_offers.approval_url and read only by listAnnualOfferLinks.

export const ANNUAL_REVISE_OPERATION = "POST subscription revise (annual plan)";
export const ANNUAL_OFFER_LIMITATION = "Sandbox demonstration with very few offers. A switch counts only when PayPal reads the subscription back ACTIVE on the offered annual plan; a decline counts only after the offer window plus six hours and a confirming read. Customers chose whether to switch, so this is not a randomized uptake estimate.";

export interface IssuedOffer {
  proposalId: string; subscriptionId: string; segment: OfferRecord["segment"]; annualPlanId: string;
  approvalUrl: string; offeredAt: string; expiresAt: string; request: unknown; outcome: TargetOutcome;
}
export interface AnnualOfferLink extends AnnualOfferView { approvalUrl: string; annualPrice: string; discountPct: number }
export interface AnnualOfferEvidence { offers: SegmentOfferCounts[]; limitation: string }

const runtime = async (connection?: LedgerConnection) => connection ?? await runtimeLedgerConnection();
const exposesLink = (value: unknown, link?: string) => {
  const text = JSON.stringify(value ?? null);
  return text.includes("ba_token") || (!!link && text.includes(link));
};

async function insertExecution(tx: LedgerExecutor, proposalId: string, request: unknown, outcome: TargetOutcome, recordedAt: string) {
  return tx.execute(
    `INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, http_status, debug_id, response_json, verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [proposalId, outcome.subscriptionId, ANNUAL_REVISE_OPERATION, JSON.stringify(request), outcome.ok ? 1 : 0, outcome.httpStatus, outcome.debugId, JSON.stringify(outcome), recordedAt],
  );
}

/** One transaction: execution record, offer (with its secret link) and audit entry. */
export async function recordAnnualOffer(offer: IssuedOffer, connection?: LedgerConnection): Promise<number> {
  if (parseIsoInstant(offer.offeredAt) === null || parseIsoInstant(offer.expiresAt) === null) throw new RangeError("Offer times must be ISO-8601 instants.");
  if (!offer.outcome.ok || !offer.outcome.offer || offer.outcome.subscriptionId !== offer.subscriptionId) throw new RangeError("Only an issued offer for this target can be recorded.");
  if (exposesLink([offer.request, offer.outcome], offer.approvalUrl)) throw new Error("An approval link may be stored only in annual_offers.");
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const execution = await insertExecution(tx, offer.proposalId, offer.request, offer.outcome, offer.offeredAt);
    const inserted = await tx.execute(
      `INSERT INTO annual_offers (proposal_id, execution_id, subscription_id, segment, annual_plan_id, approval_url, offered_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [offer.proposalId, execution.lastInsertRowid!, offer.subscriptionId, offer.segment, offer.annualPlanId, offer.approvalUrl, offer.offeredAt, offer.expiresAt],
    );
    const offerId = Number(inserted.lastInsertRowid);
    await auditOn(tx, "annual_offer.issued", offer.proposalId, { targetId: offer.subscriptionId, offerId, annualPlanId: offer.annualPlanId, expiresAt: offer.expiresAt });
    return offerId;
  });
}

/** A target that received no offer: skipped, refused, or left unresolved for the operator. */
export async function recordAnnualTarget(proposalId: string, request: unknown, outcome: TargetOutcome, connection?: LedgerConnection, recordedAt = now()): Promise<void> {
  if (outcome.offer || exposesLink([request, outcome])) throw new Error("Only a target without an offer or link is recorded here.");
  await authoritativeWrite(await runtime(connection), async (tx) => {
    await insertExecution(tx, proposalId, request, outcome, recordedAt);
    await auditOn(tx, "execution.target_recorded", proposalId, { targetId: outcome.subscriptionId, ok: outcome.ok, verified: false });
  });
}

export async function recordAnnualPlan(proposalId: string, plan: PlanSnapshot, debugId: string | null, connection?: LedgerConnection): Promise<void> {
  await authoritativeWrite(await runtime(connection), (tx) => auditOn(tx, "annual_plan.verified", proposalId,
    { planId: plan.planId, price: plan.price, currency: plan.currency, intervalUnit: plan.intervalUnit, debugId }));
}

/** Every successful GET appends one read per offer the subscription received, resolved or not, so a late switch still wins. */
export async function appendOfferReads(subscriptionId: string, read: { status: string; planId: string | null; debugId: string | null }, observedAt: string, connection?: LedgerConnection): Promise<number> {
  if (parseIsoInstant(observedAt) === null) throw new RangeError("observedAt must be an ISO-8601 instant.");
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const offers = await tx.query("SELECT id FROM annual_offers WHERE subscription_id = ? ORDER BY id", [subscriptionId]);
    for (const offer of offers) {
      await tx.execute("INSERT INTO annual_offer_reads (offer_id, observed_at, status, plan_id, debug_id) VALUES (?, ?, ?, ?, ?)",
        [offer.id, observedAt, read.status, read.planId, read.debugId]);
    }
    return offers.length;
  });
}

const Segment = z.enum(SEGMENTS);
async function offerRecords(tx: LedgerExecutor): Promise<{ record: OfferRecord; reads: OfferRead[] }[]> {
  const rows = await tx.query("SELECT id, proposal_id, subscription_id, segment, annual_plan_id, offered_at, expires_at FROM annual_offers ORDER BY id");
  const reads = await tx.query("SELECT offer_id, observed_at, status, plan_id FROM annual_offer_reads ORDER BY id");
  return rows.map((row) => ({
    record: {
      id: Number(row.id), proposalId: String(row.proposal_id), subscriptionId: String(row.subscription_id), segment: Segment.parse(row.segment),
      annualPlanId: String(row.annual_plan_id), offeredAt: String(row.offered_at), expiresAt: String(row.expires_at),
    },
    reads: reads.filter((r) => Number(r.offer_id) === Number(row.id))
      .map((r) => ({ observedAt: String(r.observed_at), status: String(r.status), planId: r.plan_id === null ? null : String(r.plan_id) })),
  }));
}

/** Public view: derived status only, never the approval link. */
export async function listAnnualOfferViews(at = new Date(), connection?: LedgerConnection): Promise<AnnualOfferView[]> {
  return authoritativeWrite(await runtime(connection), async (tx) => (await offerRecords(tx)).map(({ record, reads }) => offerView(record, reads, at)));
}

/** Administrator only: links of offers whose window is still open, with the approved price. */
export async function listAnnualOfferLinks(at = new Date(), connection?: LedgerConnection): Promise<AnnualOfferLink[]> {
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const links: AnnualOfferLink[] = [];
    for (const { record, reads } of await offerRecords(tx)) {
      const view = offerView(record, reads, at);
      if (view.status !== "pending") continue;
      const row = (await tx.query("SELECT o.approval_url, p.action_json FROM annual_offers o JOIN proposals p ON p.id = o.proposal_id WHERE o.id = ?", [record.id]))[0];
      const action = AnnualOfferActionSchema.parse(JSON.parse(String(row.action_json)));
      links.push({ ...view, approvalUrl: String(row.approval_url), annualPrice: action.annualPrice, discountPct: action.discountPct });
    }
    return links;
  });
}

/** Subscribers who may not receive another offer: anything short of a confirmed decline (pending, awaiting final check, invalid, switched). */
export async function openOfferSubscriptionIds(tx: LedgerExecutor, at: Date): Promise<Set<string>> {
  return new Set((await offerRecords(tx)).filter(({ record, reads }) => offerView(record, reads, at).outcome !== "declined").map(({ record }) => record.subscriptionId));
}

export async function listAnnualPlanIds(connection?: LedgerConnection): Promise<Set<string>> {
  return authoritativeWrite(await runtime(connection), async (tx) =>
    new Set((await tx.query("SELECT DISTINCT annual_plan_id FROM annual_offers")).map((row) => String(row.annual_plan_id))));
}

/** Per-segment accepted / declined / unresolved counts; only resolved offers feed the twin. */
export async function readAnnualOfferEvidence(connection?: LedgerConnection, at = new Date().toISOString()): Promise<AnnualOfferEvidence> {
  const instant = new Date(at);
  return authoritativeWrite(await runtime(connection), async (tx) => ({
    offers: countResolvedOffers((await offerRecords(tx)).map(({ record, reads }) => ({ segment: record.segment, outcome: offerView(record, reads, instant).outcome }))),
    limitation: ANNUAL_OFFER_LIMITATION,
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ledger`

Expected: PASS. All ledger tests pass, including import and export.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/db.ts src/ledger/import.ts src/ledger/annual-offers.ts src/ledger/annual-offers.test.ts src/ledger/export.test.ts src/ledger/import.test.ts
git commit -m "feat(ledger): record annual offers and their PayPal reads"
```

---

### Task 7: Annual offer executor (injected dependencies)

The executor is pure orchestration over injected adapters, so every path is tested offline. It is wired into production in Task 8.

**Files:**
- Create: `src/execution/annual-offer.ts`, `src/execution/annual-offer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";
import type { PayPalFailure } from "@/paypal/client";
import type { PlanSnapshot } from "@/paypal/plans";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";
import { annualPlanRequestId, executeAnnualOfferWith, type AnnualDependencies } from "./annual-offer";

const MONTHLY = "P-MONTHLY000000000000000001";
const ANNUAL = "P-ANNUAL0000000000000000001";
const PRODUCT = "PROD-RIDGELINE0000000001";
const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST";
const CREATED = "2026-10-22T00:00:00.000Z";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: PRODUCT, monthlyPlanId: MONTHLY, offerWindowDays: 7, eligible: [
  { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other", createdAt: CREATED },
  { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: CREATED },
] });
const proposal = { id: "prop_annual", actionHash: "a".repeat(64), action };
const monthlyPlan: PlanSnapshot = { planId: MONTHLY, status: "ACTIVE", name: "Monthly", productId: PRODUCT, price: "24.0", currency: "USD", intervalUnit: "MONTH", intervalCount: 1, totalCycles: 0, regularCycleCount: 1, cycleCount: 1 };
const annualPlan: PlanSnapshot = { ...monthlyPlan, planId: ANNUAL, name: "Annual", price: "244.8", intervalUnit: "YEAR" };
const subscription = (id: string, change: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot =>
  ({ id, status: "ACTIVE", planId: MONTHLY, planOverridden: false, regularPrice: "24.0", nextBillingTime: "2026-11-30T10:00:00Z", lastPayment: null, raw: {}, ...change });
function ok<T>(value: T) { return { ok: true as const, value, debugId: "dbg" as string | null }; }
const fail = (httpStatus: number | null, name = "UNPROCESSABLE_ENTITY") =>
  ({ ok: false as const, error: { httpStatus, name, message: "PayPal refused", debugId: "dbg-fail", details: null } satisfies PayPalFailure });

// Generic so each override keeps its own mock type (a plain Partial spread would widen to a union).
function deps<C extends Partial<AnnualDependencies> = Record<never, never>>(change: C = {} as C) {
  const base = {
    monthlyPlanSetting: vi.fn<AnnualDependencies["monthlyPlanSetting"]>(async () => MONTHLY),
    getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : annualPlan)),
    createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => ok(annualPlan)),
    read: vi.fn<AnnualDependencies["read"]>(async (id) => ok(subscription(id))),
    revise: vi.fn<AnnualDependencies["revise"]>(async ({ subscriptionId }) => ok({ approvalUrl: `${LINK}${subscriptionId.slice(2)}`, planId: ANNUAL, httpStatus: 200 })),
    validateTarget: vi.fn<AnnualDependencies["validateTarget"]>(async () => true),
    recordObservation: vi.fn<AnnualDependencies["recordObservation"]>(async () => {}),
    recordPlan: vi.fn<AnnualDependencies["recordPlan"]>(async () => {}),
    recordOffer: vi.fn<AnnualDependencies["recordOffer"]>(async () => 1),
    recordTarget: vi.fn<AnnualDependencies["recordTarget"]>(async () => {}),
    finish: vi.fn<AnnualDependencies["finish"]>(async () => {}),
    get: vi.fn<AnnualDependencies["get"]>(async () => ({ id: proposal.id }) as Proposal),
    now: () => new Date("2026-11-01T00:00:00.000Z"),
    returnUrl: "https://aurrery.example/?paypal=annual",
  };
  return { ...base, ...change };
}
const EXPIRES = "2026-11-08T00:00:00.000Z";

describe("annual offer execution", () => {
  it("creates the plan under a hash-derived request ID, verifies it by cents and issues one offer per target", async () => {
    const d = deps();
    const report = await executeAnnualOfferWith(proposal, d);
    expect(annualPlanRequestId(proposal.actionHash)).toBe(`aurrery-annual-${"a".repeat(64)}`);
    expect(d.createPlan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ productId: PRODUCT, annualPrice: "244.80", currency: "USD", requestId: annualPlanRequestId(proposal.actionHash) }));
    expect(d.recordPlan).toHaveBeenCalledWith(annualPlan, "dbg");
    expect(d.revise.mock.calls.map(([input]) => input)).toEqual([
      { subscriptionId: "I-PILOTD", planId: ANNUAL, returnUrl: "https://aurrery.example/?paypal=annual" },
      { subscriptionId: "I-PILOTE", planId: ANNUAL, returnUrl: "https://aurrery.example/?paypal=annual" },
    ]);
    expect(d.recordOffer).toHaveBeenCalledWith(expect.objectContaining({ proposalId: proposal.id, subscriptionId: "I-PILOTE", segment: "core", annualPlanId: ANNUAL,
      approvalUrl: `${LINK}PILOTE`, offeredAt: "2026-11-01T00:00:00.000Z", expiresAt: EXPIRES }));
    expect(d.recordObservation).toHaveBeenCalledWith(expect.objectContaining({ id: "I-PILOTD" }), "paypal.execution_preread");
    expect(d.finish).toHaveBeenCalledWith("succeeded", { succeeded: 2, total: 2 });
    expect(report.outcomes.map((o) => o.offer)).toEqual([{ annualPlanId: ANNUAL, expiresAt: EXPIRES }, { annualPlanId: ANNUAL, expiresAt: EXPIRES }]);
    expect(JSON.stringify([report, d.recordTarget.mock.calls])).not.toContain("ba_token");
  });

  it("uses the same plan request ID every time the same approved action executes", async () => {
    const first = deps(); const second = deps();
    await executeAnnualOfferWith(proposal, first); await executeAnnualOfferWith(proposal, second);
    expect(second.createPlan.mock.calls[0][0].requestId).toBe(first.createPlan.mock.calls[0][0].requestId);
  });

  it("re-checks live eligibility just before revise and skips without calling PayPal", async () => {
    const d = deps({ read: vi.fn<AnnualDependencies["read"]>(async (id) => ok(subscription(id, id === "I-PILOTD" ? { regularPrice: "18.00", planOverridden: true } : { planId: ANNUAL, regularPrice: "244.8" }))) });
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.revise).not.toHaveBeenCalled();
    expect(report.outcomes.map((o) => o.error)).toEqual([expect.stringMatching(/list price/), expect.stringMatching(/monthly plan/)]);
    expect(d.finish).toHaveBeenCalledWith("failed", { succeeded: 0, total: 2 });
  });

  it("does not call revise when the local authority check fails after the PayPal read", async () => {
    const d = deps({ validateTarget: vi.fn<AnnualDependencies["validateTarget"]>().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true) });
    await executeAnnualOfferWith(proposal, d);
    expect(d.revise.mock.calls.map(([input]) => input.subscriptionId)).toEqual(["I-PILOTE"]);
    expect(d.finish).toHaveBeenCalledWith("partially_failed", { succeeded: 1, total: 2 });
  });

  it("continues after a definitive 4xx and reports a partial failure", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(fail(422));
    await executeAnnualOfferWith(proposal, d);
    expect(d.revise).toHaveBeenCalledTimes(2);
    expect(d.recordTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subscriptionId: "I-PILOTD", ok: false, httpStatus: 422 }));
    expect(d.finish).toHaveBeenCalledWith("partially_failed", { succeeded: 1, total: 2 });
  });

  it.each([
    ["a server error", fail(500, "INTERNAL_SERVER_ERROR")],
    ["a network failure", fail(null, "NETWORK_OR_CLIENT_ERROR")],
    ["a 200 without an approval link", fail(200, "MISSING_APPROVAL_LINK")],
    ["an unreadable 200", fail(200, "RESPONSE_VALIDATION_ERROR")],
    ["a 409 conflict", fail(409, "CONFLICT")],
  ])("leaves the proposal executing after %s, never retries and never touches later targets", async (_name, result) => {
    const d = deps(); d.revise.mockResolvedValueOnce(result);
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.read).toHaveBeenCalledOnce();
    expect(d.recordTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subscriptionId: "I-PILOTD", error: expect.stringMatching(/do not retry/i) }));
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("stores no link when PayPal reports a different plan for the switch", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(ok({ approvalUrl: `${LINK}X`, planId: "P-OTHER0000000000000000001", httpStatus: 200 }));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.recordOffer).not.toHaveBeenCalled();
    expect(JSON.stringify(d.recordTarget.mock.calls)).not.toContain("ba_token");
  });

  it("leaves the proposal executing when an issued offer cannot be stored", async () => {
    const d = deps({ recordOffer: vi.fn<AnnualDependencies["recordOffer"]>(async () => { throw new Error("storage"); }) });
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when a subscription cannot be read", async () => {
    const d = deps(); d.read.mockResolvedValueOnce(fail(503, "SERVICE_UNAVAILABLE"));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).not.toHaveBeenCalled();
  });

  it.each([
    ["the registered monthly plan changed", { monthlyPlanSetting: vi.fn<AnnualDependencies["monthlyPlanSetting"]>(async () => "P-NEWMONTHLY00000000000001") }],
    ["the monthly plan belongs to another product", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? { ...monthlyPlan, productId: "PROD-OTHER000000000000001" } : annualPlan)) }],
    ["plan creation was refused", { createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => fail(422)) }],
    ["the plan reads back at another price", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, price: "244.81" })) }],
    ["the plan reads back monthly", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, intervalUnit: "MONTH" })) }],
  ])("fails the proposal before any revise when %s", async (_name, change) => {
    const d = deps(change);
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.revise).not.toHaveBeenCalled();
    expect(d.recordTarget).toHaveBeenCalledTimes(2);
    expect(report.outcomes.every((o) => !o.ok && /no offer was made/.test(o.error ?? ""))).toBe(true);
    expect(d.finish).toHaveBeenCalledWith("failed", { succeeded: 0, total: 2 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/execution/annual-offer.test.ts`

Expected: FAIL. `./annual-offer` does not exist.

- [ ] **Step 3: Implement** `src/execution/annual-offer.ts`

```ts
import "server-only";
import { annualIneligibility, annualPlanMismatch, INELIGIBILITY_TEXT, type AnnualOfferAction } from "@/ledger/annual-offer-action";
import { offerExpiry } from "@/ledger/annual-offer-status";
import type { IssuedOffer } from "@/ledger/annual-offers";
import type { Proposal } from "@/ledger/proposals";
import type { PlanSnapshot, ReviseOffer } from "@/paypal/plans";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";
import { ExecutionReconciliationRequired, isDefinitiveFailure, type ExecutionReport, type TargetOutcome } from "./outcomes";

// Approach A: the proposal succeeds when offers are issued; the offer tracker follows each customer.
// PayPal calls run outside transactions. revise mints a new approval token on every call and takes no
// request ID (decision 0008), so it is called at most once per target and never retried.

export interface AnnualExecution { id: string; actionHash: string; action: AnnualOfferAction }
export interface AnnualDependencies {
  monthlyPlanSetting: () => Promise<string | null>;
  getPlan: (planId: string) => Promise<Result<PlanSnapshot>>;
  createPlan: (input: { productId: string; annualPrice: string; currency: "USD"; requestId: string; name: string; description: string }) => Promise<Result<PlanSnapshot>>;
  read: (subscriptionId: string) => Promise<Result<SubscriptionSnapshot>>;
  revise: (input: { subscriptionId: string; planId: string; returnUrl: string }) => Promise<Result<ReviseOffer>>;
  /** Claim, registration snapshot, monthly-plan setting and open-offer check on the ledger. */
  validateTarget: (subscriptionId: string) => Promise<boolean>;
  recordObservation: (snapshot: SubscriptionSnapshot, source: string) => Promise<void>;
  recordPlan: (plan: PlanSnapshot, debugId: string | null) => Promise<void>;
  recordOffer: (offer: IssuedOffer) => Promise<unknown>;
  recordTarget: (request: unknown, outcome: TargetOutcome) => Promise<void>;
  finish: (status: "succeeded" | "partially_failed" | "failed", summary: { succeeded: number; total: number }) => Promise<void>;
  get: () => Promise<Proposal>;
  now: () => Date;
  returnUrl: string;
}

/** Deterministic per approved action: a repeated create returns PayPal's original plan within its retention window. */
export const annualPlanRequestId = (actionHash: string) => `aurrery-annual-${actionHash}`;
const OPERATOR_NOTE = "Unresolved: do not retry revise. Reconcile by reading the subscription in PayPal (runbook: annual offers).";

async function ensurePlan({ action, actionHash }: AnnualExecution, deps: AnnualDependencies): Promise<{ plan: PlanSnapshot; debugId: string | null } | { reason: string }> {
  if ((await deps.monthlyPlanSetting()) !== action.monthlyPlanId) return { reason: "The registered monthly plan changed after approval" };
  const monthly = await deps.getPlan(action.monthlyPlanId);
  if (!monthly.ok) return { reason: `The monthly plan could not be read (${monthly.error.name})` };
  if (monthly.value.productId !== action.productId) return { reason: "The monthly plan belongs to another product" };
  const created = await deps.createPlan({
    productId: action.productId, annualPrice: action.annualPrice, currency: action.currency, requestId: annualPlanRequestId(actionHash),
    name: `Annual prepay (${action.discountPct}% off)`, description: `One prepaid year at ${action.annualPrice} USD`,
  });
  if (!created.ok) return { reason: `The annual plan could not be created (${created.error.name})` };
  const readBack = await deps.getPlan(created.value.planId);
  if (!readBack.ok) return { reason: `The annual plan could not be read back (${readBack.error.name})` };
  const mismatch = readBack.value.planId !== created.value.planId ? "plan id" : annualPlanMismatch(readBack.value, action);
  if (mismatch) return { reason: `The annual plan read back with a different ${mismatch}` };
  return { plan: readBack.value, debugId: readBack.debugId };
}

export async function executeAnnualOfferWith(proposal: AnnualExecution, deps: AnnualDependencies): Promise<ExecutionReport> {
  const { action } = proposal;
  const outcomes: TargetOutcome[] = [];
  const reconcile = (error?: unknown): never => {
    throw error instanceof ExecutionReconciliationRequired ? error : new ExecutionReconciliationRequired(proposal.id);
  };
  const refuse = (subscriptionId: string, error: string, extra: Partial<TargetOutcome> = {}): TargetOutcome =>
    ({ subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false, observed: null, error, ...extra });
  const record = async (request: unknown, outcome: TargetOutcome) => {
    try { await deps.recordTarget(request, outcome); } catch (error) { reconcile(error); }
    outcomes.push(outcome);
  };
  const finish = async (): Promise<ExecutionReport> => {
    const issued = outcomes.filter((outcome) => outcome.ok && outcome.offer).length;
    const status = issued === action.targets.length ? "succeeded" : issued === 0 ? "failed" : "partially_failed";
    try {
      await deps.finish(status, { succeeded: issued, total: action.targets.length });
      return { proposal: await deps.get(), outcomes };
    } catch (error) { return reconcile(error); }
  };

  let ensured: Awaited<ReturnType<typeof ensurePlan>>;
  try { ensured = await ensurePlan(proposal, deps); } catch (error) { return reconcile(error); }
  if ("reason" in ensured) {
    // Nothing customer-facing has happened yet, so the proposal fails cleanly.
    for (const { subscriptionId } of action.targets) await record({ subscriptionId, step: "annual_plan" }, refuse(subscriptionId, `${ensured.reason}; no offer was made.`));
    return finish();
  }
  try { await deps.recordPlan(ensured.plan, ensured.debugId); } catch (error) { reconcile(error); }
  const annualPlanId = ensured.plan.planId;

  for (const target of action.targets) {
    const { subscriptionId } = target;
    const request = { subscriptionId, operation: "revise", planId: annualPlanId };
    let current: SubscriptionSnapshot | null = null;
    try {
      if (await deps.validateTarget(subscriptionId)) {
        const read = await deps.read(subscriptionId);
        if (!read.ok) return reconcile();
        current = read.value;
        await deps.recordObservation(current, "paypal.execution_preread");
      }
    } catch (error) { return reconcile(error); }
    if (!current) { await record(request, refuse(subscriptionId, "Registration, claim or open offer changed before the PayPal read; no offer was made.")); continue; }
    const observed = { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime };
    const ineligible = annualIneligibility(current, { subscriptionId, monthlyPlanId: action.monthlyPlanId, listPrice: action.listPrice });
    if (ineligible) { await record(request, refuse(subscriptionId, INELIGIBILITY_TEXT[ineligible], { observed })); continue; }
    let authorized = false;
    try { authorized = await deps.validateTarget(subscriptionId); } catch (error) { return reconcile(error); }
    if (!authorized) { await record(request, refuse(subscriptionId, "Registration, claim or open offer changed after the PayPal read; no offer was made.", { observed })); continue; }

    let revised: Result<ReviseOffer>;
    try { revised = await deps.revise({ subscriptionId, planId: annualPlanId, returnUrl: deps.returnUrl }); } catch (error) { return reconcile(error); }
    if (!revised.ok) {
      const outcome = refuse(subscriptionId, `${revised.error.name}: ${revised.error.message}`, { httpStatus: revised.error.httpStatus, debugId: revised.error.debugId, observed });
      if (isDefinitiveFailure(revised.error.httpStatus)) { await record(request, outcome); continue; }
      // PayPal may have minted an approval token Aurrery does not hold (including HTTP 200 without a usable link).
      await record(request, { ...outcome, error: `${outcome.error} ${OPERATOR_NOTE}` });
      return reconcile();
    }
    if (revised.value.planId !== null && revised.value.planId !== annualPlanId) {
      await record(request, refuse(subscriptionId, `PayPal reported another plan for the switch; the link was not stored. ${OPERATOR_NOTE}`,
        { httpStatus: revised.value.httpStatus, debugId: revised.debugId, observed }));
      return reconcile();
    }
    try {
      const offeredAt = deps.now().toISOString();
      const expiresAt = offerExpiry(offeredAt, action.offerWindowDays);
      const outcome: TargetOutcome = { subscriptionId, ok: true, httpStatus: revised.value.httpStatus, debugId: revised.debugId, verified: false, observed, error: null, offer: { annualPlanId, expiresAt } };
      await deps.recordOffer({ proposalId: proposal.id, subscriptionId, segment: target.registration.segment, annualPlanId, approvalUrl: revised.value.approvalUrl, offeredAt, expiresAt, request, outcome });
      outcomes.push(outcome);
    } catch (error) { return reconcile(error); }
  }
  return finish();
}
```

PayPal error `message` values come from PayPal's error body or fixed adapter text. `toFailure` never copies a `ResponseValidationError` message, and the adapter never echoes a link.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/execution/annual-offer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/annual-offer.ts src/execution/annual-offer.test.ts
git commit -m "feat(execution): issue annual offers with one revise per target"
```

---

### Task 8: `annual_plan_offer` in the proposal union, claims and executor dispatch

This task adds the union member, claim preflight, per-target authority, the outstanding list, production wiring and the recovery panel typing. Nothing creates annual proposals yet (Task 9), so main's behaviour is unchanged.

**Files:**
- Modify: `src/ledger/proposals.ts`, `src/execution/execute.ts`, `src/components/RecoveryPanel.tsx`
- Test: create `src/ledger/annual-proposals.test.ts`; modify `src/execution/execute.test.ts`, `src/components/RecoveryPanel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/ledger/annual-proposals.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "./annual-offer-action";
import { recordAnnualOffer } from "./annual-offers";
import { createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "./connection";
import { createProposalRepository, hashAction } from "./proposals";

const MONTHLY = "P-MONTHLY000000000000000001";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const ID = (n: number) => `prop_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function setup(work: (c: LedgerConnection, repo: ReturnType<typeof createProposalRepository>) => Promise<void>) {
  const db = new DatabaseSync(":memory:");
  try {
    const c = createLocalConnection(db);
    await initializeLedgerSchema(c);
    const repo = createProposalRepository(c);
    await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other" });
    await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other" });
    await c.execute("INSERT INTO kv (key,value) VALUES ('paypal.plan_id',?)", [MONTHLY]);
    await work(c, repo);
  } finally { db.close(); }
}
async function insertAnnual(c: LedgerConnection, id: string, status: "approved" | "succeeded") {
  const rows = await c.query("SELECT subscription_id,label,segment,reason,created_at FROM sandbox_subscribers ORDER BY rowid");
  const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7,
    eligible: rows.map((r) => ({ subscriptionId: String(r.subscription_id), label: String(r.label), segment: String(r.segment), reason: String(r.reason), createdAt: String(r.created_at) })) });
  await c.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, new Date().toISOString(), JSON.stringify(strategy), "{}", action.type, JSON.stringify(action), hashAction(action), status, new Date().toISOString(), "fixture"]);
  return action;
}
const preflight = async (c: LedgerConnection) => (await c.query("SELECT detail_json FROM audit_events WHERE kind='proposal.preflight_failed'")).map((r) => JSON.parse(String(r.detail_json)).reason);

describe("annual offer proposals", () => {
  it("claims an approved annual offer through the unchanged state machine and lists it as outstanding", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    const claimed = await repo.claimForExecution(ID(1));
    expect(claimed.status).toBe("executing");
    expect(await c.query("SELECT target_id FROM active_target_claims ORDER BY target_id")).toEqual([{ target_id: "I-PILOTD" }, { target_id: "I-PILOTE" }]);
    expect((await repo.listOutstandingProposals()).proposals.map((p) => p.id)).toEqual([ID(1)]);
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTD")).toBe(true);
    await c.execute("UPDATE kv SET value='P-CHANGED00000000000000001' WHERE key='paypal.plan_id'");
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTD")).toBe(false);
    await expect(repo.finishExecution(ID(1), "succeeded", "2027-01-01T00:00:00.000Z")).rejects.toThrow(/cannot schedule a revert/);
    await repo.finishExecution(ID(1), "succeeded", null, { succeeded: 2, total: 2 });
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));

  it.each([
    ["monthly_plan_changed", async (c: LedgerConnection) => { await c.execute("UPDATE kv SET value='P-CHANGED00000000000000001' WHERE key='paypal.plan_id'"); }],
    ["registration_changed", async (c: LedgerConnection) => { await c.execute("UPDATE sandbox_subscribers SET created_at='2020-01-01T00:00:00.000Z' WHERE subscription_id='I-PILOTE'"); }],
    ["open_annual_offer", async (c: LedgerConnection) => {
      await insertAnnual(c, ID(9), "succeeded");
      await recordAnnualOffer({ proposalId: ID(9), subscriptionId: "I-PILOTE", segment: "core", annualPlanId: "P-ANNUAL0000000000000000001",
        approvalUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST", offeredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), request: {}, outcome: { subscriptionId: "I-PILOTE", ok: true, httpStatus: 200, debugId: null,
          verified: false, observed: null, error: null, offer: { annualPlanId: "P-ANNUAL0000000000000000001", expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } }, c);
    }],
  ])("fails preflight with %s before any PayPal call", (reason, change) => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    await change(c);
    await expect(repo.claimForExecution(ID(1))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repo.getProposal(ID(1))).status).toBe("failed");
    expect(await preflight(c)).toEqual([reason]);
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));
});
```

The `open_annual_offer` case passes a valid offer for an earlier proposal (`ID(9)`). Its claim check then sees E as open.

Append to `src/execution/execute.test.ts`, adding `import type { AnnualDependencies } from "./annual-offer";`:

```ts
it("dispatches an annual offer to its own executor and never PATCHes a price", async () => {
  const proposal = { id: "p", actionHash: "a".repeat(64), status: "executing",
    action: { type: "annual_plan_offer", monthlyPlanId: "P-MONTHLY", targets: [{ subscriptionId: "I-ONE", registration: {} }] } } as unknown as Proposal;
  const patch = vi.fn(); const finish = vi.fn(async () => {}); const recordTarget = vi.fn(async () => {});
  const report = await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish: vi.fn(), patch, read: vi.fn(), record: vi.fn(),
    annual: () => ({ monthlyPlanSetting: async () => "P-CHANGED", recordTarget, finish, get: async () => proposal }) as unknown as AnnualDependencies });
  expect(patch).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith("failed", { succeeded: 0, total: 1 });
  expect(report.outcomes[0].error).toMatch(/monthly plan changed.*no offer was made/);
});

it("leaves an annual offer for reconciliation when its executor is not wired", async () => {
  const proposal = { id: "p", actionHash: "a".repeat(64), status: "executing", action: { type: "annual_plan_offer", targets: [] } } as unknown as Proposal;
  await expect(executeProposalWith("p", { claim: async () => proposal, get: vi.fn(), finish: vi.fn(), patch: vi.fn(), read: vi.fn(), record: vi.fn() }))
    .rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: "p" });
});
```

Append to `src/components/RecoveryPanel.test.ts`:

```ts
it("lists only approved or executing annual offers and shows an approved one for explicit resumption", () => {
  const action = { type: "annual_plan_offer", annualPrice: "244.80", discountPct: 15, targets: [{ subscriptionId: "I-PILOTE", registration: { label: "Pilot E" } }] };
  const proposed = { id: "a1", actionHash: "b".repeat(64), status: "proposed", action } as unknown as Proposal;
  const approved = { ...proposed, id: "a2", status: "approved" } as Proposal;
  expect(pendingActions([proposed, approved])).toEqual([approved]);
  const html = renderToStaticMarkup(createElement(DiscountResumeReview, { proposal: approved, confirmed: false, canReview: true, paypalConfigured: true, busy: false, onConfirm: vi.fn(), onResume: vi.fn() }));
  expect(html).toContain("$244.80/yr");
  expect(html).toContain("Execute approved annual offer");
  expect(renderToStaticMarkup(createElement(RecoveryReview, { proposal: approved, confirmed: false, canReview: true, paypalConfigured: true, busy: false,
    onConfirm: vi.fn(), onApprove: vi.fn(), onReject: vi.fn() }))).toBe("");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ledger/annual-proposals.test.ts src/execution/execute.test.ts src/components/RecoveryPanel.test.ts`

Expected: FAIL.
- `hashAction` rejects the annual type (type error), and the claim takes the discount branch (`invalid_discount_action`).
- `annual` is not a dependency.
- The panel does not know annual offers.

- [ ] **Step 3: Implement the ledger side** (`src/ledger/proposals.ts`)

Imports:

```ts
import { AnnualOfferActionSchema, type AnnualOfferAction } from "./annual-offer-action";
import { openOfferSubscriptionIds } from "./annual-offers";
```

Union:

```ts
export type ProposalAction = PriceOverrideAction | RevertAction | ResetAction | AnnualOfferAction;
```

In `claimForExecution`, insert this branch before the final `} else {` (the price-override branch):

```ts
        } else if (p.action.type === "annual_plan_offer") {
          const action = AnnualOfferActionSchema.safeParse(p.action);
          if (!action.success || hashAction(p.action) !== p.actionHash) return fail("invalid_annual_action");
          const monthly = (await tx.query("SELECT value FROM kv WHERE key='paypal.plan_id'"))[0];
          if (String(monthly?.value ?? "") !== action.data.monthlyPlanId) return fail("monthly_plan_changed");
          const open = await openOfferSubscriptionIds(tx, new Date());
          for (const target of action.data.targets) {
            const registration = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [target.subscriptionId]))[0];
            if (!registration || registration.label !== target.registration.label || registration.segment !== target.registration.segment ||
              registration.reason !== target.registration.reason || registration.created_at !== target.registration.createdAt) return fail("registration_changed");
            if (open.has(target.subscriptionId)) return fail("open_annual_offer");
          }
```

In `validateTargetForExecution`, insert this directly after the `subscription_price_override` block (before `const pilot = ...`):

```ts
        if (action.type === "annual_plan_offer") {
          const target = action.targets.find((candidate) => candidate.subscriptionId === subscriptionId);
          const pilot = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [subscriptionId]))[0];
          const monthly = (await tx.query("SELECT value FROM kv WHERE key='paypal.plan_id'"))[0];
          return !!target && !!pilot && pilot.label === target.registration.label && pilot.segment === target.registration.segment &&
            pilot.reason === target.registration.reason && pilot.created_at === target.registration.createdAt &&
            String(monthly?.value ?? "") === action.monthlyPlanId && !(await openOfferSubscriptionIds(tx, new Date())).has(subscriptionId);
        }
```

In `listOutstandingProposals`, replace `(action_type='subscription_price_override' AND status IN ('approved','executing'))` with:

```sql
(action_type IN ('subscription_price_override','annual_plan_offer') AND status IN ('approved','executing'))
```

`finishExecution` already refuses a `revertAfter` for anything but a discount, and `assertRegistrationMutable` already handles object targets.

- [ ] **Step 4: Wire the executor** (`src/execution/execute.ts`)

Add imports:

```ts
import { executeAnnualOfferWith, type AnnualDependencies } from "./annual-offer";
import { recordAnnualOffer, recordAnnualPlan, recordAnnualTarget } from "@/ledger/annual-offers";
import { getSetting } from "@/ledger/operations";
import { createAnnualPlan, getPlan, reviseToPlan } from "@/paypal/plans";
import { hostedConfig } from "@/hosting/config";
```

Add `annual?: (proposal: Proposal) => AnnualDependencies;` to `type Dependencies`.

In `executeProposalWith`, replace `const action = proposal.action;` with:

```ts
  const action = proposal.action;
  if (action.type === "annual_plan_offer") {
    let annual: AnnualDependencies;
    try {
      if (!deps.annual) throw new Error("Annual offer execution is not wired.");
      annual = deps.annual(proposal);
    } catch { throw new ExecutionReconciliationRequired(id); }
    return executeAnnualOfferWith({ id: proposal.id, actionHash: proposal.actionHash, action }, annual);
  }
```

Add above `executeProposal`:

```ts
/** Where PayPal returns a customer after approving or cancelling a switch: the hosted origin, or local APP_URL. */
export function annualReturnUrl(env: Record<string, string | undefined> = process.env): string {
  const config = hostedConfig(env);
  return `${config.hosted ? config.origin : env.APP_URL ?? "http://localhost:3001"}/?paypal=annual`;
}

const annualDependencies = (proposal: Proposal): AnnualDependencies => ({
  monthlyPlanSetting: () => getSetting("paypal.plan_id"),
  getPlan, createPlan: createAnnualPlan, read: getSubscription, revise: reviseToPlan,
  validateTarget: (subscriptionId) => validateTargetForExecution(proposal, subscriptionId),
  recordObservation: (snapshot, source) => recordObservation(snapshot, source),
  recordPlan: (plan, debugId) => recordAnnualPlan(proposal.id, plan, debugId),
  recordOffer: (offer) => recordAnnualOffer(offer),
  recordTarget: (request, outcome) => recordAnnualTarget(proposal.id, request, outcome),
  finish: (status, summary) => finishExecution(proposal.id, status, null, summary),
  get: () => getProposal(proposal.id),
  now: () => new Date(),
  returnUrl: annualReturnUrl(),
});
```

Add `annual: annualDependencies` to the object passed in `executeProposal`. The `annualReturnUrl()` call runs inside `deps.annual(proposal)`, within the try above, so a configuration error becomes a reconciliation, never a half-run.

- [ ] **Step 5: Type the recovery panel** (`src/components/RecoveryPanel.tsx`)

```ts
const awaitsMerchantOnly = (type: Proposal["action"]["type"]) => type === "subscription_price_override" || type === "annual_plan_offer";
export function pendingActions(proposals: Proposal[]): Proposal[] {
  return proposals.filter((proposal) => awaitsMerchantOnly(proposal.action.type)
    ? ["approved", "executing"].includes(proposal.status)
    : ["proposed", "approved", "executing"].includes(proposal.status));
}
```

Make these changes:
- In the outstanding list label, insert `item.action.type === "annual_plan_offer" ? "annual offer" :` before `"discount"`.
- Change `proposal && proposal.action.type !== "subscription_price_override" && <RecoveryReview` to `proposal && !awaitsMerchantOnly(proposal.action.type) && <RecoveryReview`.
- Change `proposal?.action.type === "subscription_price_override" && <DiscountResumeReview` to `proposal && awaitsMerchantOnly(proposal.action.type) && <DiscountResumeReview`.
- In `RecoveryReview`, change the guard to `if (proposal.action.type === "subscription_price_override" || proposal.action.type === "annual_plan_offer") return null;`.

Replace the body of `DiscountResumeReview` with:

```tsx
  const action = proposal.action;
  if ((action.type !== "subscription_price_override" && action.type !== "annual_plan_offer") || !["approved", "executing"].includes(proposal.status)) return null;
  const annual = action.type === "annual_plan_offer";
  const ids = action.type === "annual_plan_offer" ? action.targets.map((target) => target.subscriptionId) : action.targets;
  const noun = annual ? "annual offer" : "discount";
  return <div className="mt-4 border-t border-border pt-4 text-sm">
    <p><strong>Approved {noun}:</strong> {action.type === "annual_plan_offer" ? `$${action.annualPrice}/yr (${action.discountPct}% off)` : `$${action.listPrice} → $${action.newPrice}`} for {ids.length} registered pilot(s).</p>
    <p><strong>Targets:</strong> <span className="break-all font-mono">{ids.join(", ")}</span></p>
    <p><strong>Payload hash:</strong> <span className="break-all font-mono">{proposal.actionHash}</span></p>
    {proposal.status === "approved" ? <>
      <p className="mt-2 text-muted">The prior approval remains recorded. This separate merchant request checks the exact hash and current state before any PayPal call.</p>
      <label className="mt-3 flex min-h-10 items-center gap-3"><input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(event) => onConfirm(event.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
        I confirm executing this already approved {noun} for {ids.length} PayPal Sandbox subscription(s).</label>
      <button type="button" disabled={!confirmed || busy || !canReview || !paypalConfigured} onClick={onResume} className="mt-2 min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background disabled:opacity-50">Execute approved {noun}</button>
    </> : <p className="mt-2 text-negative">Execution outcome requires ledger and PayPal reconciliation. Do not retry the PayPal action.</p>}
  </div>;
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run src/ledger src/execution src/components/RecoveryPanel.test.ts && npm run typecheck`

Expected: PASS, with no type errors. The importer still parses unknown actions as discounts; Task 10 fixes that before any annual proposal can exist.

- [ ] **Step 7: Commit**

```bash
git add src/ledger/proposals.ts src/ledger/annual-proposals.test.ts src/execution/execute.ts src/execution/execute.test.ts src/components/RecoveryPanel.tsx src/components/RecoveryPanel.test.ts
git commit -m "feat(ledger): claim and execute annual plan offers through the proposal flow"
```

---

### Task 9: Prepare annual offer proposals from live eligibility

Annual targets need live PayPal facts (ACTIVE, list price, monthly plan), unlike discounts, which snapshot the registry. Preparation reads PayPal outside any transaction. One transaction then re-checks the registry, claims and open offers, and inserts the exact hashed payload.

**Files:**
- Modify: `src/ledger/proposals.ts`, `src/app/api/proposals/route.ts`
- Create: `src/execution/annual-proposal.ts`, `src/execution/annual-proposal.test.ts`
- Test: `src/ledger/annual-proposals.test.ts`, `src/app/api/proposals/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/ledger/annual-proposals.test.ts`:
- move the inline `recordAnnualOffer(...)` call from the `open_annual_offer` case into this helper, and call `await recordOpenOffer(c, ID(9), "I-PILOTE")` there instead;
- add the imports `import { compareStrategies } from "@/twin/simulate";`, `import { currentMerchant } from "@/merchant";` and `import type { AnnualOfferAction } from "./annual-offer-action";`;
- append the new `describe` block.

```ts
async function recordOpenOffer(c: LedgerConnection, proposalId: string, subscriptionId: string) {
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await recordAnnualOffer({ proposalId, subscriptionId, segment: "core", annualPlanId: "P-ANNUAL0000000000000000001",
    approvalUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST", offeredAt: new Date().toISOString(), expiresAt, request: {},
    outcome: { subscriptionId, ok: true, httpStatus: 200, debugId: null, verified: false, observed: null, error: null, offer: { annualPlanId: "P-ANNUAL0000000000000000001", expiresAt } } }, c);
}

describe("annual offer proposal creation", () => {
  const result = compareStrategies(currentMerchant().twin, [strategy], { runs: 2, horizonMonths: 1 }).strategies[1];
  const input = { objective: "Annual", strategy, result, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7, eligibleIds: ["I-PILOTD", "I-PILOTE"] };

  it("snapshots live-eligible registered pilots into an exact hashed payload with its forecast", () => setup(async (_c, repo) => {
    const proposal = await repo.createAnnualOfferProposal(input);
    const action = proposal.action as AnnualOfferAction;
    expect(proposal).toMatchObject({ status: "proposed", objective: "Annual", strategy: { id: strategy.id } });
    expect(action).toMatchObject({ type: "annual_plan_offer", annualPrice: "244.80", listPrice: "24.00", offerWindowDays: 7, monthlyPlanId: MONTHLY });
    expect(action.targets.map((t) => t.subscriptionId)).toEqual(["I-PILOTD", "I-PILOTE"]);
    expect(proposal.actionHash).toBe(hashAction(action));
    expect(proposal.prediction).not.toBeNull();
  }));

  it("drops pilots with an open offer or a claim, and refuses when none remain", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(9), "succeeded");
    await recordOpenOffer(c, ID(9), "I-PILOTE");
    expect(((await repo.createAnnualOfferProposal(input)).action as AnnualOfferAction).targets.map((t) => t.subscriptionId)).toEqual(["I-PILOTD"]);
    await c.execute("INSERT INTO active_target_claims (target_id,proposal_id,claimed_at) VALUES ('I-PILOTD',?,?)", [ID(9), new Date().toISOString()]);
    await expect(repo.createAnnualOfferProposal(input)).rejects.toMatchObject({ code: "NO_TARGETS" });
  }));

  it("refuses a changed monthly plan, an invalid window or a non-annual strategy", () => setup(async (_c, repo) => {
    await expect(repo.createAnnualOfferProposal({ ...input, monthlyPlanId: "P-OTHER0000000000000000001" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(repo.createAnnualOfferProposal({ ...input, offerWindowDays: 0 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(repo.createAnnualOfferProposal({ ...input, strategy: STARTER_STRATEGIES[0] })).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
  }));
});
```

Create `src/execution/annual-proposal.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import type { Proposal } from "@/ledger/proposals";
import type { PlanSnapshot } from "@/paypal/plans";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";
import type { StrategyResult } from "@/twin/simulate";
import { prepareAnnualOfferProposalWith, type AnnualPreparationDependencies } from "./annual-proposal";

const MONTHLY = "P-MONTHLY000000000000000001";
const PRODUCT = "PROD-RIDGELINE0000000001";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const input = { objective: "Annual", strategy, result: {} as StrategyResult, listPrice: 24, offerWindowDays: 7 };
const plan = { planId: MONTHLY, productId: PRODUCT } as PlanSnapshot;
const live = (id: string, change: Partial<SubscriptionSnapshot> = {}) => ({ ok: true as const, debugId: null,
  value: { id, status: "ACTIVE", planId: MONTHLY, planOverridden: false, regularPrice: "24.0", nextBillingTime: null, lastPayment: null, raw: {}, ...change } });
function deps(change: Partial<AnnualPreparationDependencies> = {}): AnnualPreparationDependencies & { create: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> } {
  return {
    configured: () => true,
    setting: async (key) => (key === "paypal.plan_id" ? MONTHLY : key === "paypal.product_id" ? PRODUCT : null),
    getPlan: async () => ({ ok: true, value: plan, debugId: null }),
    list: async () => [
      { subscriptionId: "I-PILOTA", label: "Pilot A", segment: "cancel_intent", reason: "price" },
      { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other" },
      { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other" },
    ],
    read: vi.fn(async (id: string) => live(id, id === "I-PILOTE" ? { regularPrice: "18.00", planOverridden: true } : {})),
    create: vi.fn(async () => ({ id: "prop_annual" }) as Proposal),
    ...change,
  } as AnnualPreparationDependencies & { create: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
}

describe("annual offer preparation", () => {
  it("reads only pilots in the strategy's segments and passes only live-eligible IDs", async () => {
    const d = deps();
    await prepareAnnualOfferProposalWith(input, d);
    expect(d.read.mock.calls.map(([id]) => id)).toEqual(["I-PILOTD", "I-PILOTE"]);
    expect(d.create).toHaveBeenCalledWith({ ...input, productId: PRODUCT, monthlyPlanId: MONTHLY, eligibleIds: ["I-PILOTD"] });
  });
  it.each([
    ["PayPal is not configured", { configured: () => false }],
    ["the monthly plan is not registered", { setting: async () => null }],
    ["the monthly plan belongs to another product", { getPlan: async () => ({ ok: true as const, value: { ...plan, productId: "PROD-OTHER000000000000001" }, debugId: null }) }],
  ])("refuses before any subscriber read when %s", async (_name, change) => {
    const d = deps(change);
    await expect(prepareAnnualOfferProposalWith(input, d)).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(d.read).not.toHaveBeenCalled(); expect(d.create).not.toHaveBeenCalled();
  });
  it("refuses a strategy that is not an annual plan", async () => {
    await expect(prepareAnnualOfferProposalWith({ ...input, strategy: STARTER_STRATEGIES[0] }, deps())).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
  });
});
```

Append to `src/app/api/proposals/route.test.ts`, inside the existing `describe`:

```ts
  it("validates the annual offer window before any simulation or persistence", async () => {
    ledger().exec("DELETE FROM proposals;");
    const annual = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core"] } };
    for (const offerWindowDays of [0, 31, 1.5]) {
      const response = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ strategy: annual, offerWindowDays }) }));
      expect(response.status).toBe(400);
    }
    expect(await listProposals()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ledger/annual-proposals.test.ts src/execution/annual-proposal.test.ts src/app/api/proposals/route.test.ts`

Expected: FAIL.
- `createAnnualOfferProposal` and `./annual-proposal` do not exist.
- The route ignores `offerWindowDays`, and it returns 422 `NOT_EXECUTABLE` rather than 400.

- [ ] **Step 3: Implement the repository method** (`src/ledger/proposals.ts`)

Extend the import to `import { AnnualOfferActionSchema, buildAnnualOfferAction, type AnnualOfferAction, type AnnualOfferCandidate } from "./annual-offer-action";`. Then add this type after `CreateProposalInput`:

```ts
export type CreateAnnualProposalInput = {
  objective: string | null; strategy: Strategy; result: StrategyResult; listPrice: number;
  productId: string; monthlyPlanId: string; offerWindowDays: number;
  /** Subscriptions whose live PayPal read was eligible; the transaction re-checks registry, claims and open offers. */
  eligibleIds: readonly string[];
};
```

Add this repository method after `createProposal`:

```ts
    async createAnnualOfferProposal(input: CreateAnnualProposalInput): Promise<Proposal> {
      const strategy = StrategySchema.parse(input.strategy);
      if (strategy.intervention.kind !== "annual_plan") throw new ProposalError("Not an annual-plan strategy.", "NOT_EXECUTABLE");
      if (!Number.isInteger(input.offerWindowDays) || input.offerWindowDays < 1 || input.offerWindowDays > 30)
        throw new ProposalError("The offer window must be 1 to 30 whole days.", "INVALID_STATE");
      return authoritativeWrite(connection, async (tx) => {
        const monthly = (await tx.query("SELECT value FROM kv WHERE key='paypal.plan_id'"))[0];
        if (String(monthly?.value ?? "") !== input.monthlyPlanId) throw new ProposalError("The registered monthly plan changed; prepare the offer again.", "INVALID_STATE");
        const open = await openOfferSubscriptionIds(tx, new Date());
        const claimed = new Set((await tx.query("SELECT target_id FROM active_target_claims")).map((row) => String(row.target_id)));
        const eligible: AnnualOfferCandidate[] = (await tx.query("SELECT subscription_id,label,segment,reason,created_at FROM sandbox_subscribers ORDER BY rowid"))
          .filter((row) => input.eligibleIds.includes(String(row.subscription_id)) && !open.has(String(row.subscription_id)) && !claimed.has(String(row.subscription_id)))
          .map((row) => ({ subscriptionId: String(row.subscription_id), label: String(row.label), segment: String(row.segment), reason: String(row.reason), createdAt: String(row.created_at) }));
        let action: AnnualOfferAction;
        try {
          action = buildAnnualOfferAction({ strategy, listPrice: input.listPrice, productId: input.productId, monthlyPlanId: input.monthlyPlanId, offerWindowDays: input.offerWindowDays, eligible });
        } catch {
          throw new ProposalError("No subscriber is eligible for this annual offer: each must be a registered ACTIVE pilot at list price on the monthly plan, in the offered segments, with no open offer or claim.", "NO_TARGETS");
        }
        const prediction = { metrics: input.result.metrics, vsBaseline: input.result.vsBaseline, probValueBelowBaseline: input.result.probValueBelowBaseline };
        const id = `prop_${randomUUID()}`;
        await tx.execute(
          `INSERT INTO proposals (id, created_at, objective, strategy_json, simulation_json, action_type, action_json, action_hash, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
          [id, now(), input.objective, JSON.stringify(strategy), JSON.stringify(prediction), action.type, JSON.stringify(action), hashAction(action)],
        );
        await auditOn(tx, "proposal.created", id, { strategyId: strategy.id, action });
        return proposalOn(tx, id);
      });
    },
```

Add the runtime export next to the others:

```ts
export const createAnnualOfferProposal = async (input: CreateAnnualProposalInput) => (await runtimeRepository()).createAnnualOfferProposal(input);
```

- [ ] **Step 4: Implement preparation and dispatch** (`src/execution/annual-proposal.ts`)

```ts
import "server-only";
import { annualIneligibility } from "@/ledger/annual-offer-action";
import { getSetting } from "@/ledger/operations";
import {
  createAnnualOfferProposal, createProposal, listSandboxSubscribers, ProposalError,
  type CreateAnnualProposalInput, type CreateProposalInput, type Proposal, type SandboxSubscriber,
} from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getPlan, type PlanSnapshot } from "@/paypal/plans";
import { getSubscription, type Result, type SubscriptionSnapshot } from "@/paypal/subscriptions";
import type { Strategy } from "@/twin/interventions";
import type { StrategyResult } from "@/twin/simulate";

export const DEFAULT_OFFER_WINDOW_DAYS = 7;
export interface AnnualProposalInput { objective: string | null; strategy: Strategy; result: StrategyResult; listPrice: number; offerWindowDays: number }
export interface AnnualPreparationDependencies {
  configured: () => boolean;
  setting: (key: string) => Promise<string | null>;
  getPlan: (planId: string) => Promise<Result<PlanSnapshot>>;
  list: () => Promise<SandboxSubscriber[]>;
  read: (subscriptionId: string) => Promise<Result<SubscriptionSnapshot>>;
  create: (input: CreateAnnualProposalInput) => Promise<Proposal>;
}

/** Live eligibility at build time: ACTIVE, on the registered monthly plan, at list price by cents. Reads only; no mutation. */
export async function prepareAnnualOfferProposalWith(input: AnnualProposalInput, deps: AnnualPreparationDependencies): Promise<Proposal> {
  const iv = input.strategy.intervention;
  if (iv.kind !== "annual_plan") throw new ProposalError("Not an annual-plan strategy.", "NOT_EXECUTABLE");
  if (!deps.configured()) throw new ProposalError("PayPal Sandbox is not configured; annual offers need live eligibility reads.", "NOT_EXECUTABLE");
  const [monthlyPlanId, productId] = await Promise.all([deps.setting("paypal.plan_id"), deps.setting("paypal.product_id")]);
  if (!monthlyPlanId || !productId) throw new ProposalError("The monthly plan and product are not registered; run paypal:setup.", "NOT_EXECUTABLE");
  const monthly = await deps.getPlan(monthlyPlanId);
  if (!monthly.ok || monthly.value.productId !== productId) throw new ProposalError("The registered monthly plan could not be verified against the product.", "NOT_EXECUTABLE");
  const listPrice = input.listPrice.toFixed(2);
  const eligibleIds: string[] = [];
  for (const pilot of (await deps.list()).filter((s) => (iv.segments as readonly string[]).includes(s.segment))) {
    const read = await deps.read(pilot.subscriptionId);
    if (read.ok && annualIneligibility(read.value, { subscriptionId: pilot.subscriptionId, monthlyPlanId, listPrice }) === null) eligibleIds.push(pilot.subscriptionId);
  }
  return deps.create({ ...input, productId, monthlyPlanId, eligibleIds });
}

export const prepareAnnualOfferProposal = (input: AnnualProposalInput) => prepareAnnualOfferProposalWith(input, {
  configured: paypalConfigured, setting: getSetting, getPlan, list: listSandboxSubscribers, read: getSubscription, create: createAnnualOfferProposal,
});

/** The single "propose this strategy" entry point for the API and the agent. */
export async function proposeStrategy(input: CreateProposalInput & { offerWindowDays?: number }): Promise<Proposal> {
  if (input.strategy.intervention.kind !== "annual_plan") return createProposal(input);
  return prepareAnnualOfferProposal({ objective: input.objective, strategy: input.strategy, result: input.result, listPrice: input.listPrice,
    offerWindowDays: input.offerWindowDays ?? DEFAULT_OFFER_WINDOW_DAYS });
}
```

- [ ] **Step 5: Accept the window in the route** (`src/app/api/proposals/route.ts`)

- Replace the `createProposal` import with `import { listProposals } from "@/ledger/proposals";` and add `import { proposeStrategy } from "@/execution/annual-proposal";`.
- Add to `BodySchema`: `offerWindowDays: z.number().int().min(1).max(30).optional(),`.
- Replace the `createProposal(...)` call with:

```ts
    const proposal = await proposeStrategy({ objective: body.objective, strategy: body.strategy, result, listPrice: twin.params.listPrice, offerWindowDays: body.offerWindowDays });
```

`src/merchant/observed-integration.test.ts` mocks `createProposal` in `@/ledger/proposals`. `proposeStrategy` imports it from there, so the existing mock still applies.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/ledger/annual-proposals.test.ts src/execution/annual-proposal.test.ts src/app/api/proposals src/merchant`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ledger/proposals.ts src/ledger/annual-proposals.test.ts src/execution/annual-proposal.ts src/execution/annual-proposal.test.ts src/app/api/proposals/route.ts src/app/api/proposals/route.test.ts
git commit -m "feat(m7): prepare annual offer proposals from live PayPal eligibility"
```

---

### Task 10: Strict export and import of annual offers

**Files:**
- Create: `src/test/annual-offer-fixture.ts`
- Modify: `src/ledger/import.ts`
- Test: `src/ledger/import.test.ts`, `src/ledger/export.test.ts`

- [ ] **Step 1: Create the shared offline fixture** `src/test/annual-offer-fixture.ts`

This is not a test file (Vitest includes only `*.test.ts`). Tasks 10, 12, 13 and 14 reuse it.

```ts
import { compareStrategies } from "@/twin/simulate";
import { currentMerchant } from "@/merchant";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { initializeLedgerSchema, type LedgerConnection } from "@/ledger/connection";
import { createProposalRepository } from "@/ledger/proposals";
import { appendOfferReads, recordAnnualOffer } from "@/ledger/annual-offers";
import { offerExpiry } from "@/ledger/annual-offer-status";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";

export const FIXTURE_MONTHLY_PLAN = "P-MONTHLY000000000000000001";
export const FIXTURE_ANNUAL_PLAN = "P-ANNUAL0000000000000000001";
export const FIXTURE_PRODUCT = "PROD-RIDGELINE0000000001";
/** Fake approval link; the token is not real. */
export const fixtureLink = (subscriptionId: string) =>
  `https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-FIXTURE${subscriptionId.replace("I-", "")}`;

/** Registers Pilot D as I-PILOTD, then proposes, approves, claims and issues a one-target annual offer; optionally records a switched read. */
export async function seedAnnualOffer(connection: LedgerConnection, options: { offeredAt?: string; switchedAt?: string } = {}) {
  await initializeLedgerSchema(connection);
  const repo = createProposalRepository(connection);
  const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
  await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTD", ...PILOT_COHORT.find((pilot) => pilot.segment === "core")! });
  await connection.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('paypal.plan_id', ?)", [FIXTURE_MONTHLY_PLAN]);
  const result = compareStrategies(currentMerchant().twin, [strategy], { runs: 2, horizonMonths: 1 }).strategies[1];
  const proposal = await repo.createAnnualOfferProposal({ objective: "Annual fixture", strategy, result, listPrice: 24, productId: FIXTURE_PRODUCT,
    monthlyPlanId: FIXTURE_MONTHLY_PLAN, offerWindowDays: 7, eligibleIds: ["I-PILOTD"] });
  await repo.approveProposal(proposal.id, proposal.actionHash, "fixture administrator");
  await repo.claimForExecution(proposal.id);
  const offeredAt = options.offeredAt ?? "2026-11-01T00:00:00.000Z";
  const expiresAt = offerExpiry(offeredAt, 7);
  const offerId = await recordAnnualOffer({
    proposalId: proposal.id, subscriptionId: "I-PILOTD", segment: "core", annualPlanId: FIXTURE_ANNUAL_PLAN, approvalUrl: fixtureLink("I-PILOTD"),
    offeredAt, expiresAt, request: { subscriptionId: "I-PILOTD", operation: "revise", planId: FIXTURE_ANNUAL_PLAN },
    outcome: { subscriptionId: "I-PILOTD", ok: true, httpStatus: 200, debugId: "dbg-fixture", verified: false, observed: null, error: null, offer: { annualPlanId: FIXTURE_ANNUAL_PLAN, expiresAt } },
  }, connection);
  await repo.finishExecution(proposal.id, "succeeded", null, { succeeded: 1, total: 1 });
  if (options.switchedAt) await appendOfferReads("I-PILOTD", { status: "ACTIVE", planId: FIXTURE_ANNUAL_PLAN, debugId: "dbg-read" }, options.switchedAt, connection);
  return { proposal, offerId, expiresAt };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/ledger/import.test.ts`, adding `import { fixtureLink, seedAnnualOffer } from "@/test/annual-offer-fixture";`:

```ts
async function annualSource(path: string) {
  const source = new DatabaseSync(path);
  await seedAnnualOffer(createLocalConnection(source), { switchedAt: "2026-11-01T00:10:00.000Z" });
  source.close();
}

it("round trips an annual offer, its link and reads through a checked libSQL target", async () => {
  const path = join(dir, "annual-source.sqlite");
  await annualSource(path);
  const source = new DatabaseSync(path, { readOnly: true });
  const offers = source.prepare("SELECT * FROM annual_offers").all();
  const reads = source.prepare("SELECT * FROM annual_offer_reads").all();
  source.close();
  const client = createClient({ url: `file:${join(dir, "annual-target.sqlite")}` });
  try {
    const target = createLibsqlConnection(client); await initializeLedgerSchema(target);
    const manifest = await importLedger({ sourcePath: path, target });
    expect(await target.query("SELECT * FROM annual_offers")).toEqual(offers);
    expect(await target.query("SELECT * FROM annual_offer_reads")).toEqual(reads);
    expect(JSON.stringify(manifest)).not.toContain("ba_token");
  } finally { client.close(); }
});

it.each([
  ["a segment that differs from the registration", "UPDATE annual_offers SET segment='new'"],
  ["a date-only deadline", "UPDATE annual_offers SET expires_at='2026-11-08'"],
  ["a deadline outside the approved window", "UPDATE annual_offers SET expires_at='2026-11-09T00:00:00.000Z'"],
  ["a non-PayPal link", "UPDATE annual_offers SET approval_url='https://evil.example/approve'"],
  ["an unplanned annual plan ID", "UPDATE annual_offers SET annual_plan_id='plan'"],
  ["a failed linked execution", "UPDATE executions SET ok=0"],
  ["an unparseable read time", "UPDATE annual_offer_reads SET observed_at='yesterday'"],
  ["a link leaked into the audit log", `UPDATE audit_events SET detail_json='{"note":"${fixtureLink("I-PILOTD")}"}' WHERE id=(SELECT MAX(id) FROM audit_events)`],
  ["a missing forecast", "UPDATE proposals SET simulation_json='null'"],
  ["a scheduled revert", "UPDATE proposals SET revert_after='2027-01-01T00:00:00.000Z'"],
])("rejects an annual offer ledger with %s before target access", async (name, sql) => {
  const path = join(dir, `annual-invalid-${name.replaceAll(" ", "-")}.sqlite`);
  await annualSource(path);
  const source = new DatabaseSync(path); source.exec(sql); source.close();
  const openTarget = vi.fn();
  await expect(importLedger({ sourcePath: path, openTarget })).rejects.toThrow(/annual|proposal|link/i);
  expect(openTarget).not.toHaveBeenCalled();
});
```

The path is built from the case name with spaces replaced by dashes. No case name contains a character that is invalid on Windows.

Append to `src/ledger/export.test.ts`, adding `import { fixtureLink, seedAnnualOffer } from "@/test/annual-offer-fixture";`:

```ts
it("exports annual offers with their links in the private backup while the manifest carries only counts and hashes", async () => {
  const client = createClient({ url: `file:${join(dir, "annual.sqlite")}` });
  try {
    const connection = createLibsqlConnection(client);
    await seedAnnualOffer(connection, { switchedAt: "2026-11-01T00:10:00.000Z" });
    const output = join(dir, "annual-backup.sqlite");
    const manifest = await exportLedger({ outputPath: output, source: connection });
    expect(manifest.tables.find((t) => t.table === "annual_offers")?.count).toBe(1);
    expect(manifest.tables.find((t) => t.table === "annual_offer_reads")?.count).toBe(1);
    expect(JSON.stringify(manifest)).not.toContain("ba_token");
    const backup = new DatabaseSync(output, { readOnly: true });
    try { expect(backup.prepare("SELECT approval_url FROM annual_offers").all()).toEqual([{ approval_url: fixtureLink("I-PILOTD") }]); }
    finally { backup.close(); }
  } finally { client.close(); }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/ledger/import.test.ts src/ledger/export.test.ts`

Expected: FAIL. The importer parses the annual action as a discount, giving "Source proposal schema is invalid" for the valid round trip.

- [ ] **Step 4: Implement** (`src/ledger/import.ts`)

Add imports:

```ts
import { AnnualOfferActionSchema } from "./annual-offer-action";
import { offerExpiry, parseIsoInstant } from "./annual-offer-status";
import { ANNUAL_REVISE_OPERATION } from "./annual-offers";
import { isPayPalApprovalUrl } from "@/paypal/approval-link";
```

In `validateRecords`'s proposal loop, replace the action and strategy parsing:

```ts
      action = raw.type === "subscription_price_revert" ? RevertActionSchema.parse(raw) :
        raw.type === "subscription_price_reset" ? ResetActionSchema.parse(raw) :
        raw.type === "annual_plan_offer" ? AnnualOfferActionSchema.parse(raw) : PriceOverrideActionSchema.parse(raw);
      const strategy = JSON.parse(String(row.strategy_json));
      if (action.type === "subscription_price_reset") { if (strategy !== null) throw new Error("Invalid reset strategy"); }
      else if (StrategySchema.parse(strategy).intervention.kind !== "annual_plan" && action.type === "annual_plan_offer") throw new Error("Invalid annual strategy");
      const prediction = JSON.parse(String(row.simulation_json));
      const forecastless = action.type === "subscription_price_revert" || action.type === "subscription_price_reset";
      if (forecastless ? prediction !== null : prediction === null) throw new Error("Invalid prediction metadata");
```

After the existing `if (action.type === "subscription_price_revert") { ... }` block, still inside the proposal loop, add:

```ts
    if (action.type === "annual_plan_offer") {
      if (row.revert_after !== null) throw new Error("Source annual offer cannot schedule a recovery");
      const approved = !["proposed", "rejected"].includes(String(row.status));
      if (approved ? !Number.isFinite(Date.parse(String(row.approved_at))) || typeof row.approved_by !== "string" || !row.approved_by.trim()
        : row.approved_at !== null || row.approved_by !== null) throw new Error("Source annual offer approval state is invalid");
    }
```

After the `discount_episodes` loop, add:

```ts
  const links: string[] = [];
  for (const row of of("annual_offers")) {
    const proposal = of("proposals").find((candidate) => candidate.id === row.proposal_id);
    const execution = of("executions").find((candidate) => candidate.id === row.execution_id);
    const parsed = proposal?.action_type === "annual_plan_offer" ? AnnualOfferActionSchema.safeParse(JSON.parse(String(proposal.action_json))) : null;
    const action = parsed?.success ? parsed.data : null;
    const target = action?.targets.find((candidate) => candidate.subscriptionId === row.subscription_id);
    let expected: string | null = null;
    try { expected = action && typeof row.offered_at === "string" ? offerExpiry(row.offered_at, action.offerWindowDays) : null; } catch { expected = null; }
    if (!proposal || !action || !target || !execution || !["executing", "succeeded", "partially_failed"].includes(String(proposal.status)) ||
      !SEGMENTS.includes(String(row.segment) as typeof SEGMENTS[number]) || row.segment !== target.registration.segment ||
      !/^P-[A-Z0-9]+$/.test(String(row.annual_plan_id)) || typeof row.approval_url !== "string" || !isPayPalApprovalUrl(row.approval_url) ||
      typeof row.expires_at !== "string" || parseIsoInstant(row.expires_at) === null || row.expires_at !== expected ||
      execution.proposal_id !== row.proposal_id || execution.target_id !== row.subscription_id || execution.operation !== ANNUAL_REVISE_OPERATION ||
      Number(execution.ok) !== 1 || execution.created_at !== row.offered_at) throw new Error("Source annual offer is invalid");
    links.push(row.approval_url);
  }
  for (const row of of("annual_offer_reads")) {
    if (!of("annual_offers").some((offer) => offer.id === row.offer_id) || typeof row.observed_at !== "string" || parseIsoInstant(row.observed_at) === null ||
      typeof row.status !== "string" || !row.status.trim() || (row.plan_id !== null && !/^P-[A-Z0-9]+$/.test(String(row.plan_id))))
      throw new Error("Source annual offer read is invalid");
  }
  // Approval links are secrets: they may live only in annual_offers.approval_url.
  const exposes = (value: unknown) => typeof value === "string" && (value.includes("ba_token") || links.some((link) => value.includes(link)));
  if (of("executions").some((row) => exposes(row.request_json) || exposes(row.response_json)) || of("audit_events").some((row) => exposes(row.detail_json)))
    throw new Error("Source ledger stores an approval link outside annual offers");
```

`offerExpiry` requires a strict ISO instant `offered_at`, so a malformed `offered_at` also fails here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ledger`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/test/annual-offer-fixture.ts src/ledger/import.ts src/ledger/import.test.ts src/ledger/export.test.ts
git commit -m "feat(ledger): export and strictly import annual offers without leaking links"
```

---

### Task 11: Price changes and reset refuse annual subscribers by plan

A switched subscriber reads back at the yearly price on the yearly plan. Without this task, a reset whose captured price is `244.80` would PATCH a yearly plan to `24.00`.

**Files:**
- Modify: `src/execution/execute.ts`, `src/execution/reset.ts`, `src/components/RecoveryPanel.tsx`
- Test: `src/execution/execute.test.ts`, `src/execution/reset.test.ts`, `src/components/RecoveryPanel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/execution/execute.test.ts`:

```ts
it.each(["subscription_price_reset", "subscription_price_override"] as const)("never PATCHes a subscriber who switched to an annual plan (%s)", async (type) => {
  const proposal = { id: "p", action: type === "subscription_price_reset"
    ? { type, canonicalListPrice: "24.00", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "244.80" }] }
    : { type, targets: ["I-ONE"], listPrice: "244.80", newPrice: "18.00", months: 3 } } as Proposal;
  const patch = vi.fn(); const finish = vi.fn();
  const report = await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish, patch, record: vi.fn(),
    read: async () => ({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "244.8", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: "P-ANNUAL1", raw: {} }, debugId: null }),
    annualPlanIds: async () => new Set(["P-ANNUAL1"]) });
  expect(patch).not.toHaveBeenCalled();
  expect(report.outcomes[0]).toMatchObject({ ok: false, error: expect.stringMatching(/annual plan by customer choice/) });
  expect(finish).toHaveBeenCalledWith("p", "failed", null, { succeeded: 0, total: 1 });
});
```

Both cases are built to PATCH under today's code, because the captured price `244.80` matches the read-back `244.8` by cents.

Append to `src/execution/reset.test.ts`:

```ts
it("skips a pilot on an annual plan by customer choice instead of resetting it", async () => {
  const read = vi.fn(async (id: string) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "244.8", planOverridden: false, planId: "P-ANNUAL1" }, debugId: null } as never));
  const create = vi.fn();
  const preview = await previewDemoResetWith({ list: async () => [{ subscriptionId: "I-A", ...PILOT_COHORT[0] }],
    registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z" }), read, create, listPrice: () => 24, annualPlanIds: async () => new Set(["P-ANNUAL1"]) });
  expect(create).not.toHaveBeenCalled();
  expect(preview.skipped[0]).toEqual({ label: PILOT_COHORT[0].label, subscriptionId: "I-A", reason: "annual_plan" });
});
```

Append to `src/components/RecoveryPanel.test.ts`, adding `RESET_SKIP_TEXT` to the import from `./RecoveryPanel`:

```ts
it("reports an annual subscriber as a customer choice, not a reset failure", () => {
  expect(RESET_SKIP_TEXT.annual_plan).toBe("switched to annual by customer choice; not reset");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/execution/execute.test.ts src/execution/reset.test.ts src/components/RecoveryPanel.test.ts`

Expected: FAIL. The PATCH is called, and `annualPlanIds` and `RESET_SKIP_TEXT` are unknown.

- [ ] **Step 3: Implement**

In `src/execution/execute.ts`:
- add `annualPlanIds?: () => Promise<ReadonlySet<string>>;` to `Dependencies`;
- add `listAnnualPlanIds` to the `@/ledger/annual-offers` import;
- after the annual dispatch block in `executeProposalWith` (Task 8), add:

```ts
  let annualPlans: ReadonlySet<string>;
  try { annualPlans = await (deps.annualPlanIds?.() ?? Promise.resolve(new Set<string>())); }
  catch { throw new ExecutionReconciliationRequired(id); }
```

Insert this check directly before the existing reset "Already at canonical list price" check:

```ts
    if (current.planId !== null && annualPlans.has(current.planId)) {
      const outcome: TargetOutcome = { subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false,
        observed: { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime },
        error: "On an annual plan by customer choice; the price was not changed." };
      try { await deps.record(id, request, outcome, null); } catch { throw new ExecutionReconciliationRequired(id); }
      outcomes.push(outcome);
      continue;
    }
```

Then add `annualPlanIds: () => listAnnualPlanIds()` to the object passed in `executeProposal`.

In `src/execution/reset.ts`:
- extend the reason union to `"already_list_price" | "inactive" | "unregistered" | "annual_plan"`;
- add `annualPlanIds?: () => Promise<ReadonlySet<string>>;` to `ResetDependencies`;
- add `const annualPlans = await (deps.annualPlanIds?.() ?? Promise.resolve(new Set<string>()));` before the target loop;
- directly after the identity check `if (!read.ok || read.value.id !== pilot.subscriptionId) throw ...`, add:

```ts
    if (read.value.planId && annualPlans.has(read.value.planId)) { skipped.push({ label: member.label, subscriptionId: pilot.subscriptionId, reason: "annual_plan" }); continue; }
```

In `previewDemoReset`, add `annualPlanIds: () => listAnnualPlanIds(),` to the dependencies and import `listAnnualPlanIds` from `@/ledger/annual-offers`.

In `src/components/RecoveryPanel.tsx`:

```ts
export const RESET_SKIP_TEXT: Record<ResetPreview["skipped"][number]["reason"], string> = {
  already_list_price: "already at list price", inactive: "inactive", unregistered: "unregistered",
  annual_plan: "switched to annual by customer choice; not reset",
};
```

Replace `{pilot.reason.replaceAll("_", " ")}` with `{RESET_SKIP_TEXT[pilot.reason]}`.

Revert actions go through the same executor check. There is no separate revert path to change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/execution src/components/RecoveryPanel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/execute.ts src/execution/execute.test.ts src/execution/reset.ts src/execution/reset.test.ts src/components/RecoveryPanel.tsx src/components/RecoveryPanel.test.ts
git commit -m "fix(execution): refuse price changes and resets for annual subscribers"
```

---

### Task 12: Status refresh appends offer reads; public offer views without links

**Files:**
- Modify: `src/app/api/paypal/status/route.ts`
- Create: `src/app/api/paypal/status/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, it, vi } from "vitest";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";

const mocks = vi.hoisted(() => ({ getSubscription: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("@/paypal/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/client")>()), paypalConfigured: () => true }));
vi.mock("@/paypal/subscriptions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/subscriptions")>()), getSubscription: mocks.getSubscription }));

import { ledger } from "@/ledger/db";
import { runtimeLedgerConnection } from "@/ledger/connection";
import { FIXTURE_ANNUAL_PLAN, FIXTURE_MONTHLY_PLAN, seedAnnualOffer } from "@/test/annual-offer-fixture";
import { GET } from "./route";

const live = (id: string, planId: string): Result<SubscriptionSnapshot> => ({ ok: true, debugId: "dbg-status",
  value: { id, status: "ACTIVE", planId, planOverridden: false, regularPrice: planId === FIXTURE_ANNUAL_PLAN ? "244.8" : "24.0", nextBillingTime: "2026-11-30T10:00:00Z", lastPayment: null, raw: {} } });
const status = async () => (await GET(new Request("http://localhost/api/paypal/status"))).json();
const reads = () => ledger().prepare("SELECT status, plan_id, debug_id FROM annual_offer_reads ORDER BY id").all();

beforeEach(async () => {
  ledger().exec("DELETE FROM annual_offer_reads; DELETE FROM annual_offers; DELETE FROM active_target_claims; DELETE FROM executions; DELETE FROM observations; DELETE FROM audit_events; DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM kv;");
  mocks.getSubscription.mockReset();
  await seedAnnualOffer(await runtimeLedgerConnection(), { offeredAt: new Date(Date.now() - 3_600_000).toISOString() });
});

it("appends a read per offer on each successful GET and reports the switch without any link", async () => {
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_ANNUAL_PLAN));
  const body = await status();
  await status();
  expect(body.annualOffers).toEqual([expect.objectContaining({ subscriptionId: "I-PILOTD", status: "switched", outcome: "accepted" })]);
  expect(body.subscriptions[0].live).toMatchObject({ annualPlan: true, regularPrice: "244.8" });
  expect(JSON.stringify(body)).not.toMatch(/ba_token|paypal\.com/);
  expect(reads()).toEqual([
    { status: "ACTIVE", plan_id: FIXTURE_ANNUAL_PLAN, debug_id: "dbg-status" },
    { status: "ACTIVE", plan_id: FIXTURE_ANNUAL_PLAN, debug_id: "dbg-status" },
  ]);
});

it("records nothing for a failed GET and keeps the offer pending", async () => {
  mocks.getSubscription.mockResolvedValue({ ok: false, error: { httpStatus: 503, name: "UNAVAILABLE", message: "down", debugId: null, details: null } });
  const body = await status();
  expect(reads()).toEqual([]);
  expect(body.subscriptions[0]).toMatchObject({ error: "Live status unavailable." });
  expect(body.annualOffers[0]).toMatchObject({ status: "pending", needsRead: true });
});

it("still reads a subscription with an open offer after it left the pilot registry", async () => {
  ledger().exec("DELETE FROM sandbox_subscribers;");
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_MONTHLY_PLAN));
  const body = await status();
  expect(mocks.getSubscription).toHaveBeenCalledWith("I-PILOTD");
  expect(body.subscriptions).toEqual([]);
  expect(reads()).toEqual([{ status: "ACTIVE", plan_id: FIXTURE_MONTHLY_PLAN, debug_id: "dbg-status" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/paypal/status/route.test.ts`

Expected: FAIL. There is no `annualOffers` and no reads.

- [ ] **Step 3: Implement** (replace `src/app/api/paypal/status/route.ts`)

```ts
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
 * subscription that received annual offers appends one read per offer. The payload never carries links.
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
      await recordObservation(r.value, "paypal.status");
      if (offered.has(subscriptionId)) await appendOfferReads(subscriptionId, { status: r.value.status, planId: r.value.planId, debugId: r.debugId }, new Date().toISOString());
      return r;
    };
    const subscriptions = configured
      ? await Promise.all(registered.map(async (s) => {
          const r = await readAndRecord(s.subscriptionId);
          return r.ok
            ? { ...s, live: { status: r.value.status, regularPrice: r.value.regularPrice, planOverridden: r.value.planOverridden, nextBillingTime: r.value.nextBillingTime,
                annualPlan: r.value.planId !== null && annualPlans.has(r.value.planId) } }
            : { ...s, error: "Live status unavailable." };
        }))
      : registered;
    if (configured) {
      const registeredIds = new Set(registered.map((s) => s.subscriptionId));
      const orphaned = [...new Set(before.filter((offer) => offer.needsRead && !registeredIds.has(offer.subscriptionId)).map((offer) => offer.subscriptionId))];
      await Promise.all(orphaned.map(readAndRecord));
    }
    return Response.json({ environment: "sandbox", configured, planId: await getSetting("paypal.plan_id"), subscriptions, annualOffers: await listAnnualOfferViews() });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/paypal/status/route.test.ts src/hosting/routes.test.ts`

Expected: PASS. The hosted polling limit test still returns 429.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/paypal/status/route.ts src/app/api/paypal/status/route.test.ts
git commit -m "feat(m7): record annual offer reads on every PayPal status refresh"
```

---

### Task 13: Administrator-only draft messages with approval links

**Files:**
- Create: `src/app/api/annual-offers/links/route.ts`, `src/app/api/annual-offers/links/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledger } from "@/ledger/db";
import { createLocalConnection, runtimeLedgerConnection } from "@/ledger/connection";
import { createHostingStore } from "@/hosting/store";
import { fixtureLink, seedAnnualOffer } from "@/test/annual-offer-fixture";
import { GET } from "./route";

vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));

const dir = mkdtempSync(join(tmpdir(), "aurrery-offer-links-"));
const origin = "https://example.test";
beforeAll(async () => {
  vi.stubEnv("HOSTED_DEMO", "true"); vi.stubEnv("RENDER", "false"); vi.stubEnv("APP_URL", origin);
  vi.stubEnv("HOSTED_SECRET", "s".repeat(48)); vi.stubEnv("ADMIN_PASSWORD", "p".repeat(40));
  vi.stubEnv("LEDGER_PATH", join(dir, "ledger.sqlite"));
  await seedAnnualOffer(await runtimeLedgerConnection(), { offeredAt: new Date(Date.now() - 3_600_000).toISOString() });
});
afterAll(() => { ledger().close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const request = (cookie?: string) => new Request(`${origin}/api/annual-offers/links`, { headers: cookie ? { cookie } : undefined });

it("refuses visitors without an administrator session and never returns a link", async () => {
  const response = await GET(request());
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("ba_token");
});

it("returns the uncached draft message with the link to an administrator", async () => {
  const token = await createHostingStore(createLocalConnection(ledger()), "s".repeat(48)).createSession("p".repeat(40));
  const response = await GET(request(`__Host-aurrery-admin=${token}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { offers } = await response.json();
  expect(offers).toEqual([expect.objectContaining({ subscriptionId: "I-PILOTD", label: expect.stringContaining("Pilot D"), message: expect.stringContaining(fixtureLink("I-PILOTD")) })]);
  expect(offers[0].message).toContain("next renewal date");
  expect(offers[0].message).toContain("$244.80 a year");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/annual-offers/links/route.test.ts`

Expected: FAIL. The route does not exist.

- [ ] **Step 3: Implement** `src/app/api/annual-offers/links/route.ts`

```ts
import { connection } from "next/server";
import { admitHostedRequest } from "@/hosting/guard";
import { currentMerchant } from "@/merchant";
import { listAnnualOfferLinks } from "@/ledger/annual-offers";
import { draftAnnualOfferMessage } from "@/ledger/annual-offer-message";
import { listSandboxSubscribers } from "@/ledger/proposals";
import { errorResponse } from "../../_lib/http";

/** Administrator only: display-only draft messages carrying the secret approval links of open offers. Never cached or logged. */
export async function GET(request: Request) {
  await connection();
  const admission = await admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  try {
    const { merchant } = currentMerchant().twin;
    const labels = new Map((await listSandboxSubscribers()).map((s) => [s.subscriptionId, s.label]));
    const offers = (await listAnnualOfferLinks()).map((offer) => ({
      id: offer.id, subscriptionId: offer.subscriptionId, label: labels.get(offer.subscriptionId) ?? null, expiresAt: offer.expiresAt,
      message: draftAnnualOfferMessage({ merchantName: merchant.name, planName: merchant.planName, annualPrice: offer.annualPrice,
        discountPct: offer.discountPct, expiresAt: offer.expiresAt, approvalUrl: offer.approvalUrl }),
    }));
    return Response.json({ offers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
```

`errorResponse` returns a fixed `INTERNAL` body for unknown errors, so no link can surface through an error.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/annual-offers/links/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/annual-offers/links
git commit -m "feat(m7): serve annual offer drafts to administrators only"
```

---

### Task 14: Learn annual uptake in the observed-merchant path

**Files:**
- Modify: `src/merchant/observed.ts`, `src/merchant/observed-snapshot.ts`, `src/merchant/demo.ts`, `src/agent/run.ts`, `src/app/api/twin/route.ts`, `src/app/page.tsx`, `src/components/Lab.tsx` (the `MerchantSummary` field only)
- Create: `src/merchant/observed.test.ts`

- [ ] **Step 1: Write the failing test** `src/merchant/observed.test.ts`

```ts
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createLocalConnection } from "@/ledger/connection";
import { seedAnnualOffer } from "@/test/annual-offer-fixture";
import { currentMerchant } from ".";
import { observedMerchant } from "./observed";
import { ObservedSnapshotSchema, toObservedSnapshot } from "./observed-snapshot";

async function view(switchedAt?: string) {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db);
    await seedAnnualOffer(connection, { switchedAt });
    return await observedMerchant(connection, "2026-11-02T00:00:00.000Z");
  } finally { db.close(); }
}

it("learns core annual uptake from a verified switch on a request-owned copy, separate from discount changes", async () => {
  const before = currentMerchant().twin.params.segments.core.annualUptake;
  const observed = await view("2026-11-01T00:10:00.000Z");
  expect(observed.twin.params.segments.core.annualUptake).toEqual({ alpha: before.alpha + 1, beta: before.beta });
  expect(currentMerchant().twin.params.segments.core.annualUptake).toEqual(before);
  expect(observed.changes).toEqual([]);
  expect(observed.annual.offers).toEqual([{ segment: "core", accepted: 1, declined: 0, unresolved: 0 }]);
  expect(observed.annual.changes.map((change) => change.parameter)).toEqual(["segments.core.annualUptake"]);
  const note = observed.twin.provenance["segments.core.annualUptake"];
  expect(note).toMatchObject({ source: "observed", evidenceCount: 1 });
  expect(note.note).toContain("not a randomized");
  expect(note.note).not.toContain("causal retention");
  expect(toObservedSnapshot(observed).annual?.changes).toHaveLength(1);
});

it("leaves the twin unchanged while every offer is unresolved", async () => {
  const observed = await view();
  expect(observed.annual.offers).toEqual([{ segment: "core", accepted: 0, declined: 0, unresolved: 1 }]);
  expect(observed.annual.changes).toEqual([]);
  expect(observed.twin.provenance).not.toHaveProperty(["segments.core.annualUptake"]);
  expect(observed.twin.provenance.annualUptake.note).not.toContain("no annual plan has been tried");
});

it("still accepts run snapshots recorded before annual evidence existed", () => {
  const legacy = { evidence: { episodes: 0, cancellations: 0, censoredEpisodes: 0, subscriberMonths: 0, posteriorSubscriberMonths: 0, posteriorCancellations: 0, limitation: "x" }, changes: [], provenance: {} };
  expect(ObservedSnapshotSchema.parse(legacy)).not.toHaveProperty("annual");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/merchant/observed.test.ts`

Expected: FAIL. `observed.annual` is undefined.

- [ ] **Step 3: Implement**

`src/merchant/observed-snapshot.ts`: import `SEGMENTS` (`import { SEGMENTS, type MerchantTwin } from "@/twin/types";`), then replace the schema and `toObservedSnapshot`:

```ts
const change = z.object({ parameter: text, before: estimate, after: estimate, evidence: text });
export const ObservedSnapshotSchema = z.object({
  evidence: z.object({ episodes: count, cancellations: count, censoredEpisodes: count, subscriberMonths: exposure, posteriorSubscriberMonths: exposure, posteriorCancellations: count, limitation: text }),
  /** Discount effect changes only: one per leaving reason. */
  changes: z.array(change).max(2),
  /** Annual offers are separate evidence with their own limitation. Optional so earlier recorded runs stay valid. */
  annual: z.object({
    offers: z.array(z.object({ segment: z.enum(SEGMENTS), accepted: count, declined: count, unresolved: count })).max(SEGMENTS.length),
    changes: z.array(change).max(SEGMENTS.length),
    limitation: text,
  }).optional(),
  provenance: z.record(z.string(), z.object({ source: z.enum(["estimated", "assumption", "observed"]), note: text, evidenceCount: exposure.optional() })),
});
export type ObservedSnapshot = z.infer<typeof ObservedSnapshotSchema>;
export type AnnualEvidence = NonNullable<ObservedSnapshot["annual"]>;
export type ObservedComparison = ComparisonResult & { observedSnapshot: ObservedSnapshot };

/** Safe bounded-size aggregate for the exact twin used by one comparison/run. No per-episode or per-offer rows, and no links. */
export function toObservedSnapshot(view: { twin: MerchantTwin; evidence: DiscountEvidence; changes: ParameterChange[]; annual?: AnnualEvidence }): ObservedSnapshot {
  return ObservedSnapshotSchema.parse({ evidence: view.evidence, changes: view.changes, ...(view.annual ? { annual: view.annual } : {}), provenance: view.twin.provenance });
}
```

Replace `src/merchant/observed.ts`:

```ts
import "server-only";
import { currentMerchant } from ".";
import { readDiscountOutcomes, OUTCOME_LIMITATION } from "@/ledger/discount-outcomes";
import { ANNUAL_OFFER_LIMITATION, readAnnualOfferEvidence } from "@/ledger/annual-offers";
import type { LedgerConnection } from "@/ledger/connection";
import { updateAnnualUptake, updateDiscountEffect } from "@/twin/calibrate";

/** Request-owned copy calibrated once against the canonical baseline, never a mutable singleton. */
export async function observedMerchant(connection?: LedgerConnection, now?: string) {
  const canonical = structuredClone(currentMerchant());
  const evidence = await readDiscountOutcomes(connection, now);
  const discount = updateDiscountEffect(canonical.twin, evidence.observations);
  for (const change of discount.changes) discount.twin.provenance[change.parameter].note += ` ${OUTCOME_LIMITATION}`;
  const offers = await readAnnualOfferEvidence(connection, now);
  const learned = updateAnnualUptake(discount.twin, offers.offers.map(({ segment, accepted, declined }) => ({ segment, accepted, declined })));
  for (const change of learned.changes) learned.twin.provenance[change.parameter].note += ` ${ANNUAL_OFFER_LIMITATION}`;
  return { ...canonical, twin: learned.twin, changes: discount.changes, evidence, annual: { offers: offers.offers, changes: learned.changes, limitation: offers.limitation } };
}
```

In `src/merchant/demo.ts`, replace the `annualUptake` provenance line with:

```ts
    annualUptake: assume("Prior on annual-plan uptake when offered, per segment. Segments with resolved sandbox offers show their own observed row."),
```

`src/agent/run.ts`:
- import `type AnnualEvidence` from `@/merchant/observed-snapshot`;
- change `readMerchant` to `readMerchant?: () => Promise<{ twin: MerchantTwin; evidence?: DiscountEvidence; changes?: ParameterChange[]; annual?: AnnualEvidence }>;`;
- change the injected-twin view literal to `{ twin: options.toolOptions.twin, evidence: undefined, changes: undefined, annual: undefined }`;
- change the snapshot emission to `toObservedSnapshot({ twin: view.twin, evidence: view.evidence, changes: view.changes, annual: view.annual })`.

`src/app/api/twin/route.ts`: destructure `annual` and add it to the JSON body.

`src/app/page.tsx`: destructure `annual` from `observedMerchant()` and add `annualEvidence: annual,` to `summary`.

`src/components/Lab.tsx`:
- add `annualEvidence?: AnnualEvidence;` to `MerchantSummary`;
- extend the import to `import { ObservedSnapshotSchema, type AnnualEvidence, type ObservedComparison } from "@/merchant/observed-snapshot";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/merchant src/agent src/app src/components && npm run typecheck`

Expected: PASS. Existing snapshot fixtures without `annual` still parse.

- [ ] **Step 5: Commit**

```bash
git add src/merchant src/agent/run.ts src/app/api/twin/route.ts src/app/page.tsx src/components/Lab.tsx
git commit -m "feat(twin): learn annual uptake from resolved offers on the observed copy"
```

---

### Task 15: "Annual offers" evidence block

**Files:**
- Modify: `src/components/EvidencePanel.tsx`
- Test: `src/components/EvidencePanel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/components/EvidencePanel.test.ts`:

```ts
it("keeps annual offer evidence in its own block with its own limitation", () => {
  const annual = {
    offers: [{ segment: "core" as const, accepted: 1, declined: 0, unresolved: 1 }],
    changes: [{ parameter: "segments.core.annualUptake", before: { mean: .05, sd: .03 }, after: { mean: .0732, sd: .04 }, evidence: "1 accepted, 0 confirmed declined (1 resolved annual offer(s))" }],
    limitation: "Customers chose whether to switch, so this is not a randomized uptake estimate.",
  };
  const snapshot: ObservedSnapshot = { ...initialSnapshot, annual };
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot }));
  expect(html).toContain("Annual offers");
  expect(html).toContain("1 accepted · 0 declined · 1 awaiting decision or final check");
  expect(html).toContain("core: 1 accepted");
  expect(html.indexOf("segments.core.annualUptake")).toBeGreaterThan(html.indexOf("Annual offers"));
  expect(html).toContain("not a randomized uptake estimate");
  expect(html).toContain("No measured effect parameter changes");
  const withoutAnnual = renderToStaticMarkup(createElement(EvidencePanel, { summary, evidence: null, source: "manual", snapshot: initialSnapshot }));
  expect(withoutAnnual).not.toContain("Annual offers");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/EvidencePanel.test.ts`

Expected: FAIL. There is no "Annual offers" block.

- [ ] **Step 3: Implement** (`src/components/EvidencePanel.tsx`)

Change the import to `import type { AnnualEvidence, ObservedSnapshot } from "@/merchant/observed-snapshot";`. After `const changes = ...`, add:

```ts
  const annual = snapshot ? snapshot.annual : source ? undefined : summary.annualEvidence;
```

Insert `{annual && <AnnualOfferEvidence annual={annual} segments={summary.segments} />}` directly after the closing `</div>}` of the "Measured sandbox outcomes" block. Then add to the end of the file:

```tsx
function AnnualOfferEvidence({ annual, segments }: { annual: AnnualEvidence; segments: MerchantSummary["segments"] }) {
  const label = (id: string) => segments.find((segment) => segment.id === id)?.label ?? id.replaceAll("_", " ");
  const total = (key: "accepted" | "declined" | "unresolved") => annual.offers.reduce((sum, offer) => sum + offer[key], 0);
  return (
    <div className="mt-3 rounded-lg border border-border bg-background p-4 text-sm">
      <h4 className="font-medium">Annual offers</h4>
      <p className="mt-1">{total("accepted")} accepted · {total("declined")} declined · {total("unresolved")} awaiting decision or final check</p>
      {annual.offers.length > 0 && <ul className="mt-2 space-y-1">{annual.offers.map((offer) => (
        <li key={offer.segment}>{label(offer.segment)}: {offer.accepted} accepted · {offer.declined} declined · {offer.unresolved} awaiting decision or final check</li>
      ))}</ul>}
      {annual.changes.length
        ? <ul className="mt-2 space-y-1">{annual.changes.map((change) => <li key={change.parameter}>{change.parameter}: mean {change.before.mean.toFixed(4)} → {change.after.mean.toFixed(4)} · {change.evidence}</li>)}</ul>
        : <p className="mt-1">No uptake estimate has changed: only switched or confirmed-declined offers update it.</p>}
      <p className="mt-2 text-muted">{annual.limitation}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/EvidencePanel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EvidencePanel.tsx src/components/EvidencePanel.test.ts
git commit -m "feat(ui): show annual offer evidence in its own block"
```

---

### Task 16: Headline rules and "Also executable within your rules"

**Files:**
- Modify: `src/components/headline.ts`, `src/components/DecisionSummary.tsx`, `src/components/Lab.tsx` (one prop)
- Test: `src/components/headline.test.ts`, `src/components/DecisionSummary.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/components/headline.test.ts`, replace the first test and the last two tests with:

```ts
  it("headlines the annual plan by default, lists the save offer as also executable and the price rise as the bigger lever", () => {
    const c = comparison(result("rise", priceRise, 61_792, .003), result("annual", annual, 10_268, 0, 8_866), result("save", saveOffer, 147, .385, 570), result("broad", { ...saveOffer, segment: "at_risk", reason: "any" }, -1_283, .738, 4_100));
    const headline = chooseHeadline(c);
    expect(headline).toMatchObject({ selectedId: "annual", recommended: true });
    expect(headline.biggerLevers.map((r) => r.strategy.id)).toEqual(["rise"]);
    expect(headline.alsoExecutable.map((r) => r.strategy.id)).toEqual(["save"]);
  });

  it("applies the discount budget to retention discounts only, and the chance-worse rule to every strategy", () => {
    const c = comparison(result("annual", annual, 500, .1, 9_000), result("risky-annual", annual, 900, .9), result("costly-save", saveOffer, 400, .1, 5_000), result("save", saveOffer, 100, .1, 200));
    const headline = chooseHeadline(c);
    expect(headline.selectedId).toBe("annual");
    expect(headline.alsoExecutable.map((r) => r.strategy.id)).toEqual(["save"]);
  });

  it("falls back to the highest simulated value without recommending it when nothing executable qualifies", () => {
    const headline = chooseHeadline(comparison(result("rise", priceRise, 61_792, .003), result("broad", saveOffer, -1_283, .738)));
    expect(headline).toEqual({ selectedId: "rise", recommended: false, biggerLevers: [], alsoExecutable: [] });
  });

  it("explains why the list price change is not executable and treats annual plans as executable", () => {
    expect(whyNotExecutable(priceRise)).toMatch(/every subscriber.*assumption/);
    expect(whyNotExecutable(annual)).toBeNull();
    expect(whyNotExecutable(saveOffer)).toBeNull();
    expect(isExecutableIntervention(annual)).toBe(true);
    expect(isExecutableIntervention(priceRise)).toBe(false);
  });
```

Add `isExecutableIntervention` to the import from `./headline`.

In `src/components/DecisionSummary.test.ts`:
- in "keeps simulate-only and adverse stress tied to the displayed strategy", change `STARTER_STRATEGIES[2]` (annual) to `STARTER_STRATEGIES[3]` (the list price cut);
- append:

```ts
it("presents a recommended annual offer as executable with consent and renewal timing, plus other executable options", () => {
  const annual = { ...selected, strategy: STARTER_STRATEGIES[2] };
  const save = { ...selected, strategy: { ...selected.strategy, id: "save", name: "Price-driven cancel save" }, vsBaseline: { ...selected.vsBaseline, totalValue: { ...selected.vsBaseline.totalValue, p50: 147 } } };
  const html = render({ ...baseProps, selected: annual, recommended: true, alsoExecutable: [save] });
  expect(html).toContain("Recommended now");
  expect(html).not.toContain("Simulate only");
  expect(html).toContain("each customer must agree in PayPal");
  expect(html).toContain("next renewal date");
  expect(html).toContain("Also executable within your rules");
  expect(html).toContain("Price-driven cancel save");
  expect(html).toContain("+$147 median");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/headline.test.ts src/components/DecisionSummary.test.ts`

Expected: FAIL. There is no `alsoExecutable`, and annual is still simulate-only.

- [ ] **Step 3: Implement**

Replace the rules section of `src/components/headline.ts` (from the `isExecutable` comment through `chooseHeadline`) and `whyNotExecutable` with:

```ts
/** Keep in step with the executable proposal kinds in `proposeStrategy` (src/execution/annual-proposal.ts). */
export const isExecutableIntervention = (intervention: Intervention) => intervention.kind === "targeted_discount" || intervention.kind === "annual_plan";
export const isExecutable = (r: StrategyResult) => isExecutableIntervention(r.strategy.intervention);

/** The discount budget governs retention discounts only; an annual prepay discount is netted in total value. */
const withinRules = (r: StrategyResult, rules: DecisionRules) =>
  r.probValueBelowBaseline <= rules.maxProbWorse &&
  (r.strategy.intervention.kind !== "targeted_discount" || r.metrics.discountCost.mean <= rules.discountBudget);

export interface Headline {
  selectedId: string | null;
  /** False when no executable strategy meets the rules; the selection is then context only. */
  recommended: boolean;
  /** Simulate-only strategies with a higher median value than the recommendation. */
  biggerLevers: StrategyResult[];
  /** Other executable strategies that also meet the rules, best first. */
  alsoExecutable: StrategyResult[];
}

export function chooseHeadline(comparison: ComparisonResult, rules: DecisionRules = DEFAULT_DECISION_RULES): Headline {
  const ranked = comparison.strategies
    .filter((s) => s.strategy.id !== comparison.baselineId)
    .sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);
  const qualifies = (s: StrategyResult) => isExecutable(s) && withinRules(s, rules);
  const pick = ranked.find(qualifies);
  if (!pick) return { selectedId: ranked[0]?.strategy.id ?? null, recommended: false, biggerLevers: [], alsoExecutable: [] };
  return {
    selectedId: pick.strategy.id,
    recommended: true,
    biggerLevers: ranked.filter((s) => !isExecutable(s) && s.vsBaseline.totalValue.p50 > pick.vsBaseline.totalValue.p50),
    alsoExecutable: ranked.filter((s) => s !== pick && qualifies(s)),
  };
}

export function whyNotExecutable(intervention: Intervention): string | null {
  switch (intervention.kind) {
    case "list_price_change":
      return "It changes the price for every subscriber at once, and how customers react to price is an assumption with no observed evidence. Test it on a small group before rolling it out.";
    case "annual_plan":
    case "baseline":
    case "targeted_discount":
      return null;
  }
}
```

In `src/components/DecisionSummary.tsx`:
- import `isExecutableIntervention` alongside `whyNotExecutable`;
- add `alsoExecutable?: StrategyResult[];` to `Props` and `alsoExecutable = []` to the destructuring;
- replace `{selected.strategy.intervention.kind !== "targeted_discount" && <p ...>Simulate only: ...</p>}` with:

```tsx
      {!isExecutableIntervention(selected.strategy.intervention) && <p className="mt-3 text-sm text-muted">Simulate only: {whyNotExecutable(selected.strategy.intervention) ?? "this strategy has no executable PayPal action in this build."}</p>}
      {selected.strategy.intervention.kind === "annual_plan" && <p className="mt-3 text-sm text-muted">Executable as an offer: each customer must agree in PayPal, and the yearly price is charged from their next renewal date. The prepay discount is netted in value and does not count against the retention discount budget.</p>}
      {recommended && alsoExecutable.length > 0 && (
        <div className="mt-5 rounded-lg border border-border bg-background px-4 py-3 text-sm">
          <p className="font-semibold">Also executable within your rules</p>
          <ul className="mt-2 space-y-2">
            {alsoExecutable.map((option) => (
              <li key={option.strategy.id}>
                <button type="button" disabled={busy || !onSelect} onClick={() => onSelect?.(option.strategy.id)} className="font-medium text-brand-accent underline-offset-2 hover:underline disabled:no-underline">
                  {option.strategy.name}
                </button>{" "}
                <span className="tabular-nums">{signedMoney(option.vsBaseline.totalValue.p50)} median</span>
              </li>
            ))}
          </ul>
        </div>
      )}
```

In `src/components/Lab.tsx`, add `alsoExecutable={isHeadlinePick ? headline.alsoExecutable : []}` to the `<DecisionSummary ... />` props.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/headline.ts src/components/headline.test.ts src/components/DecisionSummary.tsx src/components/DecisionSummary.test.ts src/components/Lab.tsx
git commit -m "feat(ui): headline executable annual offers and list other qualifying actions"
```

---

### Task 17: Annual offer approval card, window input and execution report

**Files:**
- Create: `src/components/AnnualOfferCard.tsx`, `src/components/AnnualOfferCard.test.ts`, `src/components/annual-offers-view.ts`
- Modify: `src/components/Lab.tsx`

- [ ] **Step 1: Write the failing test** `src/components/AnnualOfferCard.test.ts`

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";
import { AnnualOfferCard } from "./AnnualOfferCard";
import { formatUtc } from "./annual-offers-view";

const action = buildAnnualOfferAction({ strategy: STARTER_STRATEGIES[2], listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: "P-MONTHLY000000000000000001",
  offerWindowDays: 7, eligible: [{ subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: "2026-10-22T00:00:00.000Z" }] });
const proposal = { id: "prop_annual", status: "proposed", actionHash: "c".repeat(64), action, prediction: null } as unknown as Proposal;
const render = (canReview: boolean, status = "proposed") => renderToStaticMarkup(createElement(AnnualOfferCard, {
  proposal: { ...proposal, status } as Proposal, action, confirmed: false, setConfirmed: vi.fn(), busy: false, canReview, paypalConfigured: true, onApprove: vi.fn(), onReject: vi.fn() }));

it("shows the exact yearly offer, consent statements, hash and an unchecked confirmation", () => {
  const html = render(true);
  for (const text of ["$244.80/yr", "15% off $24.00/mo", "PROD-RIDGELINE0000000001", "7 day(s)", "Pilot E I-PILOTE", "c".repeat(64),
    "Each customer must agree in PayPal", "next renewal date", "can&#x27;t be moved back automatically", "Approve &amp; issue offers"]) expect(html).toContain(text);
  expect(html).not.toContain('checked=""');
});

it("disables approval without administrator access and hides it once decided", () => {
  expect(render(false)).toMatch(/disabled=""[^>]*>Approve &amp; issue offers/);
  expect(render(true, "succeeded")).not.toContain("Approve &amp; issue offers");
});

it("formats instants in UTC without seconds", () => {
  expect(formatUtc("2026-11-08T00:00:00.000Z")).toBe("2026-11-08 00:00 UTC");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/AnnualOfferCard.test.ts`

Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement**

Create `src/components/annual-offers-view.ts`:

```ts
/** Compact UTC display for stored ISO instants. */
export const formatUtc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
```

Create `src/components/AnnualOfferCard.tsx`:

```tsx
import type { AnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";

const money = (v: number) => `$${Math.round(v).toLocaleString()}`;

export function AnnualOfferCard({ proposal, action, confirmed, setConfirmed, busy, canReview, paypalConfigured, onApprove, onReject }: {
  proposal: Proposal; action: AnnualOfferAction; confirmed: boolean; setConfirmed: (value: boolean) => void; busy: boolean;
  canReview: boolean; paypalConfigured: boolean; onApprove: () => void; onReject: () => void;
}) {
  const d = proposal.prediction?.vsBaseline.totalValue;
  return (
    <div>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Yearly price" value={`$${action.annualPrice}/yr (${action.discountPct}% off $${action.listPrice}/mo × 12)`} />
        <Row label="Product and currency" value={`${action.productId} · ${action.currency}`} mono />
        <Row label="Switch" value={`From monthly plan ${action.monthlyPlanId} to a new yearly plan created on approval`} />
        <Row label="Offer window" value={`${action.offerWindowDays} day(s) from when each offer is issued`} />
        <Row label="Targets" value={action.targets.map((t) => `${t.registration.label} ${t.subscriptionId} (${t.registration.segment.replaceAll("_", " ")})`).join(", ")} />
        {d && <Row label="Simulated Δ value (median, 80% interval)" value={`${money(d.p50)} (${money(d.p10)} … ${money(d.p90)})`} />}
        <Row label="Status" value={proposal.status} />
        <Row label="Payload hash" value={proposal.actionHash} mono />
      </dl>
      <details className="mb-4 rounded-lg border border-border bg-background px-4 py-3 text-sm">
        <summary className="font-medium text-brand-accent">PayPal operation details</summary>
        <p className="mt-2 break-all font-mono text-xs">POST /v1/billing/plans (yearly; request ID from the payload hash) · POST /v1/billing/subscriptions/&#123;id&#125;/revise, once per subscriber</p>
      </details>
      <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-muted">
        <li>Each customer must agree in PayPal. Nothing changes for a customer who does not approve.</li>
        <li>The yearly price is charged from each subscriber&apos;s next renewal date, not today.</li>
        <li>Switched customers can&apos;t be moved back automatically.</li>
        <li>Offers cannot be withdrawn; each closes when its window ends.</li>
      </ul>
      {proposal.status === "proposed" && (
        <>
          <label className="mb-3 flex min-h-10 items-center gap-3 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(e) => setConfirmed(e.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
            I approve offering these {action.targets.length} PayPal Sandbox subscriber(s) a switch to the yearly plan.
          </label>
          <div className="flex flex-wrap gap-3">
            <button onClick={onApprove} disabled={!confirmed || busy || !paypalConfigured || !canReview} className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50">
              {busy ? "Working…" : "Approve & issue offers"}
            </button>
            <button onClick={onReject} disabled={busy || !canReview} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:bg-background disabled:opacity-50">Reject</button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>{value}</dd>
    </div>
  );
}
```

Make these edits in `src/components/Lab.tsx`:
1. Change the headline import to `import { chooseHeadline, isExecutableIntervention } from "./headline";`. Add `import { AnnualOfferCard } from "./AnnualOfferCard";` and `import { formatUtc } from "./annual-offers-view";`.
2. Add state `const [offerWindowDays, setOfferWindowDays] = useState(7);`.
3. In `propose`, change the body to `JSON.stringify({ objective, strategy: selected.strategy, ...(selected.strategy.intervention.kind === "annual_plan" ? { offerWindowDays } : {}) })`.
4. Replace `const executable = selected?.strategy.intervention.kind === "targeted_discount";` with `const executable = !!selected && isExecutableIntervention(selected.strategy.intervention);`.
5. In the `!proposal` branch, insert before the "Prepare PayPal action" button:

```tsx
              {selected.strategy.intervention.kind === "annual_plan" && (
                <label className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                  Offer window (days, 1–30)
                  <input type="number" min={1} max={30} step={1} value={offerWindowDays} disabled={busy !== null}
                    onChange={(e) => setOfferWindowDays(Math.min(30, Math.max(1, Math.round(Number(e.target.value) || 1))))}
                    className="min-h-10 w-20 rounded-lg border border-border bg-background px-3" />
                  <span className="text-muted">Bound into the approved payload. Each customer decides in PayPal within this window.</span>
                </label>
              )}
```

6. At the top of `ProposalCard`, before `if (a.type !== "subscription_price_override" ...)`, add:

```tsx
  if (a.type === "annual_plan_offer") return <AnnualOfferCard proposal={proposal} action={a} confirmed={confirmed} setConfirmed={setConfirmed} busy={busy} canReview={canReview} paypalConfigured={!!paypal?.configured} onApprove={onApprove} onReject={onReject} />;
```

7. In the execution report rows, replace the price, status and verified cells with:

```tsx
                  <td>{o.offer ? "—" : o.observed?.regularPrice ? `$${o.observed.regularPrice}` : "—"}</td>
                  <td>{o.offer ? `Offer issued · window closes ${formatUtc(o.offer.expiresAt)}` : o.error ?? o.observed?.status}</td>
                  <td className={o.offer ? "text-muted" : o.verified ? "text-positive" : "text-negative"}>{o.offer ? "customer decides" : o.verified ? "yes" : "no"}</td>
```

Showing `o.error` before `o.observed?.status` makes ineligible annual targets show their reason. For discount targets, `error` is null on success, so the status still shows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnnualOfferCard.tsx src/components/AnnualOfferCard.test.ts src/components/annual-offers-view.ts src/components/Lab.tsx
git commit -m "feat(ui): review and approve exact annual offers"
```

---

### Task 18: "Annual offers" panel and yearly pilots in the cohort table

**Files:**
- Create: `src/components/AnnualOffersPanel.tsx`, `src/components/annual-offers-view.test.ts`
- Modify: `src/components/annual-offers-view.ts`, `src/components/Lab.tsx`

- [ ] **Step 1: Write the failing test** `src/components/annual-offers-view.test.ts`

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import { AnnualOffersPanel } from "./AnnualOffersPanel";
import { offerCounts, offerStatusLabel } from "./annual-offers-view";

const base: AnnualOfferView = { id: 1, proposalId: "prop_x", subscriptionId: "I-PILOTD", segment: "core", annualPlanId: "P-ANNUAL", offeredAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z", status: "pending", outcome: "unresolved", resolvedAt: null, needsRead: true };
const switched: AnnualOfferView = { ...base, id: 2, subscriptionId: "I-PILOTE", status: "switched", outcome: "accepted", resolvedAt: "2026-11-01T00:10:00.000Z", needsRead: false };

it.each([
  [base, "Pending customer decision"],
  [switched, "Switched (verified by PayPal)"],
  [{ ...base, status: "expired", outcome: "unresolved" }, "Offer window closed · awaiting final check"],
  [{ ...base, status: "expired", outcome: "declined" }, "Offer window closed · declined"],
  [{ ...base, status: "invalid" }, "Needs administrator check (invalid deadline)"],
] as const)("labels %j honestly and never calls a link dead", (offer, label) => {
  expect(offerStatusLabel(offer)).toBe(label);
  expect(label).not.toMatch(/dead|expired link/i);
});

it("counts accepted, declined and awaiting offers", () => {
  expect(offerCounts([base, switched, { ...base, outcome: "declined" }])).toEqual({ accepted: 1, declined: 1, awaiting: 1 });
});

it("shows every visitor per-target status and window without any link", () => {
  const html = renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [base, switched], labels: { "I-PILOTD": "Pilot D", "I-PILOTE": "Pilot E" }, canReview: false }));
  expect(html).toContain("Annual offers");
  expect(html).toContain("Pilot E");
  expect(html).toContain("Switched (verified by PayPal)");
  expect(html).toContain("Pending customer decision");
  expect(html).toContain("2026-11-08 00:00 UTC");
  expect(html).toContain("1 accepted · 0 declined · 1 awaiting decision or final check");
  expect(html).not.toMatch(/ba_token|paypal\.com|Copy message/);
  expect(renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [], labels: {}, canReview: true }))).toBe("");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/annual-offers-view.test.ts`

Expected: FAIL. `offerStatusLabel` and the panel do not exist.

- [ ] **Step 3: Implement**

Append to `src/components/annual-offers-view.ts`:

```ts
import type { AnnualOfferView } from "@/ledger/annual-offer-status";

/** "Offer window closed", never "link dead": a link's real lifetime is untested (decision 0008). */
export function offerStatusLabel(offer: Pick<AnnualOfferView, "status" | "outcome">): string {
  if (offer.status === "switched") return "Switched (verified by PayPal)";
  if (offer.status === "pending") return "Pending customer decision";
  if (offer.status === "invalid") return "Needs administrator check (invalid deadline)";
  return offer.outcome === "declined" ? "Offer window closed · declined" : "Offer window closed · awaiting final check";
}

export function offerCounts(offers: Pick<AnnualOfferView, "outcome">[]) {
  return {
    accepted: offers.filter((o) => o.outcome === "accepted").length,
    declined: offers.filter((o) => o.outcome === "declined").length,
    awaiting: offers.filter((o) => o.outcome === "unresolved").length,
  };
}
```

Move the new `import type` line to the top of the file.

Create `src/components/AnnualOffersPanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import { formatUtc, offerCounts, offerStatusLabel } from "./annual-offers-view";

type Draft = { id: number; subscriptionId: string; label: string | null; expiresAt: string; message: string };

/** Everyone sees per-target status; administrators also get display-only drafts with the secret link, fetched on demand. */
export function AnnualOffersPanel({ offers, labels, canReview }: { offers: AnnualOfferView[]; labels: Record<string, string>; canReview: boolean }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const pendingKey = offers.filter((offer) => offer.status === "pending").map((offer) => offer.id).join(",");
  useEffect(() => {
    if (!canReview || !pendingKey) return;
    let cancelled = false;
    fetch("/api/annual-offers/links", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("unavailable"); return (await response.json()) as { offers: Draft[] }; })
      .then((body) => { if (!cancelled) { setDrafts(body.offers); setError(null); } })
      .catch(() => { if (!cancelled) setError("Customer messages are unavailable."); });
    return () => { cancelled = true; };
  }, [canReview, pendingKey]);
  if (!offers.length) return null;
  const visibleDrafts = canReview && pendingKey ? drafts ?? [] : [];
  const counts = offerCounts(offers);
  const copy = async (draft: Draft) => {
    try { await navigator.clipboard.writeText(draft.message); setCopied(draft.id); } catch { setError("Copy failed; select the message text instead."); }
  };
  return (
    <section className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="annual-offers-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="annual-offers-title" className="text-lg font-semibold">Annual offers</h2>
        <span className="source-badge text-observed">Status from PayPal Sandbox read-back</span>
      </div>
      <p className="mb-3 text-sm">{counts.accepted} accepted · {counts.declined} declined · {counts.awaiting} awaiting decision or final check</p>
      <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-muted"><tr><th className="py-1">Subscriber</th><th>Segment</th><th>Status</th><th>Window closes</th></tr></thead>
        <tbody>{offers.map((offer) => (
          <tr key={offer.id} className="border-t border-border">
            <td className="py-2">{labels[offer.subscriptionId] ?? offer.subscriptionId}</td>
            <td>{offer.segment.replaceAll("_", " ")}</td>
            <td>{offerStatusLabel(offer)}</td>
            <td>{formatUtc(offer.expiresAt)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="mt-2 text-xs text-muted">Refresh from PayPal to record each customer&apos;s decision. A switch takes effect at the subscriber&apos;s next renewal date.</p>
      {visibleDrafts.length > 0 && <div className="mt-4 border-t border-border pt-4">
        <h3 className="font-medium">Draft customer messages (administrators only)</h3>
        <p className="mt-1 text-sm text-muted">Display only: Aurrery does not send these. Each contains that subscriber&apos;s private PayPal approval link.</p>
        <ul className="mt-2 space-y-3">{visibleDrafts.map((draft) => (
          <li key={draft.id} className="text-sm">
            <p className="font-medium">{draft.label ?? draft.subscriptionId}</p>
            <textarea readOnly value={draft.message} rows={6} className="mt-1 w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" />
            <button type="button" onClick={() => void copy(draft)} className="mt-1 min-h-10 rounded-lg border border-border px-3 hover:bg-background">{copied === draft.id ? "Copied" : "Copy message"}</button>
          </li>
        ))}</ul>
      </div>}
      {error && canReview && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
    </section>
  );
}
```

Make these edits in `src/components/Lab.tsx`:
1. Add `import { AnnualOffersPanel } from "./AnnualOffersPanel";` and `import type { AnnualOfferView } from "@/ledger/annual-offer-status";`.
2. In `PayPalStatus`, add `annualOffers?: AnnualOfferView[];` and add `annualPlan?: boolean` inside `live`.
3. Insert directly before `<RecoveryPanel ... />`:

```tsx
      <AnnualOffersPanel offers={paypal?.annualOffers ?? []} labels={Object.fromEntries(paypal?.subscriptions.map((s) => [s.subscriptionId, s.label]) ?? [])} canReview={canReviewAccess(access)} />
```

4. Replace the price cell in the pilot table with:

```tsx
                  <td>{s.live ? (s.live.regularPrice ? `$${s.live.regularPrice}${s.live.annualPlan ? "/yr" : "/mo"}${s.live.planOverridden ? " (override)" : ""}` : `$${summary.listPrice.toFixed(2)}/mo (plan)`) : "—"}</td>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components && npm run typecheck && npm run lint`

Expected: PASS. The setState calls happen only in async callbacks, which satisfies `react-hooks`.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnnualOffersPanel.tsx src/components/annual-offers-view.ts src/components/annual-offers-view.test.ts src/components/Lab.tsx
git commit -m "feat(ui): track annual offers and show yearly pilots"
```

---

### Task 19: The agent may propose an annual offer

**Files:**
- Modify: `src/agent/tools.ts`, `src/agent/run.ts`
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/agent/tools.test.ts`:
- add the imports `import type { CreateProposalInput, Proposal } from "@/ledger/proposals";` and `import { AGENT_INSTRUCTION } from "./run";`;
- replace the test "returns NOT_EXECUTABLE for an annual comparison" with:

```ts
  it("proposes an annual-plan offer through the shared preparation path, applying the risk rule but not the discount budget", async () => {
    const annual: Strategy = { id: "annual", name: "Annual", intervention: { kind: "annual_plan", discountPct: 10, segments: ["core"] } };
    const propose = vi.fn<(input: CreateProposalInput) => Promise<Proposal>>(async () => ({ id: "prop_annual", status: "proposed", action: { type: "annual_plan_offer", targets: [{ subscriptionId: "I-PILOT3" }] } }) as unknown as Proposal);
    const ctx = await setup({ propose }); await ready(ctx, annual);
    await ctx.dispatch("set_decision_rules", { ...rules, discountBudget: 0 });
    await ctx.dispatch("simulate_strategies", { strategies: [annual] });
    await ctx.dispatch("stress_test", { strategyId: "annual" });
    expect(await recommend(ctx, "annual")).toMatchObject({ ok: true, data: { id: "prop_annual", status: "proposed", targetCount: 1 } });
    expect(propose).toHaveBeenCalledOnce();
    expect(propose.mock.calls[0][0]).toMatchObject({ strategy: { id: "annual" }, listPrice: 24 });
    expect(propose.mock.calls[0][0]).not.toHaveProperty("eligibleTargetIds");
  });
  it("still refuses a list price change and the chance-worse rule for annual offers", async () => {
    const rise: Strategy = { id: "rise", name: "Rise", intervention: { kind: "list_price_change", newPrice: 27 } };
    const ctx = await setup(); await ready(ctx, rise);
    await ctx.dispatch("stress_test", { strategyId: "rise" });
    expect(await recommend(ctx, "rise")).toMatchObject({ ok: false, code: "NOT_EXECUTABLE" });
    const annual: Strategy = { id: "annual", name: "Annual", intervention: { kind: "annual_plan", discountPct: 10, segments: ["core"] } };
    const risky = await setup({ simulate: (twin, candidates, options) => {
      const comparison = compareStrategies(twin, candidates, { ...options, runs: 10 });
      for (const s of comparison.strategies) s.probValueBelowBaseline = .9;
      return comparison;
    } });
    await ready(risky, annual);
    await risky.dispatch("set_decision_rules", { ...rules, maxProbWorse: .5 });
    await risky.dispatch("simulate_strategies", { strategies: [annual] });
    await risky.dispatch("stress_test", { strategyId: "annual" });
    expect(await recommend(risky, "annual")).toMatchObject({ ok: false, code: "RULE_VIOLATION" });
  });
  it("tells the agent annual offers are executable and need each customer's consent", () => {
    expect(AGENT_INSTRUCTION).not.toMatch(/simulation only/i);
    expect(AGENT_INSTRUCTION).toMatch(/annual.*approve.*PayPal/i);
  });
```

The demo twin's listPrice is 24. The injected `simulate` forces a 90% chance worse, so the risk rule is tested deterministically. `compareStrategies` is already imported in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agent/tools.test.ts`

Expected: FAIL. Annual returns `NOT_EXECUTABLE`, and the instruction still says "simulation only".

- [ ] **Step 3: Implement**

In `src/agent/tools.ts`:
- replace `createProposal` in the `@/ledger/proposals` import with nothing (keep `listSandboxSubscribers, ProposalError, type CreateProposalInput, type Proposal, type SandboxSubscriber`);
- add `import { proposeStrategy } from "@/execution/annual-proposal";`;
- change the `recommend` description to `"Create one proposed action (a retention discount or an annual-plan offer) from a classified, simulated and stressed candidate within the rules. Merchant approval is separate."`;
- in `case "recommend"`, replace the lines from the `NOT_EXECUTABLE` check through the `propose` call with:

```ts
        const kind = result.strategy.intervention.kind;
        if (kind !== "targeted_discount" && kind !== "annual_plan") throw new ToolFailure("NOT_EXECUTABLE", "Only retention discounts and annual-plan offers are executable in this build.");
        // The discount budget governs retention discounts only; an annual prepay discount is netted in total value.
        if ((kind === "targeted_discount" && result.metrics.discountCost.mean > state.rules.discountBudget) || result.probValueBelowBaseline > state.rules.maxProbWorse)
          throw new ToolFailure("RULE_VIOLATION", "The base simulation exceeds the decision rules.");
        const eligibleTargetIds = kind === "targeted_discount" ? pilotEligibility(feedbackCorpus, accepted, await registry(), labels).eligibleSubscriptionIds : undefined;
        checkAbort();
        const proposal = await (options.propose ?? proposeStrategy)({ objective, strategy: result.strategy, result, listPrice: state.twin.params.listPrice, ...(eligibleTargetIds ? { eligibleTargetIds } : {}) });
```

In `src/agent/run.ts`:
- replace `Annual plans are simulation only until a later milestone.` in `AGENT_INSTRUCTION` with `An annual prepay recommendation becomes an offer that each subscriber must approve in PayPal; the discount budget applies to retention discounts only, while the chance-worse rule applies to every recommendation.`;
- in the tool wiring, replace `(options.toolOptions?.propose ?? createProposal)(input)` with `(options.toolOptions?.propose ?? proposeStrategy)(input)`;
- change `import { createProposal, type Proposal } from "@/ledger/proposals";` to `import type { Proposal } from "@/ledger/proposals";` and add `import { proposeStrategy } from "@/execution/annual-proposal";`.

The agent still has no approve or execute tool. `TOOL_DEFINITIONS` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/agent src/merchant`

Expected: PASS. The recorded Groq and Gemini replays recommend the cancel save, which still passes the budget rule.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts src/agent/run.ts
git commit -m "feat(agent): let the agent propose annual-plan offers"
```

---

### Task 20: Pilot E in the cohort

Pilot E is a second core pilot. Annual strategies target every eligible pilot in their segments, so D and E both receive offers, and only E is approved in the demo. Pilots A–D are unchanged.

**Files:**
- Modify: `src/paypal/pilot-cohort.ts`, `src/paypal/setup.test.ts`, `src/execution/reset.test.ts`, `src/agent/replay.test.ts`, `src/agent/gemini-integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/paypal/setup.test.ts`:

```ts
it("keeps Pilots A–D unchanged and adds Pilot E as a core, other-reason pilot", () => {
  expect(PILOT_COHORT.map((p) => p.label.slice(0, 7))).toEqual(["Pilot A", "Pilot B", "Pilot C", "Pilot D", "Pilot E"]);
  expect(PILOT_COHORT[3]).toEqual({ label: "Pilot D: loyal, 14 months", segment: "core", reason: "other" });
  expect(PILOT_COHORT[4]).toEqual({ label: "Pilot E: loyal, 9 months", segment: "core", reason: "other" });
});

it("creates only Pilot E when Pilots A–D are already registered and healthy", async () => {
  for (const [i, member] of PILOT_COHORT.slice(0, 4).entries()) await registerSandboxSubscriber({ ...member, subscriptionId: `I-OLD${i}` });
  transport.read.mockImplementation(async (id: string) => snapshot(id, id.startsWith("I-OLD") ? "ACTIVE" : "APPROVAL_PENDING"));
  const messages = await setupPilots(options);
  expect(transport.create).toHaveBeenCalledExactlyOnceWith({ paypalRequestId: "aurrery-ridgeline-sub-4-v1", prefer: "return=representation",
    body: { planId: options.planId, customId: "pilot-4", applicationContext: { brandName: "Ridgeline Roasters", returnUrl: options.returnUrl, cancelUrl: options.returnUrl } } });
  expect((await listSandboxSubscribers()).map((s) => s.label)).toEqual(PILOT_COHORT.map((p) => p.label));
  expect(messages[4]).toContain("APPROVAL_PENDING");
});
```

In the same file, make these changes:
- replace `expect(transport.read).toHaveBeenCalledTimes(4);` with `expect(transport.read).toHaveBeenCalledTimes(PILOT_COHORT.length);`;
- replace each `expect(await listSandboxSubscribers()).toHaveLength(4);` with `expect(await listSandboxSubscribers()).toHaveLength(PILOT_COHORT.length);`.

In `src/execution/reset.test.ts`, in "previews only currently registered pilots...", replace the last expected skip entry with both unregistered members:

```ts
    { subscriptionId: null, reason: "unregistered", label: PILOT_COHORT[3].label },
    { subscriptionId: null, reason: "unregistered", label: PILOT_COHORT[4].label },
```

In `src/agent/replay.test.ts` and `src/agent/gemini-integration.test.ts`, change `"ABCD"[index]` to `"ABCDE"[index]`, so Pilot E gets a valid `I-...E` ID.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/paypal/setup.test.ts`

Expected: FAIL. `PILOT_COHORT[4]` is undefined.

- [ ] **Step 3: Implement** (`src/paypal/pilot-cohort.ts`)

Append the fifth entry:

```ts
  { label: "Pilot E: loyal, 9 months", segment: "core", reason: "other" },
```

`setupPilots` already creates a missing member with request ID `aurrery-ridgeline-sub-4-v1` and `customId` `pilot-4`. Feedback pilot indices stay 0–3 (`src/signals/evidence.ts`), so classification and its recorded fixtures are unaffected.

- [ ] **Step 4: Run the full suite**

Run: `npm test -- --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paypal/pilot-cohort.ts src/paypal/setup.test.ts src/execution/reset.test.ts src/agent/replay.test.ts src/agent/gemini-integration.test.ts
git commit -m "feat(paypal): add Pilot E to the sandbox cohort"
```

---

### Task 21: Handoff documentation

**Files:**
- Modify: `docs/architecture.md`, `docs/runbooks/render-turso.md`, `docs/decisions/0008-annual-plan-offers.md`, `docs/current-state.md`

- [ ] **Step 1: Decision 0008: append "Phase 2 implementation decisions"**

Append a section listing the eight decisions from "Design decisions this plan locks in" above, one bullet each, worded as decided facts. Add the operator rule for an unresolved target:

> A `revise` result that is ambiguous, including HTTP 200 without a usable link, leaves the proposal `executing` with its claims. The target's execution record says "do not retry". See the runbook section "Annual offers: unresolved targets".

- [ ] **Step 2: Runbook: add the section "Annual offers: unresolved targets and links"** to `docs/runbooks/render-turso.md`

```markdown
## Annual offers: unresolved targets and links

- **Links are secrets.** A subscriber's approval link lives only in `annual_offers.approval_url`. Administrators read it through the signed-in "Annual offers" panel, which uses `GET /api/annual-offers/links` (never cached). Never paste links into logs, issues or chat; copy them only into the message for that customer. Private ledger backups contain links; keep them with the same care as the session fingerprints they already hold.
- **One `revise` per target.** PayPal mints a new approval token on every `revise` and invalidates the previous one, with no request ID. Aurrery never retries.
- **Unresolved target.** An execution record whose error says "do not retry revise" covers a server error, a network failure, a conflict or rate limit, HTTP 200 without a usable link, or a mismatched plan. The proposal stays `executing` and keeps its claims. Next steps:
  1. Do not run anything that calls `revise` for that subscription. Do not clear claims, force statuses or run reset as a shortcut.
  2. Read the subscription: use **Refresh from PayPal**, or `npm run paypal:sync` with the authoritative ledger selected privately. If it reads ACTIVE on the annual plan, the customer approved a link Aurrery stored earlier. Otherwise it is still monthly, and PayPal may hold an approval token Aurrery never received; that customer cannot be sent a link.
  3. Record the PayPal debug ID from the execution record. Raise it with PayPal Sandbox support if needed.
  4. Later targets in that proposal were not attempted. There is no tool to finish an `executing` proposal (true of every action type); until one exists, those pilots stay claimed.
- **Window closed.** After an offer's window, the panel says "offer window closed". A stale link may still work at PayPal. Status refreshes keep recording reads, and a later switch still counts as accepted.
- **Decline.** An offer counts as declined for learning only after its window plus six hours **and** a read at or after that point showing the subscription off the annual plan.
- **Reset and price changes.** These skip a subscriber on an annual plan ("switched to annual by customer choice; not reset"). A switched customer is never moved back automatically.
- **Schema.** The first runtime start of this release adds `annual_offers` and `annual_offer_reads` to the authoritative ledger (`CREATE TABLE IF NOT EXISTS`). Take any pre-release backup with the previous release's code: this release's export requires the new tables.
```

- [ ] **Step 3: Architecture**

In `docs/architecture.md`, replace the sentence "The current approval path executes today's price-override pilots; annual-plan execution remains required M7 work." with:

```markdown
Annual prepay is executable (M7, Approach A). An `annual_plan_offer` proposal follows the same approve → claim → execute path.
- `src/execution/annual-offer.ts` creates and verifies the yearly plan under a hash-derived request ID, re-checks live eligibility, and calls `revise` at most once per target.
- Each secret approval link is stored only in `annual_offers`.
- Every PayPal status read appends to `annual_offer_reads`. `src/ledger/annual-offer-status.ts` derives pending, switched, expired or invalid status and the learning outcome.
- `src/merchant/observed.ts` applies resolved offers to per-segment `annualUptake` on a request-owned copy. The evidence panel shows them in their own "Annual offers" block.
- The headline treats annual offers as executable; the discount budget applies to retention discounts only.
```

- [ ] **Step 4: Current state**

Replace the M7 Phase 2 task entries in `docs/current-state.md` with one consolidated section. It covers:
- what is done;
- the test count;
- the remaining human steps (Tasks 22 and 23);
- known limitations: there is no tool to finish an `executing` proposal; an approval token's real lifetime is untested; D's decline lands after the demo.

Update the top status line.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/runbooks/render-turso.md docs/decisions/0008-annual-plan-offers.md docs/current-state.md
git commit -m "docs(m7): record Phase 2 design, runbook and handoff"
```

---

### Task 22 (HUMAN CHECKPOINT, Jethro): back up, then create Pilot E with one buyer approval

This is the only task before acceptance that calls PayPal, and it is sandbox only. It needs private credentials and a sandbox personal-account approval, so an agent prepares the commands and Jethro runs them. Never paste credentials, tokens or approval links into chat, commits or docs.

- [ ] **Step 1: Private backup of the hosted ledger with the current release's code**

This release's export requires the new tables, and this task's setup run creates them. So take the backup from a `main` worktree first:

```bash
git worktree add ../aurrery-main-backup main
cd ../aurrery-main-backup && npm ci
# Private shell: LEDGER_BACKEND=turso, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN set; LEDGER_PATH unset.
npm run --silent ledger:export -- --output <absolute-private-path>/pre-m7-phase2.sqlite
cd - && git worktree remove ../aurrery-main-backup
```

Expected: a manifest with only counts and hashes. Keep it privately with the backup.

- [ ] **Step 2: Create Pilot E against the hosted ledger**

Run this from the `feat/m7-annual-plan` checkout, in the same private shell, plus `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and the hosted origin. Invoke `tsx` directly, so that `.env.local` (and its `LEDGER_PATH`) is not loaded:

```bash
APP_URL=https://aurrery.onrender.com npx tsx --conditions=react-server scripts/paypal-setup.ts setup
```

Expected:
- Pilots A–D print their current status with no POST;
- Pilot E prints `APPROVAL_PENDING` with an approval link, in the console only;
- the hosted ledger gains the two empty annual tables.

If any of A–D fails to read, stop: setup refuses to recreate a healthy pilot.

- [ ] **Step 3: Approve Pilot E as the sandbox personal account**

Open E's link in a private window and approve. PayPal can take about five minutes to show ACTIVE (decision 0008).

- [ ] **Step 4: Verify**

```bash
npx tsx --conditions=react-server scripts/paypal-setup.ts sync
```

Expected:
- E is `ACTIVE`, price `24.0`, `overridden false`;
- D is `ACTIVE`, price `24.0`, `overridden false`.

If D is not at list price on the monthly plan, it will not be offered. Note that in the acceptance record; do not reset D just to change the demo.

- [ ] **Step 5: Record**

Add the outcome to `docs/current-state.md`: E's subscription ID (an ID, not a link), D's state and the backup manifest's table count. Commit `docs: record Pilot E sandbox setup`.

---

### Task 23 (HUMAN-GATED): live acceptance

Nothing in this task is pushed, merged or deployed without Jethro's explicit approval in chat at the marked checkpoint.

- [ ] **Step 1: Local gates**

Run: `npm test -- --maxWorkers=2 && npm run typecheck && npm run lint && npm run build`

Expected: all pass. Record the test count.

- [ ] **Step 2: Final review**

Use superpowers:requesting-code-review on the whole branch diff against `main`. Fix findings in atomic commits and re-run Step 1.

- [ ] **Step 3: CHECKPOINT: ask Jethro to approve push, merge and deploy**

Report the test count and the review result. Ask, in one question, whether to push `feat/m7-annual-plan`, merge to `main` and manually deploy on Render. **Stop until he answers yes.** Then:
1. Push the branch and check `gh auth status`.
2. Watch CI (`gh run watch`) until it passes.
3. Merge as Jethro directs.
4. Trigger the manual Render deploy.
5. Wait for `/api/health`.

- [ ] **Step 4: Administrator approves the annual offer on the hosted demo**

On https://aurrery.onrender.com, sign in through **Administrator access**, then **Simulate strategies**.

Expected:
- the headline is "Annual prepay at 15% off", marked "Recommended now";
- "Also executable within your rules" lists the price-driven save offer;
- "Bigger simulated levers" lists the price rise.

Then:
1. In Approval, keep the offer window at 7 and choose **Prepare PayPal action**. The card shows `$244.80/yr`, Pilots D and E, the consent statements, the hash and an unchecked box.
2. Tick the box and choose **Approve & issue offers**.

Expected: the report shows two rows, each reading "Offer issued · window closes …" and "customer decides". The proposal is `succeeded`.

- [ ] **Step 5: The sandbox customer approves E soon after issue**

In the "Annual offers" panel (signed in):
1. Copy Pilot E's draft message.
2. Open its link in a private window as the sandbox personal account, and approve the switch.
3. Do **not** approve D.

- [ ] **Step 6: Refresh shows the switch and the evidence update**

After a few minutes, choose **Refresh from PayPal**. Repeat until E switches. Expected:
- E: "Switched (verified by PayPal)";
- D: "Pending customer decision";
- the panel counts read "1 accepted · 0 declined · 1 awaiting decision or final check";
- the pilot table shows E at `$244.8/yr`.

Reload the page and **Simulate strategies**. In the evidence record, "Annual offers" shows core with 1 accepted and 1 awaiting, plus a `segments.core.annualUptake` mean change, and "Sources and assumptions" lists it as `observed`.

D counts as declined only after its window plus six hours and a confirming read. That will probably fall after the demo, and it is not a failure.

- [ ] **Step 7: Secrecy and browser check**

In a signed-out private window:
- the panel shows statuses with no drafts or copy buttons;
- the network response of `/api/paypal/status` contains no `ba_token` or `paypal.com` link;
- `/api/annual-offers/links` returns 401.

Check the page at phone width (no horizontal scroll) and confirm the console has no errors.

- [ ] **Step 8: Record and close**

Record the evidence in `docs/current-state.md`: proposal ID, offer statuses, test count, CI run, deploy ID and debug IDs, but no links. Mark M7 complete only if every step passed. Commit `docs: record M7 live acceptance`. Push only with Jethro's approval.

---

## Self-review (completed while writing)

- **Spec coverage:** every spec section and every Phase 2 scope item maps to a task (see "Phase 2 scope coverage"). Out-of-scope items stay out: emailing links, withdrawal, moving customers back, `BILLING.SUBSCRIPTION.UPDATED` webhooks and renewal modelling.
- **Placeholders:** none. The two human tasks use `<absolute-private-path>` deliberately, because user-specific paths must not appear in committed docs.
- **Type consistency:** these names are defined once and reused unchanged:
  - `AnnualOfferView`, `OfferRecord`, `offerView` (Task 1)
  - `annualIneligibility`, `INELIGIBILITY_TEXT`, `annualPlanMismatch` (Task 2)
  - `ReviseOffer.httpStatus` (Task 4)
  - `TargetOutcome.offer`, `isDefinitiveFailure` (Task 5)
  - `IssuedOffer`, `recordAnnualOffer`, `recordAnnualTarget`, `recordAnnualPlan`, `appendOfferReads`, `listAnnualOfferViews`, `listAnnualOfferLinks`, `openOfferSubscriptionIds`, `listAnnualPlanIds`, `readAnnualOfferEvidence`, `ANNUAL_REVISE_OPERATION`, `ANNUAL_OFFER_LIMITATION` (Task 6)
  - `AnnualDependencies`, `executeAnnualOfferWith`, `annualPlanRequestId` (Task 7)
  - `CreateAnnualProposalInput`, `createAnnualOfferProposal`, `proposeStrategy`, `DEFAULT_OFFER_WINDOW_DAYS` (Task 9)
  - `seedAnnualOffer`, `fixtureLink` (Task 10)
  - `AnnualEvidence` (Task 14)
  - `isExecutableIntervention`, `Headline.alsoExecutable` (Task 16)
  - `formatUtc` (Task 17)
  - `offerStatusLabel`, `offerCounts` (Task 18)

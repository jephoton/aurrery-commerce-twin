# M0–M1: Rename, PayPal check, Twin v2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Rename the project to Aurrery.
- Prove the hero PayPal operation against the live sandbox.
- Extend the twin so it can express and evaluate the hero story: price-driven cancel-intent subscribers versus a broad at-risk discount, plus a stress test.

**Architecture:**
- The twin (`src/twin/`) stays pure and I/O-free.
- New behaviour comes from three additions: a `cancel_intent` segment with two transitions, a `reason` attribute on cohorts (`price` | `other`) that changes discount response and targeting but not baseline churn, and a `stressTest` that shifts assumed parameters only.
- The ledger and setup script gain a `reason` per pilot subscription, so proposals target exactly what the strategy targets.

**Tech stack:** TypeScript, Next.js 16, Vitest, Zod 4, `@paypal/paypal-server-sdk` 2.5, `node:sqlite`, tsx.

**Conventions:**
- Run commands from the repo root.
- Commits use Conventional Commits with **no** AI co-author trailers.
- Branches:
  - `chore/m0-rename-paypal-check` for Tasks 1–3.
  - `feat/m1-twin-v2` for Tasks 4–8, created from the M0 branch tip.

---

## File map

| File | Change |
| --- | --- |
| `package.json`, `README.md`, `src/app/layout.tsx`, `src/components/Lab.tsx`, `docs/*.md` | Rename to Aurrery (Task 1); pilot reason column in the UI (Task 2) |
| `scripts/paypal-setup.ts` | Request-ID prefix (Task 1); pilot cohort with segment and reason (Task 2) |
| `src/twin/types.ts` | `REASONS` (Task 2); `cancel_intent` and transitions (Task 4); reason parameters (Task 5) |
| `src/ledger/db.ts`, `src/ledger/proposals.ts`, `src/ledger/proposals.test.ts` | Reason on sandbox subscribers (Task 2); reason targeting (Task 7) |
| `src/paypal/subscriptions.ts` | Patch operation parameter (Task 3) |
| `scripts/paypal-check.ts` | New: live sandbox check (Task 3) |
| `src/merchant/demo.ts` | History with `movedTo`, cancel intent (Task 4); reason priors (Task 5) |
| `src/twin/simulate.ts` | Cancel-intent transitions (Task 4); reason cohorts and targeting (Task 5) |
| `src/twin/interventions.ts` | `reason` on targeted discounts (Task 5) |
| `src/twin/calibrate.ts` | Discount-effect update per reason (Task 5) |
| `src/twin/stress.ts` | New: stress test (Task 6) |
| `src/twin/twin.test.ts` | Tests for Tasks 4–6 |
| `src/merchant/candidates.ts`, `scripts/inspect-twin.ts` | Hero strategies; story check (Tasks 5 and 8) |

---

## M0

### Task 1: Rename to Aurrery

**Files:** modify `package.json`, `package-lock.json`, `README.md`, `src/app/layout.tsx`, `src/components/Lab.tsx`, `scripts/paypal-setup.ts`, `docs/architecture.md`, `docs/current-state.md`.

- [ ] **Step 1: Create the branch**

```bash
git switch -c chore/m0-rename-paypal-check
```

- [ ] **Step 2: Find every old name**

Run: `git grep -n -e "Autonomous Commerce Lab" -e "paypal-hackathon" -e "acl-"`
Expected: hits in `package.json`, `package-lock.json`, `README.md`, `src/app/layout.tsx`, `src/components/Lab.tsx`, `scripts/paypal-setup.ts`, and docs.

- [ ] **Step 3: Rename the package and sync the lockfile**

```bash
npm pkg set name=aurrery
npm install --package-lock-only
```

- [ ] **Step 4: Replace user-facing names**

- `src/app/layout.tsx`: set `title: "Aurrery"`. Keep the description.
- `src/components/Lab.tsx`: change the eyebrow text `Autonomous Commerce Lab` to `Aurrery`.
- `README.md`: change the H1 to `# Aurrery`. Make the first paragraph start: `**Simulate before you transact.** Aurrery is an orrery for your business: a digital twin of a subscription business that you can run forward.` Keep the rest of the paragraph.
- `docs/architecture.md` and `docs/current-state.md`: replace "Autonomous Commerce Lab" with "Aurrery" where it appears.
- `scripts/paypal-setup.ts`: replace the three request-ID prefixes:

```ts
"PayPal-Request-Id": "aurrery-ridgeline-product-v1",
```
```ts
paypalRequestId: "aurrery-ridgeline-plan-v1",
```
```ts
paypalRequestId: `aurrery-ridgeline-sub-${i}-v1`,
```

- [ ] **Step 5: Verify nothing old remains, then check everything still builds**

Run: `git grep -n -e "Autonomous Commerce Lab" -e "acl-ridgeline"`
Expected: no output. Spec and plan documents that mention the old name historically are fine.

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: 17 tests pass; no type or lint errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: rename project to Aurrery"
```

### Task 2: Pilot cohort with segment and reason

**Files:** modify `src/twin/types.ts`, `src/ledger/db.ts`, `src/ledger/proposals.ts`, `src/ledger/proposals.test.ts`, `scripts/paypal-setup.ts`, `src/components/Lab.tsx`.

- [ ] **Step 1: Write the failing test**

In `src/ledger/proposals.test.ts`, add `listSandboxSubscribers` to the import from `./proposals`. Replace the two `registerSandboxSubscriber(...)` lines with:

```ts
registerSandboxSubscriber({ subscriptionId: "I-ATRISK0001", label: "A", segment: "at_risk", reason: "price" });
registerSandboxSubscriber({ subscriptionId: "I-CORE000001", label: "D", segment: "core", reason: "other" });
```

Add this test inside `describe("proposal lifecycle", ...)`:

```ts
  it("stores each pilot subscription's reason", () => {
    expect(listSandboxSubscribers().map((s) => [s.subscriptionId, s.reason])).toEqual([
      ["I-ATRISK0001", "price"],
      ["I-CORE000001", "other"],
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ledger/proposals.test.ts`
Expected: FAIL. `reason` is `undefined` in the listed subscribers (and there is a type error in the editor).

- [ ] **Step 3: Add reasons to the twin types**

Append to `src/twin/types.ts`, directly after the `SegmentId` type:

```ts
/** Main reason a subscriber would leave. Affects how they respond to a discount, not their baseline churn. */
export const REASONS = ["price", "other"] as const;
export type ReasonId = (typeof REASONS)[number];
```

- [ ] **Step 4: Add the column and a migration to the ledger**

In `src/ledger/db.ts`, change the `sandbox_subscribers` table in `SCHEMA` to:

```sql
CREATE TABLE IF NOT EXISTS sandbox_subscribers (
  subscription_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  segment TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'other',
  created_at TEXT NOT NULL
);
```

In `ledger()`, directly after `db.exec(SCHEMA);`, add:

```ts
    // Ledgers created before pilot reasons existed.
    const columns = db.prepare("PRAGMA table_info(sandbox_subscribers)").all().map((c) => String(c.name));
    if (!columns.includes("reason")) db.exec("ALTER TABLE sandbox_subscribers ADD COLUMN reason TEXT NOT NULL DEFAULT 'other'");
```

- [ ] **Step 5: Carry the reason through the proposals module**

In `src/ledger/proposals.ts`, change the types import to:

```ts
import { SEGMENTS, type ReasonId } from "@/twin/types";
```

Then replace `SandboxSubscriber`, `listSandboxSubscribers` and `registerSandboxSubscriber` with:

```ts
export interface SandboxSubscriber {
  subscriptionId: string;
  label: string;
  segment: string;
  reason: ReasonId;
}

export function listSandboxSubscribers(): SandboxSubscriber[] {
  return ledger()
    // Insertion order: rows registered in the same millisecond must keep the cohort's order.
    .prepare("SELECT subscription_id, label, segment, reason FROM sandbox_subscribers ORDER BY rowid")
    .all()
    .map((r) => ({
      subscriptionId: String(r.subscription_id),
      label: String(r.label),
      segment: String(r.segment),
      reason: String(r.reason) as ReasonId,
    }));
}

export function registerSandboxSubscriber(s: SandboxSubscriber) {
  ledger()
    .prepare("INSERT OR REPLACE INTO sandbox_subscribers (subscription_id, label, segment, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(s.subscriptionId, s.label, s.segment, s.reason, now());
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/ledger/proposals.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Define the pilot cohort in the setup script**

In `scripts/paypal-setup.ts`, replace `PILOT_COHORT` with:

```ts
// Two price-driven cancel-intent subscribers, one leaving for another reason, one loyal: the
// hero action should visibly target two of the four.
const PILOT_COHORT = [
  { label: "Pilot A: \"honestly it's just too expensive right now\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot B: \"can't justify $24 a month anymore\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot C: \"moving abroad next month\"", segment: "cancel_intent", reason: "other" },
  { label: "Pilot D: loyal, 14 months", segment: "core", reason: "other" },
] as const;
```

Change the registration line inside `setup()` to:

```ts
    registerSandboxSubscriber({ subscriptionId: sub.id!, label: member.label, segment: member.segment, reason: member.reason });
```

Change the `console.log` in `sync()` to include the reason:

```ts
    console.log(s.subscriptionId, `${s.segment}/${s.reason}`.padEnd(22), r.value.status.padEnd(18), "price", r.value.regularPrice ?? "(plan default)", "overridden", r.value.planOverridden, "next", r.value.nextBillingTime);
```

- [ ] **Step 8: Show the reason in the pilot table**

In `src/components/Lab.tsx`, add `reason: string;` to the items of `PayPalStatus.subscriptions` (after `segment: string;`). Replace the segment cell in the pilot table:

```tsx
                  <td>
                    {s.segment.replaceAll("_", " ")}
                    {s.reason === "price" && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">price</span>}
                  </td>
```

- [ ] **Step 9: Verify and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass (18 tests).

```bash
git add -A
git commit -m "feat(ledger): record segment and reason for pilot sandbox subscriptions"
```

### Task 3: Live PayPal Sandbox check

**Files:** modify `src/paypal/subscriptions.ts` and `package.json`; create `scripts/paypal-check.ts`; update `docs/decisions/0001-scenario-and-paypal-action.md`.

- [ ] **Step 1: Make the patch operation selectable**

In `src/paypal/subscriptions.ts`, add after the `Result` type:

```ts
export type PatchOperation = "replace" | "add";
```

Replace the `overrideSubscriptionPrice` signature and its `op:` line:

```ts
export async function overrideSubscriptionPrice(
  id: string,
  amount: string,
  billingCycleSequence = 1,
  operation: PatchOperation = "replace",
): Promise<Result<{ httpStatus: number }>> {
```
```ts
          op: operation === "add" ? PatchOp.Add : PatchOp.Replace,
```

- [ ] **Step 2: Write the check script**

Create `scripts/paypal-check.ts`:

```ts
// Verifies the hero PayPal operation against the live sandbox: override one subscription's price,
// read it back, then restore it.
//
//   npm run paypal:check                   uses the first registered pilot subscription
//   npm run paypal:check -- I-XXXXXXXXXX   uses a specific subscription

import { listSandboxSubscribers } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type PatchOperation } from "@/paypal/subscriptions";

const TEST_PRICE = "23.45";

async function main() {
  const id = process.argv[2] ?? listSandboxSubscribers()[0]?.subscriptionId;
  if (!id) throw new Error("No subscription given and none registered. Run npm run paypal:setup first.");

  const before = await getSubscription(id);
  if (!before.ok) throw new Error(`Read failed: ${JSON.stringify(before.error)}`);
  console.log("before", { status: before.value.status, regularPrice: before.value.regularPrice, overridden: before.value.planOverridden });
  if (before.value.status !== "ACTIVE" && before.value.status !== "SUSPENDED") {
    throw new Error(`Subscription is ${before.value.status}; approve it as a sandbox buyer first.`);
  }
  const original = before.value.regularPrice ?? "24.00";

  let workingOperation: PatchOperation | null = null;
  for (const operation of ["replace", "add"] as const) {
    const r = await overrideSubscriptionPrice(id, TEST_PRICE, 1, operation);
    console.log(`PATCH op=${operation}`, r.ok ? { httpStatus: r.value.httpStatus, debugId: r.debugId } : r.error);
    if (r.ok) {
      workingOperation = operation;
      break;
    }
  }
  if (!workingOperation) throw new Error("PayPal accepted neither replace nor add.");

  const after = await getSubscription(id);
  if (after.ok) {
    console.log("read-back", { regularPrice: after.value.regularPrice, overridden: after.value.planOverridden, debugId: after.debugId });
    console.log("raw plan", JSON.stringify((after.value.raw as { plan?: unknown }).plan ?? null, null, 2));
  } else {
    console.log("read-back failed", after.error);
  }
  const verified = after.ok && Number(after.value.regularPrice) === Number(TEST_PRICE);
  console.log(verified ? "VERIFIED: read-back shows the override" : "NOT VERIFIED: read-back does not show the override");

  const restore = await overrideSubscriptionPrice(id, original, 1, workingOperation);
  console.log("restore", restore.ok ? { to: original, httpStatus: restore.value.httpStatus, debugId: restore.debugId } : restore.error);
  console.log(`\nResult: operation=${workingOperation} verified=${verified}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

```bash
npm pkg set scripts.paypal:check="tsx --env-file-if-exists=.env.local --conditions=react-server scripts/paypal-check.ts"
```

- [ ] **Step 3: Typecheck, then commit the tooling**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

```bash
git add -A
git commit -m "feat(paypal): add live sandbox check for subscription price overrides"
```

- [ ] **Step 4 (needs Jethro): Sandbox credentials and pilot approval**

1. At developer.paypal.com → Apps & Credentials (Sandbox), create a REST app. Put its client ID and secret in `.env.local` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. Run `npm run paypal:setup`. Expected: product and plan IDs, then four approval links, one per pilot.
3. Open each link while signed in as a **sandbox personal** account (developer dashboard → Sandbox accounts) and approve.
4. Run `npm run paypal:sync`. Expected: four lines with status `ACTIVE`.

- [ ] **Step 5: Run the check**

Run: `npm run paypal:check`
Expected: `Result: operation=replace verified=true` (or `operation=add`), plus debug IDs for each call.

- [ ] **Step 6: Act on the result**

- If `operation=add` was needed, change the default in `overrideSubscriptionPrice` from `"replace"` to `"add"`.
- If `verified=false` but a PATCH succeeded, inspect the printed `raw plan` JSON. Update `getSubscription` in `src/paypal/subscriptions.ts` so `regularPrice` reads the field where the overridden price appears. Re-run `npm run paypal:check` until `verified=true`.
- If both operations fail, stop. Record the PayPal error and debug IDs in `docs/current-state.md` and raise it before continuing: the hero action depends on this call.

- [ ] **Step 7: Record the verified shape and commit**

In `docs/decisions/0001-scenario-and-paypal-action.md`, change the status line to:

```markdown
**Status:** accepted (2026-10-21); verified against PayPal Sandbox on <date>: `op=<replace|add>`, read-back via `GET ?fields=plan` shows the override.
```

(Fill in the actual date and operation from Step 5.) In `docs/current-state.md`, remove the "PATCH price override in the real sandbox" item from "Not yet verified".

```bash
git add -A
git commit -m "docs: record verified PayPal price-override request shape"
```

---

## M1

### Task 4: Cancel-intent segment and its transitions

**Files:** modify `src/twin/types.ts`, `src/merchant/demo.ts`, `src/twin/simulate.ts`, `src/twin/twin.test.ts`.

- [ ] **Step 1: Create the branch**

```bash
git switch -c feat/m1-twin-v2
```

- [ ] **Step 2: Write the failing tests**

In `src/twin/twin.test.ts`, add inside `describe("calibration", ...)`:

```ts
  it("recovers cancel-intent escalation and de-escalation rates", () => {
    const t = twin.params.transitions;
    const pairs = [
      [t.atRiskToCancelIntent, DEMO_TRUTH.atRiskToCancelIntent],
      [t.cancelIntentToAtRisk, DEMO_TRUTH.cancelIntentToAtRisk],
    ] as const;
    for (const [posterior, truth] of pairs) {
      expect(Math.abs(betaMean(posterior) - truth)).toBeLessThan(4 * betaSd(posterior) + 0.002);
    }
  });

  it("starts with subscribers in every segment, including cancel intent", () => {
    for (const s of SEGMENTS) expect(twin.initialActive[s]).toBeGreaterThan(0);
    expect(SEGMENTS).toContain("cancel_intent");
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/twin/twin.test.ts -t "cancel"`
Expected: FAIL (`atRiskToCancelIntent` is undefined; `SEGMENTS` has no `cancel_intent`).

- [ ] **Step 4: Extend the types**

In `src/twin/types.ts`:

```ts
export const SEGMENTS = ["new", "core", "price_sensitive", "at_risk", "cancel_intent"] as const;
```

In `TwinParams.transitions`, after `atRiskRecovery: BetaDist;`, add:

```ts
    /** at_risk → cancel_intent, drawn from at-risk subscribers who did not recover that month. */
    atRiskToCancelIntent: BetaDist;
    /** cancel_intent → at_risk (they stepped back from cancelling). */
    cancelIntentToAtRisk: BetaDist;
```

In `SampledParams`, after `atRiskRecovery: number;`, add:

```ts
  atRiskToCancelIntent: number;
  cancelIntentToAtRisk: number;
```

- [ ] **Step 5: Regenerate the demo history with destination-level moves**

In `src/merchant/demo.ts`, replace the `DemoHistoryRow` interface:

```ts
export interface DemoHistoryRow extends SegmentMonthRecord {
  /** Subscribers who moved from this segment to another this month, by destination. */
  movedTo: Partial<Record<SegmentId, number>>;
}
```

Replace `DEMO_TRUTH` and `START_ACTIVE`:

```ts
/** Hidden generating rates. The twin never reads these directly; tests use them to check recovery. */
export const DEMO_TRUTH = {
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16, cancel_intent: 0.35 } as Record<SegmentId, number>,
  involuntary: 0.015,
  newGraduation: 0.33,
  newToPriceSensitive: 0.35,
  coreToAtRisk: 0.02,
  priceSensitiveToAtRisk: 0.035,
  atRiskRecovery: 0.12,
  atRiskToCancelIntent: 0.1,
  cancelIntentToAtRisk: 0.2,
  acquisitionMean: 190,
  acquisitionSd: 22,
};

const START_ACTIVE: Record<SegmentId, number> = { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 };
```

In `generateDemoHistory`, replace everything from `const inflow` to the end of the inner `for (const segment of SEGMENTS) { ... }` loop with:

```ts
    const inflow = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<SegmentId, number>;
    for (const segment of SEGMENTS) {
      const start = active[segment];
      const voluntary = rng.binomial(start, t.churn[segment]);
      const involuntary = rng.binomial(start - voluntary, t.involuntary);
      const remaining = start - voluntary - involuntary;
      const movedTo: Partial<Record<SegmentId, number>> = {};
      if (segment === "new") {
        const graduated = rng.binomial(remaining, t.newGraduation);
        movedTo.price_sensitive = rng.binomial(graduated, t.newToPriceSensitive);
        movedTo.core = graduated - movedTo.price_sensitive;
      } else if (segment === "core") {
        movedTo.at_risk = rng.binomial(remaining, t.coreToAtRisk);
      } else if (segment === "price_sensitive") {
        movedTo.at_risk = rng.binomial(remaining, t.priceSensitiveToAtRisk);
      } else if (segment === "at_risk") {
        movedTo.core = rng.binomial(remaining, t.atRiskRecovery);
        movedTo.cancel_intent = rng.binomial(remaining - movedTo.core, t.atRiskToCancelIntent);
      } else {
        movedTo.at_risk = rng.binomial(remaining, t.cancelIntentToAtRisk);
      }
      let out = 0;
      for (const [to, n] of Object.entries(movedTo) as [SegmentId, number][]) {
        inflow[to] += n;
        out += n;
      }
      segments.push({ month, segment, activeAtStart: start, voluntaryChurn: voluntary, involuntaryChurn: involuntary, movedTo });
      active[segment] = remaining - out;
    }
```

(The following line, `for (const segment of SEGMENTS) active[segment] += inflow[segment];`, stays.)

In `buildDemoTwin`, replace everything from `const transitionPosterior = ...` through `const toPriceSensitive = ...;` with:

```ts
  const segmentRows = (segment: SegmentId) => rows.filter((x) => x.segment === segment);
  const stayed = (segment: SegmentId) =>
    segmentRows(segment).reduce((s, x) => s + x.activeAtStart - x.voluntaryChurn - x.involuntaryChurn, 0);
  const moved = (from: SegmentId, to: SegmentId) => segmentRows(from).reduce((s, x) => s + (x.movedTo[to] ?? 0), 0);
  const graduated = moved("new", "core") + moved("new", "price_sensitive");
  const recovered = moved("at_risk", "core");
```

Replace the `transitions: { ... }` block in `params` with:

```ts
      transitions: {
        newGraduation: betaPosterior(FLAT_PRIOR, graduated, stayed("new")),
        newToPriceSensitive: betaPosterior(FLAT_PRIOR, moved("new", "price_sensitive"), graduated),
        coreToAtRisk: betaPosterior(FLAT_PRIOR, moved("core", "at_risk"), stayed("core")),
        priceSensitiveToAtRisk: betaPosterior(FLAT_PRIOR, moved("price_sensitive", "at_risk"), stayed("price_sensitive")),
        atRiskRecovery: betaPosterior(FLAT_PRIOR, recovered, stayed("at_risk")),
        atRiskToCancelIntent: betaPosterior(FLAT_PRIOR, moved("at_risk", "cancel_intent"), stayed("at_risk") - recovered),
        cancelIntentToAtRisk: betaPosterior(FLAT_PRIOR, moved("cancel_intent", "at_risk"), stayed("cancel_intent")),
      },
```

Add a `cancel_intent` entry to `params.segments`, after `at_risk`:

```ts
        cancel_intent: {
          label: "Cancel intent (opened cancel flow)",
          monthlyChurn: voluntary.cancel_intent.posterior,
          churnPriceElasticity: { mean: 2.0, sd: 0.8 },
          annualUptake: { alpha: 1, beta: 49 },
        },
```

- [ ] **Step 6: Simulate the new transitions**

In `src/twin/simulate.ts` `sampleParams`, after `atRiskRecovery: ...,` add:

```ts
    atRiskToCancelIntent: beta(p.transitions.atRiskToCancelIntent),
    cancelIntentToAtRisk: beta(p.transitions.cancelIntentToAtRisk),
```

In `runOnce`'s transition loop, replace the final `else { const recovered ... }` branch with:

```ts
      } else if (c.segment === "at_risk") {
        // Same order as the history generator: recovery first, then escalation from the rest.
        const recovered = rng.binomial(c.count, s.atRiskRecovery);
        const escalated = rng.binomial(c.count - recovered, s.atRiskToCancelIntent);
        c.count -= recovered + escalated;
        moved.push({ ...c, segment: "core", count: recovered });
        moved.push({ ...c, segment: "cancel_intent", count: escalated });
      } else {
        const deescalated = rng.binomial(c.count, s.cancelIntentToAtRisk);
        c.count -= deescalated;
        moved.push({ ...c, segment: "at_risk", count: deescalated });
      }
```

- [ ] **Step 7: Run all tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (20), including the two new ones; no type errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(twin): add cancel-intent segment with estimated escalation transitions"
```

### Task 5: Reasons: price-driven versus other

**Files:** modify `src/twin/types.ts`, `src/twin/interventions.ts`, `src/twin/simulate.ts`, `src/twin/calibrate.ts`, `src/merchant/demo.ts`, `src/merchant/candidates.ts`, `src/twin/twin.test.ts`, `src/ledger/proposals.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/twin/twin.test.ts`, replace the `discount` constant and add two strategies after it:

```ts
const discount: Strategy = {
  id: "at-risk-20",
  name: "20% off for at-risk, 3 months",
  intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3 },
};
const precision: Strategy = {
  id: "cancel-price-25",
  name: "25% off price-driven cancel intent, 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3 },
};
const cancelAny: Strategy = {
  id: "cancel-any-25",
  name: "25% off all cancel intent, 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "any", discountPct: 25, months: 3 },
};
```

Replace the test `"pulls the discount effect toward observed outcomes"` with:

```ts
  it("pulls the discount effect for a reason toward observed outcomes", () => {
    const { changes } = updateDiscountEffect(twin, [{ segment: "at_risk", reason: "price", subscriberMonths: 600, cancellations: 20 }]);
    // 600 months × ~16% ≈ 96 expected cancellations without discount; 20 observed → RR well below the prior.
    expect(changes).toHaveLength(1);
    expect(changes[0].parameter).toBe("offerChurnRelativeRisk.price");
    expect(changes[0].after.mean).toBeLessThan(changes[0].before.mean);
    expect(changes[0].after.sd).toBeLessThan(changes[0].before.sd);
  });
```

Add inside `describe("simulation", ...)`:

```ts
  it("discounts only subscribers with the targeted reason", () => {
    const r = compareStrategies(twin, [precision, cancelAny], FAST);
    const [, onlyPrice, everyone] = r.strategies;
    expect(onlyPrice.metrics.discountCost.mean).toBeGreaterThan(0);
    expect(onlyPrice.metrics.discountCost.mean).toBeLessThan(everyone.metrics.discountCost.mean);
  });

  it("values the precision discount above the broad at-risk discount", () => {
    const r = compareStrategies(twin, [discount, precision], FAST);
    const [, broad, precise] = r.strategies;
    expect(precise.vsBaseline.totalValue.p50).toBeGreaterThan(broad.vsBaseline.totalValue.p50);
  });
```

Replace the body of the `"rejects discounts outside commercial bounds"` test with:

```ts
    const ok = { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3 };
    expect(InterventionSchema.safeParse(ok).success).toBe(true);
    expect(InterventionSchema.safeParse({ ...ok, discountPct: 80 }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, segment: "vip" }).success).toBe(false);
    expect(InterventionSchema.safeParse({ ...ok, reason: "loyalty" }).success).toBe(false);
```

In `src/ledger/proposals.test.ts`, add `reason: "any",` to the `strategy` constant's intervention (after `segment: "at_risk",`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/twin/twin.test.ts`
Expected: FAIL. `reason: "any"` is rejected by the schema in the guardrail test, `changes` is undefined, and the targeting tests fail because reason is ignored.

- [ ] **Step 3: Add reason parameters to the types**

In `src/twin/types.ts`, in `SegmentParams` after `annualUptake`, add:

```ts
  /** Share of this segment whose main reason to leave is price. From classified feedback when available. */
  priceReasonShare: BetaDist;
```

Replace `offerChurnRelativeRisk` in `TwinParams` with:

```ts
  /** Churn multiplier while on a retention discount, by leaving reason. */
  offerChurnRelativeRisk: Record<ReasonId, GammaDist>;
```

In `SampledParams`, replace `offerRelativeRisk: number;` with:

```ts
  offerRelativeRisk: Record<ReasonId, number>;
  priceReasonShare: Record<SegmentId, number>;
```

- [ ] **Step 4: Add the reason to targeted discounts**

In `src/twin/interventions.ts`, change the `targeted_discount` object to:

```ts
  z.object({
    kind: z.literal("targeted_discount"),
    segment: SegmentSchema,
    /** "price" targets only subscribers whose main leaving reason is price. */
    reason: z.enum(["price", "any"]),
    discountPct: z.number().min(5).max(50),
    months: z.number().int().min(1).max(12),
  }),
```

Replace the `targeted_discount` case in `describeIntervention` with:

```ts
    case "targeted_discount": {
      const who = `${intervention.segment.replaceAll("_", " ")} subscribers${intervention.reason === "price" ? " leaving over price" : ""}`;
      return `Offer ${who} ${intervention.discountPct}% off ($${(listPrice * (1 - intervention.discountPct / 100)).toFixed(2)}/mo) for ${intervention.months} month(s).`;
    }
```

- [ ] **Step 5: Give cohorts a reason in the simulator**

In `src/twin/simulate.ts`:

1. Add `REASONS` to the value imports from `./types` and `type ReasonId` to the type imports.
2. Add `reason: ReasonId;` to `Cohort`, after `segment`.
3. Replace `cohortKey`, `monthlyCohort`, and add `splitByReason`:

```ts
function cohortKey(c: Cohort): string {
  return [c.segment, c.reason, c.plan, c.offer ? 1 : 0, c.rebound ? 1 : 0, c.monthsLeft, c.price, c.billDue ? 1 : 0].join(":");
}
```
```ts
function monthlyCohort(segment: SegmentId, reason: ReasonId, count: number, price: number): Cohort {
  return { segment, reason, count, price, plan: "monthly", monthsLeft: 0, offer: false, fullPrice: price, rebound: false, billDue: false };
}

/** Split a count into price-driven and other subscribers. */
function splitByReason(segment: SegmentId, count: number, price: number, priceShare: number, rng: Rng): Cohort[] {
  const priceDriven = rng.binomial(count, priceShare);
  return [monthlyCohort(segment, "price", priceDriven, price), monthlyCohort(segment, "other", count - priceDriven, price)];
}
```

4. In `sampleParams`, replace the `offerRelativeRisk:` line with:

```ts
    offerRelativeRisk: Object.fromEntries(
      REASONS.map((r) => [r, rng.gamma(p.offerChurnRelativeRisk[r].shape) / p.offerChurnRelativeRisk[r].rate]),
    ) as Record<ReasonId, number>,
    priceReasonShare: bySegment((s) => beta(p.segments[s].priceReasonShare)),
```

5. In `runOnce`, replace the initial cohorts line:

```ts
  let cohorts: Cohort[] = merge(
    SEGMENTS.flatMap((seg) => splitByReason(seg, twin.initialActive[seg], listPrice, s.priceReasonShare[seg], draw(`init:reason:${seg}`))),
  );
```

6. Change the targeted-discount condition to:

```ts
      if (
        c.segment === intervention.segment &&
        (intervention.reason === "any" || c.reason === intervention.reason) &&
        c.plan === "monthly" &&
        !c.offer
      ) {
```

7. Change the annual-uptake draw key to `` `iv:annual:${c.segment}:${c.reason}` ``.
8. Replace the acquisition merge line with:

```ts
    cohorts = merge([...cohorts, ...splitByReason("new", acquired, listPrice, s.priceReasonShare.new, draw(`m${t}:acq:reason`))]);
```

9. In the churn loop, change the key and the discount multiplier:

```ts
      const key = `m${t}:churn:${c.segment}:${c.reason}:${c.offer ? "o" : c.rebound ? "r" : "b"}`;
```
```ts
      if (c.offer) hazard *= s.offerRelativeRisk[c.reason];
```

10. In the transition loop, change the key:

```ts
      const rng = draw(`m${t}:move:${c.segment}:${c.reason}:${c.offer ? "o" : c.rebound ? "r" : "b"}`);
```

- [ ] **Step 6: Update the discount effect per reason**

In `src/twin/calibrate.ts`, change the types import to:

```ts
import { REASONS, SEGMENTS, type BetaDist, type GammaDist, type MerchantTwin, type NormalDist, type ReasonId, type SegmentId } from "./types";
```

Add `reason: ReasonId;` to `DiscountOutcomeObservation`, after `segment`. Replace `updateDiscountEffect` with:

```ts
/**
 * Update the discount relative-risk posterior for each leaving reason from observed cancellations,
 * treating them as Poisson with mean RR × (expected cancellations without the discount).
 * Gamma prior → Gamma posterior.
 */
export function updateDiscountEffect(
  twin: MerchantTwin,
  observations: DiscountOutcomeObservation[],
): { twin: MerchantTwin; changes: ParameterChange[] } {
  let params = twin.params;
  let provenance = twin.provenance;
  const changes: ParameterChange[] = [];
  for (const reason of REASONS) {
    const obs = observations.filter((o) => o.reason === reason);
    const expected = obs.reduce((s, o) => s + o.subscriberMonths * betaMean(twin.params.segments[o.segment].monthlyChurn), 0);
    if (expected <= 0) continue;
    const observed = obs.reduce((s, o) => s + o.cancellations, 0);
    const months = obs.reduce((s, o) => s + o.subscriberMonths, 0);
    const before = params.offerChurnRelativeRisk[reason];
    const after: GammaDist = { shape: before.shape + observed, rate: before.rate + expected };
    const parameter = `offerChurnRelativeRisk.${reason}`;
    const evidence = `${observed} cancellation(s) in ${months} discounted ${reason}-reason subscriber-month(s); ${expected.toFixed(2)} expected without discount`;
    params = { ...params, offerChurnRelativeRisk: { ...params.offerChurnRelativeRisk, [reason]: after } };
    provenance = { ...provenance, [parameter]: { source: "observed", note: `Prior assumption updated with ${evidence}.`, evidenceCount: months } };
    changes.push({
      parameter,
      before: { mean: gammaMean(before), sd: gammaSd(before) },
      after: { mean: gammaMean(after), sd: gammaSd(after) },
      evidence,
    });
  }
  return { twin: { ...twin, params, provenance }, changes };
}
```

- [ ] **Step 7: Reason priors in the demo merchant**

In `src/merchant/demo.ts`, add after `FLAT_PRIOR`:

```ts
/** Prior share of price-driven leavers per segment, used until customer feedback is classified. */
const PRICE_REASON_PRIOR: Record<SegmentId, number> = { new: 0.3, core: 0.2, price_sensitive: 0.65, at_risk: 0.45, cancel_intent: 0.6 };
const reasonPrior = (segment: SegmentId) => ({ alpha: PRICE_REASON_PRIOR[segment] * 10, beta: (1 - PRICE_REASON_PRIOR[segment]) * 10 });
```

Add `priceReasonShare: reasonPrior("<segment>"),` to each of the five segment entries in `params.segments`, using that entry's own key.

Replace `offerChurnRelativeRisk: { shape: 6, rate: 10 },` with:

```ts
      offerChurnRelativeRisk: { price: { shape: 9, rate: 20 }, other: { shape: 20, rate: 22.2 } },
```

In `provenance`, replace the `offerChurnRelativeRisk` entry and add `priceReasonShare`:

```ts
    offerChurnRelativeRisk: assume("Prior that a retention discount cuts churn to ~45% of normal for price-driven leavers and ~90% for others (wide); updated from observed outcomes."),
    priceReasonShare: assume("Prior share of price-driven leavers per segment; replaced by classified customer feedback when available."),
```

- [ ] **Step 8: Starter strategies with the hero**

Replace the array in `src/merchant/candidates.ts` with:

```ts
export const STARTER_STRATEGIES: Strategy[] = [
  {
    id: "at-risk-20-3m",
    name: "At-risk: 20% off for 3 months",
    intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3 },
  },
  {
    id: "cancel-price-25-3m",
    name: "Price-driven cancel intent: 25% off for 3 months",
    intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3 },
  },
  {
    id: "annual-15",
    name: "Annual prepay at 15% off",
    intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] },
  },
  {
    id: "list-22",
    name: "Cut list price to $22",
    intervention: { kind: "list_price_change", newPrice: 22 },
  },
  {
    id: "list-27",
    name: "Raise list price to $27",
    intervention: { kind: "list_price_change", newPrice: 27 },
  },
];
```

- [ ] **Step 9: Run all tests and the typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass (22 tests).

If `"values the precision discount above the broad at-risk discount"` fails, **do not tune parameters to force it.** Record the numbers from `npm run twin:inspect` (Task 8 updates that script) and stop to revisit the story with Jethro.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(twin): target discounts by leaving reason with reason-specific effects"
```

### Task 6: Stress test

**Files:** create `src/twin/stress.ts`; modify `src/twin/twin.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/twin/twin.test.ts`, add `import { stressTest } from "./stress";` and append:

```ts
describe("stress test", () => {
  it("never makes the precision discount look better than the base case", () => {
    const r = stressTest(twin, precision, FAST);
    expect(r.stressed.vsBaseline.totalValue.p50).toBeLessThanOrEqual(r.base.vsBaseline.totalValue.p50);
    expect(r.shifted.length).toBeGreaterThan(0);
  });

  it("makes a price rise look worse when customers are more price sensitive", () => {
    const r = stressTest(twin, priceRise, FAST);
    expect(r.stressed.vsBaseline.totalValue.p50).toBeLessThan(r.base.vsBaseline.totalValue.p50);
  });

  it("leaves parameters estimated from data untouched", () => {
    const r = stressTest(twin, precision, FAST);
    expect(r.stressedParams.segments.at_risk.monthlyChurn).toEqual(twin.params.segments.at_risk.monthlyChurn);
    expect(r.stressedParams.transitions).toEqual(twin.params.transitions);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/twin/twin.test.ts -t "stress"`
Expected: FAIL with `Failed to resolve import "./stress"`.

- [ ] **Step 3: Implement the stress test**

Create `src/twin/stress.ts`:

```ts
import type { Intervention, Strategy } from "./interventions";
import { compareStrategies, type SimulationOptions, type StrategyResult } from "./simulate";
import { REASONS, SEGMENTS, type BetaDist, type GammaDist, type MerchantTwin, type NormalDist, type SegmentParams, type TwinParams } from "./types";

// Stress test: rerun a strategy with every *assumed* parameter that matters to it shifted to its
// unfavourable 80th percentile, keeping each distribution's spread. Estimated parameters are untouched.

const Z80 = 0.8416;

const shiftNormal = (d: NormalDist, direction: 1 | -1): NormalDist => ({ mean: d.mean + direction * Z80 * d.sd, sd: d.sd });

function shiftGamma(d: GammaDist, direction: 1 | -1): GammaDist {
  const sd = Math.sqrt(d.shape) / d.rate;
  const mean = Math.max(1e-3, d.shape / d.rate + direction * Z80 * sd);
  return { shape: (mean / sd) ** 2, rate: mean / sd ** 2 };
}

function shiftBeta(d: BetaDist, direction: 1 | -1): BetaDist {
  const n = d.alpha + d.beta;
  const mean = d.alpha / n;
  const sd = Math.sqrt((mean * (1 - mean)) / (n + 1));
  const shifted = Math.min(0.999, Math.max(0.001, mean + direction * Z80 * sd));
  return { alpha: shifted * n, beta: (1 - shifted) * n };
}

const mapSegments = (p: TwinParams, f: (s: SegmentParams) => SegmentParams) =>
  Object.fromEntries(SEGMENTS.map((seg) => [seg, f(p.segments[seg])])) as TwinParams["segments"];

export function stressParams(p: TwinParams, intervention: Intervention): { params: TwinParams; shifted: string[] } {
  switch (intervention.kind) {
    case "baseline":
      return { params: p, shifted: [] };
    case "targeted_discount":
      return {
        params: {
          ...p,
          offerChurnRelativeRisk: Object.fromEntries(
            REASONS.map((r) => [r, shiftGamma(p.offerChurnRelativeRisk[r], 1)]),
          ) as TwinParams["offerChurnRelativeRisk"],
          postOfferChurnMultiplier: shiftNormal(p.postOfferChurnMultiplier, 1),
        },
        shifted: ["discount cuts churn less than assumed", "churn rebounds more when the discount ends"],
      };
    case "annual_plan":
      return {
        params: { ...p, segments: mapSegments(p, (s) => ({ ...s, annualUptake: shiftBeta(s.annualUptake, -1) })) },
        shifted: ["fewer subscribers take the annual plan"],
      };
    case "list_price_change": {
      const direction = intervention.newPrice > p.listPrice ? 1 : -1;
      return {
        params: {
          ...p,
          acquisitionPriceElasticity: shiftNormal(p.acquisitionPriceElasticity, direction),
          segments: mapSegments(p, (s) => ({ ...s, churnPriceElasticity: shiftNormal(s.churnPriceElasticity, direction) })),
        },
        shifted: [direction === 1 ? "customers more price sensitive than assumed" : "customers less price sensitive than assumed"],
      };
    }
  }
}

export interface StressResult {
  base: StrategyResult;
  stressed: StrategyResult;
  stressedParams: TwinParams;
  /** Plain-language list of what was made worse, for the agent and the UI. */
  shifted: string[];
}

export function stressTest(twin: MerchantTwin, strategy: Strategy, options: Partial<SimulationOptions> = {}): StressResult {
  const pick = (r: ReturnType<typeof compareStrategies>) => r.strategies.find((s) => s.strategy.id === strategy.id)!;
  const { params, shifted } = stressParams(twin.params, strategy.intervention);
  return {
    base: pick(compareStrategies(twin, [strategy], options)),
    stressed: pick(compareStrategies({ ...twin, params }, [strategy], options)),
    stressedParams: params,
    shifted,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass (25 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(twin): add stress test shifting assumptions to unfavourable percentiles"
```

### Task 7: Proposals target by reason

**Files:** modify `src/ledger/proposals.ts`, `src/ledger/proposals.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/ledger/proposals.test.ts`, replace the two `registerSandboxSubscriber` lines with the full pilot cohort:

```ts
registerSandboxSubscriber({ subscriptionId: "I-PRICE000001", label: "A", segment: "cancel_intent", reason: "price" });
registerSandboxSubscriber({ subscriptionId: "I-PRICE000002", label: "B", segment: "cancel_intent", reason: "price" });
registerSandboxSubscriber({ subscriptionId: "I-OTHER000001", label: "C", segment: "cancel_intent", reason: "other" });
registerSandboxSubscriber({ subscriptionId: "I-CORE0000001", label: "D", segment: "core", reason: "other" });
```

Replace the `strategy` constant with:

```ts
const strategy: Strategy = {
  id: "cancel-price-25",
  name: "25% off price-driven cancel intent for 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3 },
};
```

Replace the test `"stores each pilot subscription's reason"` with:

```ts
  it("stores each pilot subscription's reason", () => {
    expect(listSandboxSubscribers().map((s) => s.reason)).toEqual(["price", "price", "other", "other"]);
  });
```

Replace the test `"targets only subscriptions in the strategy's segment, at the discounted price"` with:

```ts
  it("targets only pilots matching the strategy's segment and reason, at the discounted price", () => {
    const p = propose();
    expect(p.action.targets).toEqual(["I-PRICE000001", "I-PRICE000002"]);
    expect(p.action.reason).toBe("price");
    expect(p.action.newPrice).toBe("18.00");
    expect(p.status).toBe("proposed");
  });

  it("targets every reason in the segment when the strategy says any", () => {
    const anyReason: Strategy = { ...strategy, id: "cancel-any-25", intervention: { ...strategy.intervention, reason: "any" } as Strategy["intervention"] };
    const p = createProposal({ objective: null, strategy: anyReason, result, listPrice: twin.params.listPrice });
    expect(p.action.targets).toEqual(["I-PRICE000001", "I-PRICE000002", "I-OTHER000001"]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ledger/proposals.test.ts`
Expected: FAIL. The targets include `I-OTHER000001` and `action.reason` is undefined.

- [ ] **Step 3: Add the reason to the action and the target filter**

In `src/ledger/proposals.ts`, add to `PriceOverrideActionSchema` after `segment`:

```ts
  reason: z.enum(["price", "any"]),
```

In `buildAction`, replace the `targets` computation and the `NO_TARGETS` throw with:

```ts
  const targets = listSandboxSubscribers()
    .filter((s) => s.segment === iv.segment && (iv.reason === "any" || s.reason === iv.reason))
    .map((s) => s.subscriptionId)
    .slice(0, MAX_TARGETS_PER_ACTION);
  if (targets.length === 0) {
    throw new ProposalError(`No sandbox subscriptions are registered in segment "${iv.segment}" with reason "${iv.reason}".`, "NO_TARGETS");
  }
```

Add `reason: iv.reason,` to the object passed to `PriceOverrideActionSchema.parse`, after `segment: iv.segment,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass (26 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ledger): target proposal pilots by segment and leaving reason"
```

### Task 8: Story check and docs

**Files:** modify `scripts/inspect-twin.ts`, `docs/current-state.md`, `docs/architecture.md`.

- [ ] **Step 1: Make the inspect script print the story**

Replace `scripts/inspect-twin.ts` with:

```ts
// Prints the starter strategy comparison and stress tests on the demo twin, for sanity-checking the model.
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";

const { twin } = buildDemoTwin();
console.log("initial", twin.initialActive);
console.log("churn", Object.fromEntries(Object.entries(twin.params.segments).map(([k, v]) => [k, betaMean(v.monthlyChurn).toFixed(4)])));

const f = (x: number) => Math.round(x).toLocaleString();
const comparison = compareStrategies(twin, STARTER_STRATEGIES);
for (const s of comparison.strategies) {
  const d = s.vsBaseline.totalValue;
  console.log(
    s.strategy.name.padEnd(50),
    "ΔValue p10/p50/p90", f(d.p10), f(d.p50), f(d.p90),
    "P(worse)", s.probValueBelowBaseline.toFixed(2),
    "discount$", f(s.metrics.discountCost.mean),
  );
}
for (const strategy of STARTER_STRATEGIES) {
  const st = stressTest(twin, strategy);
  console.log("stress", strategy.name.padEnd(50), "ΔValue p50", f(st.base.vsBaseline.totalValue.p50), "→", f(st.stressed.vsBaseline.totalValue.p50), "|", st.shifted.join("; "));
}
```

- [ ] **Step 2: Run it and check the story**

Run: `npm run twin:inspect`
Expected:
- **Broad at-risk discount:** P(worse) roughly 0.4–0.6.
- **Precision discount:** a higher median ΔValue than the broad one, and P(worse) clearly lower (below about 0.25).
- **Stress lines:** for each strategy, the stressed value is at most the base value.

If the precision discount's P(worse) is above about 0.3, **stop**. Record the output in `docs/current-state.md` and revisit the story with Jethro; do not tune parameters to force it.

- [ ] **Step 3: Update the handoff docs**

In `docs/current-state.md`, under "Done", add:

```markdown
- Twin v2: `cancel_intent` segment, leaving reasons (price/other) with reason-specific discount effects and targeting, stress test; pilots and proposals carry reasons.
- Story check (`npm run twin:inspect`, 1,000 runs): <paste the broad and precision ΔValue p50 and P(worse) lines>.
```

Replace "Next steps" with the M2–M8 list from `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md` (milestone titles only).

In `docs/architecture.md`, replace the "Model summary" paragraph with:

```markdown
Monthly cohorts by segment (`new`, `core`, `price_sensitive`, `at_risk`, `cancel_intent`) × leaving reason (`price`, `other`) × plan (monthly or annual) × discount state. Each month: acquisition (Poisson, price-elastic, split by reason), billing and fulfilment, voluntary churn (segment hazard × price elasticity, or × the reason's discount relative risk), involuntary churn, discount and annual countdown (with post-discount rebound), and segment transitions (including at-risk ⇄ cancel-intent). Reason affects discount response and targeting, not baseline churn. The decision metric is **total value**: 12-month gross profit plus the discounted margin of the remaining base over the next 24 months. `stressTest` reruns a strategy with its assumed parameters at their unfavourable 80th percentile.
```

- [ ] **Step 4: Final verification and commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: 26 tests pass; no errors; build succeeds.

```bash
git add -A
git commit -m "docs: record twin v2 story check and update handoff docs"
```

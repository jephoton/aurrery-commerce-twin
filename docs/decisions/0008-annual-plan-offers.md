# 0008: Annual-plan offers through PayPal `revise`

**Status:** accepted. **GO** for M7 Phase 2: the live Sandbox check passed on 2026-10-31.

## Context

M7 makes the twin's annual prepay plan a real PayPal action (spec `docs/superpowers/specs/2026-10-31-m7-annual-plan-design.md`). PayPal documents that `revise` plan switches need buyer consent, the same product and the same currency, but not whether a monthly-to-yearly switch is accepted. Before integrating, `npm run paypal:annual-check` tested this on one disposable subscription, `I-PDK7VBGHPPRX` (`customId` `m7-annual-check`). It never touched a registered pilot, and Jethro approved both steps as the sandbox personal account.

## Findings

### Plan creation
- **Plan:** `createAnnualPlan` created `P-1G664107G6884914PNLS6K7I` under product `PROD-2WY03000D5542760J`.
- **Read-back:** ACTIVE, YEAR × 1, one REGULAR cycle with `totalCycles: 0`, USD.
- **Price normalisation:** PayPal reads the price back as **`"244.8"`, not `"244.80"`**. Prices must be compared by cents (`sameUsdAmount`), never as strings. The check script's exact-string comparison refused at first, which was safe, and was fixed in `3c67f16`.

### Switch accepted
Monthly → yearly `revise` with the new `plan_id` returned **HTTP 200** (debug IDs `f226837eab0d3` and `f5560140d20d6`) and `planOverridden: false`. There was no `PLAN_PRODUCT_NOT_COMPATIBLE` or any other refusal.

### Approval link
- **Shape:** host `www.sandbox.paypal.com`, path `/webapps/billing/subscriptions/update`, one query parameter `ba_token` (tokens are not recorded here).
- **No expiry information:** neither the response nor the link carries an expiry, so the merchant's offer window is the only expiry Aurrery can enforce; `offerExpiry` receives no PayPal expiry.
- **Real token lifetime is untested:** both links were approved within about six minutes. A `ba_token` may stop working before a multi-day window closes, and PayPal does not stop it working when the window closes either. The UI says "offer window closed", never that the link is dead, and the demo approves Pilot E's link soon after it is issued.
- **Other links:** `rel` values `edit`, `self`, `cancel`, `suspend` and `capture`.

### Repeated `revise`
- **Fresh token each time:** two consecutive requests both returned 200, each with a **different** `ba_token` (`sameLink: false`, `sameToken: false`).
- **Older token dies:** after the second link was approved, the first link showed PayPal's generic "Things don't appear to be working at the moment" page.
- **Consequence:** there is no request-ID deduplication (the SDK's `reviseSubscription` takes none) and every request mints a new token. Phase 2 must call `revise` **at most once per offer**. An uncertain outcome is reconciled by reading back, never by retrying.

### When `plan_id` changes
- **Before approval** (12:57:46Z): ACTIVE on the monthly plan `P-9SX95548GB525542MNLMZ74Q`, `regularPrice` 24.0, interval MONTH.
- **After approval** (read at 13:03:11Z): still ACTIVE, `planId` is the annual plan, `regularPrice` 244.8, interval YEAR.
- **The switch is visible on read-back right after approval.** Status stays ACTIVE throughout, so the read-back rule "ACTIVE on the offered annual plan" detects a switch correctly.

### Charge timing
- **No immediate charge:** `nextBillingTime` stayed `2026-11-30T10:00:00Z`, `outstandingBalance` was 0.0, and `lastPayment` was still the original $24 from activation. The yearly price is charged at the next billing date.
- **UI wording:** "switches at your next renewal date" is accurate.

### Approval latency
The **initial** subscription approval took about five minutes to register as ACTIVE after Jethro was redirected; reads showed APPROVAL_PENDING in the meantime. Customer-approval tracking must tolerate that delay and never treat a short APPROVAL_PENDING as a failure.

### Cleanup
`cancel` returned and a fresh GET confirmed **CANCELLED**. The check plan stays ACTIVE in Sandbox; it's harmless and not used by the app.

## Decision

Proceed with M7 Phase 2 as designed (Approach A), with these amendments to the spec:
1. Compare every PayPal price by cents.
2. Offers expire only by the merchant window; PayPal gives no link expiry. Reads continue after the window, so a late switch is still recorded and wins over an expiry or decline.
3. `revise` is called at most once per target per approved offer. Ambiguous or uncertain outcomes leave the proposal executing for reconciliation by read-back, with no retry.
4. Approval detection keeps the existing rule (ACTIVE and `plan_id` equals the annual plan). The UI says the yearly price is charged from the subscriber's next renewal date.
5. The executor classifies definitive failures with `execute.ts`'s existing definitive-4xx list as the single rule. `PayPalFailure.ambiguous` is extra information, not the decider.

## Phase 2 implementation decisions (as built)

M7 Phase 2 (Tasks 1–20) is implemented on `feat/m7-annual-plan`. Live acceptance and deployment (Tasks 22–23) are still outstanding. Where the Phase 2 plan and the code differ, the code and the notes below are authoritative.

### Locked-in decisions

1. **Pre-revise failures fail the proposal.** Until the first `revise`, nothing customer-facing has happened. A changed `paypal.plan_id`, a monthly plan on another product, a refused plan creation, or an unreadable or mismatched plan read-back each finish the proposal `failed`, with one recorded outcome per target ending "no offer was made". An orphan yearly plan is harmless, and the same action hash always reuses the same `PayPal-Request-Id`.
2. **Ambiguity follows the existing convention.** A failed subscription pre-read, a non-definitive `revise` failure (including HTTP 200 without a usable link), a mismatched returned `planId` and any storage failure leave the proposal `executing` with its claims kept and no retry (`ExecutionReconciliationRequired`). Definitive failures are exactly 400, 401, 403, 404 and 422, in the single `isDefinitiveFailure` rule extracted from `execute.ts` into `src/execution/outcomes.ts`.
3. **Open offer.** Any offer that is not a confirmed decline (pending, awaiting final check, invalid or switched) blocks another offer to the same subscriber. The check runs when the proposal is built, in the claim, and just before `revise`.
4. **Export includes approval links.** `ledger:export` is the authoritative private backup, at the same trust level as the hosted session fingerprints it already holds. Dropping links would change row hashes and make restored open offers unservable. The export and import CLIs print only counts and hashes. The importer refuses any ledger where a link, or a `ba_token`, appears outside `annual_offers.approval_url`.
5. **Links are served only while the window is open.** The administrator endpoint returns drafts only for `pending` offers. After the window the UI says "offer window closed", never that a link is dead.
6. **Execution record.** Each `revise` writes one `executions` row with operation `POST subscription revise (annual plan)` and `verified = 0`, because the switch is verified only by a later read-back. Its outcome carries `offer: { annualPlanId, expiresAt }`. `UNIQUE (proposal_id, target_id, operation)` makes a second record for the same target impossible.
7. **Offer window.** The merchant chooses it when preparing the offer (whole days, default 7, range 1–30) and it is bound into the hash. The agent uses the default.
8. **Snapshot compatibility.** `ObservedSnapshot.annual` is optional, so recorded agent streams that predate it stay valid. The discount `changes` cap stays `.max(2)`.

### Where the build differs from the Phase 2 plan

- **Failed PayPal reads refuse a proposal outright.** Preparation refuses before any subscriber read unless PayPal is configured and the registered monthly plan reads back on the registered product. Failed or thrown reads of individual pilots are skipped, never guessed.
- **The agent passes its abort signal** (`budget.signal`) to `proposeStrategy`, so a cancelled or timed-out run stops preparation before a proposal is stored.
- **The links endpoint rejects cross-site reads and is never cached.** `GET /api/annual-offers/links` returns `403 CROSS_SITE_REQUEST` when `Sec-Fetch-Site` is present and not `same-origin` (clients that send no header still pass the administrator guard). Every response, including the fixed 500 body, carries `Cache-Control: no-store`, and the route logs nothing.
- **Refusals carry a `refused` marker** (`"annual_plan"` or `"plan_unknown"`) in the target outcome. Price changes, reverts and resets refuse a subscriber on a recorded yearly plan, or whose plan PayPal did not report while yearly plans exist, before any PATCH. This is a definitive per-target failure, not a reconciliation, and `previewDemoReset` skips these subscribers rather than resetting them.
- **Status refresh returns `annualEvidence`.** `GET /api/paypal/status` appends the offer reads, then returns counts and per-segment uptake changes built from them (no links). The evidence panel prefers it over the page-load value, so no separate twin fetch is needed.
- **Drafts are cleared on sign-out.** The offers panel keeps draft messages only in client state tied to the administrator session and the status refresh; sign-out or any failed refetch hides them at once.
- **`offerExpiry` takes no PayPal expiry.** The merchant window is the only expiry (PayPal gives none).
- **The price-check script verifies the plan with PayPal.** `scripts/paypal-check.ts` reads the subscriber's plan with PayPal and proceeds only when it reads back as monthly. It also refuses a subscriber on a recorded yearly plan or whose plan PayPal did not report.

### Operator rules

- **Unresolved target.** A `revise` result that is ambiguous, including HTTP 200 without a usable link, leaves the proposal `executing` with its claims. The target's execution record says "do not retry". See the runbook section "Annual offers: unresolved targets and links".
- **Unstored issued offer or ambiguous revise.** An issued offer that could not be stored, or an ambiguous revise, leaves the proposal `executing` with claims kept. No tool finishes an `executing` proposal yet (true of every action type), so reconcile by hand using the runbook steps.
- **Late approval still counts.** A stale link may still be approved at PayPal after the window closes, because PayPal does not end it. Reads continue, so a late switch is recorded and counts as accepted.
- **Offers cannot be withdrawn.** There is no cancel or revoke for an issued offer, and a switched customer is never moved back automatically.

### Rollout order for Tasks 22–23

1. Take the private backup from a `main` worktree **before** running setup for Pilot E against Turso, because setup creates the new tables (`CREATE TABLE IF NOT EXISTS`).
2. After that, `main`'s `ledger:export` refuses the hosted ledger (exact schema match) until this branch is deployed. An export refused for a stored link names the table and column.
3. Then run Pilot E setup (one buyer approval), live acceptance, and push/merge/deploy.

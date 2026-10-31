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

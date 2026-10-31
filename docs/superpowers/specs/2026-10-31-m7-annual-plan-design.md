# M7: Annual-plan offers, design

**Status:** approved in brainstorming on 2026-10-31. Parent design: `2026-10-22-aurrery-design.md` (§3a, the two-part payoff).

## Goal

Make the annual prepay plan, the twin's strategic lever, a real PayPal action. The merchant approves an exact offer. Aurrery creates a yearly plan, asks PayPal to switch each targeted subscriber to it, and tracks each customer's decision by reading PayPal back. Resolved offers become evidence for the twin's annual-uptake estimate.

**Done when:** on the hosted demo an administrator approves an annual offer. The sandbox customer approves Pilot E's link, and the app shows E **switched (verified by PayPal)**, D pending or expired, and the uptake evidence update. Tests, CI, deploy and a browser check all pass.

## PayPal facts and the first check

- `POST /v1/billing/subscriptions/{id}/revise` with a new `plan_id` requires buyer consent and returns an approval link.
- The old and new plans must belong to the **same product** (`PLAN_PRODUCT_NOT_COMPATIBLE`) and use the **same currency** (`CURRENCY_MISMATCH`).
- Changing the billing frequency is not among the documented rejection reasons.
- **Task 1 is a live sandbox check:**
  1. Create a yearly plan under Ridgeline's product.
  2. Call `revise` on a pilot.
  3. Approve as the sandbox customer.
  4. Record: whether monthly → yearly is accepted, the approval link's format and any expiry, when `plan_id` changes on read-back, and charge timing.

  If PayPal refuses the switch, **stop and redesign** before further work.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | Execute, track and learn |
| Structure | **Approach A.** The proposal succeeds when offers are issued; a separate offer tracker follows each customer. The hardened proposal state machine is unchanged. |
| Offer window | Per proposal, default 7 days, range 1–30, bound into the action hash. **Amended (decision 0008):** PayPal gives no link expiry, so the window is the only expiry; a link's real lifetime is untested. |
| Links | Administrators only, inside a display-only draft customer message with a copy button. Visitors see status only. |
| Discount budget | Applies to **retention discounts only** (`targeted_discount`). The annual plan's prepay discount is netted in total value and still displayed; the chance-worse rule still applies. |
| Demo targets | Add **Pilot E** (core, other reason) to the cohort. Annual strategies target every eligible pilot in their segments, so D and E both receive offers. Only E is approved. D stays pending and then shows "awaiting final check"; it counts as declined only after its deadline plus 6 hours and a confirming read, which likely falls outside the live demo. |

## Action: `annual_plan_offer`

A new member of the proposal action union, validated strictly and bound by SHA-256 hash.

**Payload fields:**
- `productId` (Ridgeline's catalog product)
- `currency: "USD"`
- `annualPrice`: list × 12 × (1 − discountPct), as a two-decimal string
- `discountPct`
- `offerWindowDays` (1–30)
- `targets[]`, each `{ subscriptionId, registration: { label, segment, reason, createdAt } }`, the same registration snapshot as the recovery actions use
- **Amended 2026-10-31 (Task 4 review):** `monthlyPlanId` and `listPrice` sit at action level, not per target, because eligibility requires every target to be on the one registered monthly plan at list price. Phase 2's per-target re-check compares each subscription's live `plan_id` and its price, by cents, against these action-level values.

**Eligibility, at build time and again just before each `revise` call:**
- registered pilot in one of the strategy's segments;
- ACTIVE;
- current price equals the list price, by strict cents comparison. This also excludes anyone on an active discount, which matters because a plan switch drops price overrides. A leftover `planOverridden` flag at list price does not block eligibility.
- on the original monthly plan: `plan_id` equals the registered monthly plan in ledger setting `paypal.plan_id`;
- no unresolved claim.

**Lifecycle:** the existing exact-hash admin approval → claim → execute flow, with no changes to the state machine or claims.

**Execution:**
1. **Ensure the plan:**
   - `createBillingPlan`, with `PayPal-Request-Id` derived from the action hash: one `YEAR` interval, one REGULAR cycle (infinite), fixed price `annualPrice`, the same product and currency.
   - Read the plan back and require ACTIVE plus the exact price and interval.
2. **For each target:**
   - Re-check eligibility.
   - Call `revise({ plan_id })` **at most once** per target. **Amended (decision 0008):** `revise` takes no request ID and mints a new token on every call, so an uncertain outcome is reconciled by read-back, never retried.
   - Store the approval link and expiry in `annual_offers` in the same transaction as the execution record and audit entry.
3. **Finish:**
   - **succeeded:** every offer was issued.
   - **partially failed / failed:** at least one definitive 4xx or skip.
   - An ambiguous PayPal or storage acknowledgement leaves the proposal **executing** with its claims kept, for operator reconciliation. There is no automatic retry.

## Offer tracker

**Table `annual_offers`:**
- `id`, `proposal_id`, `subscription_id`, `segment`, `annual_plan_id`
- `approval_url` (secret)
- `offered_at`, `expires_at`
- plus an append-only table `annual_offer_reads (offer_id, observed_at, status, plan_id, debug_id)`

**Status is derived, never stored as truth:**
- **switched:** any recorded read shows ACTIVE on `annual_plan_id`, even after expiry.
- **expired:** `now ≥ expires_at` with no switched read. This is a UI state, not evidence.
- **invalid:** the stored deadline can't be parsed. It is shown to admins and excluded from learning.
- **pending:** otherwise.

**Learning outcome (amended 2026-10-31, Task 5 review):** "expired" is not the same as "declined". Reads happen only on page loads, and PayPal can take minutes to show an approval, so a customer who approved near the deadline would otherwise be counted as a decline.
- **accepted:** switched.
- **declined:** only when `now ≥ expires_at + 6h grace` **and** a valid read observed at or after `expires_at + 6h` shows the subscription is not on the annual plan.
- **unresolved:** pending, invalid, or expired without that confirming read (shown as "awaiting final check").

**Reads:** the existing read-only PayPal status refresh (page load and "Refresh from PayPal") also GETs subscriptions whose offers are pending, invalid **or expired but not yet confirmed declined**, and appends reads. **Amended (final Phase 1 review):** every successful GET of a subscription that has offers appends a read for each of its offers, even after a confirmed decline, because a stale link can still be approved; a later switch then wins. Timestamps must be ISO-8601 instants with `Z` or an offset. There is no background job. Webhooks are not required for correctness.

## Learning

Per segment, from resolved offers only:

`annualUptake[segment]` = Beta(α₀ + accepted, β₀ + declined)

- Unresolved offers (pending, awaiting final check, invalid) are ignored.
- The update is applied on a copy of the twin in the observed-merchant read path, next to the discount evidence.
- Provenance key `segments.<segment>.annualUptake`, the existing per-segment convention that the stress test reads, becomes `observed`, with a note such as "Core uptake prior updated with 1 accepted of 1 resolved offer (sandbox demonstration)".
- The evidence panel adds "Annual offers: accepted · declined · awaiting decision or final check" counts.

## UI and agent

- **`isExecutable`** includes `annual_plan`. `chooseHeadline`'s budget check uses only `targeted_discount` strategies' discount cost.
- **The headline adds "Also executable within your rules"**, listing other qualifying executable strategies. Expected default: the headline is the annual plan, the save offer is listed as also executable, and the price rise is the only bigger lever.
- **The approval card for annual offers** shows the yearly price, product, offer window, targets, hash and unchecked confirmation, with the statements "each customer must agree in PayPal" and "switched customers can't be moved back automatically".
- **"Annual offers" panel:**
  - **Everyone sees:** per-target status and expiry.
  - **Administrators also see:** the draft customer message with the link and a copy button, via a new admin-guarded endpoint.
  - The public status payload never contains links.
- **Agent:** remove "annual plans are simulation only" from its instructions. `recommend` may create an `annual_plan_offer` proposal. The agent still cannot approve or execute.

## Ledger tools

- **Export and import** include both new tables with strict validation: action/offer links, hash, and no links in logs.
- **Admin price reset** skips subscriptions on an annual plan and reports "switched to annual by customer choice; not reset".
- **`paypal:setup`** adds Pilot E using the existing creation and recovery rules; this needs one buyer approval.

## Safety

- Approval links are secrets: never logged, never in public responses, errors or visitor-visible UI.
- A switched customer is never moved back automatically.
- There is no "withdraw offer" in M7; offers expire.
- Only facts verified by PayPal read-back count as evidence.

## Testing

1. **Live sandbox check:** see "PayPal facts and the first check".
2. **Offline tests:**
   - action schema and hash;
   - eligibility, including discount and claim conflicts;
   - execution against a fake PayPal: success, partial failure, ambiguous response, skip;
   - plan creation retried safely (same request ID);
   - offer status worked out from read sequences, including a late acceptance;
   - Beta update arithmetic and provenance;
   - link secrecy in route tests;
   - export/import round trip;
   - reset skip;
   - headline choice and the "also executable" list;
   - agent proposal of an annual plan.
3. **Live acceptance:**
   - Run setup for Pilot E.
   - Approve as administrator on the hosted demo, then approve E's link as the sandbox customer.
   - Check that the refresh shows E switched, D pending, and the evidence update.
   - Full suite, CI, deploy and browser check.

## Out of scope

- Emailing links.
- Withdrawing offers.
- Moving customers back automatically.
- Subscribing webhooks to `BILLING.SUBSCRIPTION.UPDATED`.
- Annual-plan renewal modelling beyond the existing twin.

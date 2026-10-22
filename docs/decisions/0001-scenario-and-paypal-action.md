# 0001: Subscription retention scenario, executed by per-subscription price override

**Status:** accepted (2026-10-21); verified against PayPal Sandbox on 2026-10-22: `op=replace`, read-back via `GET ?fields=plan` shows the override and a subsequent GET confirms restoration.

## Context

The product must connect simulation to a real PayPal action that the merchant can approve and the system can verify, without depending on buyers acting during the demo.

## Decision

- Scenario: a subscription merchant (specialty coffee, $24/month) whose at-risk subscribers churn about 16% a month.
- Executable action: `PATCH /v1/billing/subscriptions/{id}`, replacing `plan.billing_cycles[@sequence==1].pricing_scheme.fixed_price` for each targeted subscription. Per the API reference this is merchant-side, overrides survive plan changes, and billing within 10 days is unaffected.
- Rejected as the primary action:
  - `revise`: switching plans requires buyer consent.
  - `update-pricing-schemes`: changes the price for every subscriber on the plan, which is too broad for targeted retention. It stays as a simulated strategy.
  - Orders, Payouts, Invoicing: these don't express a retention intervention.
- Annual prepay plans are simulated now and become executable later through plan creation plus buyer-approved revise links.
- Model the discount as applied to every targeted subscriber (no opt-in), so its cost includes subscribers who would have stayed. This matches the PayPal action.

## Consequences

The twin can show that a tempting discount is roughly break-even. That is a credible, non-obvious result and the core of the pitch. The pilot cohort is a handful of real sandbox subscriptions; the 2,400-subscriber population is synthetic and labelled as such.

## Verified request and read-back

`npm run paypal:check` tested the active loyal Pilot D, leaving the hero pilots unchanged:

- `PATCH /v1/billing/subscriptions/{id}` with `op: "replace"`, path `/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price`, value `{ "currency_code": "USD", "value": "23.45" }` returned HTTP 204 (debug ID `f94979507855c`).
- `GET /v1/billing/subscriptions/{id}?fields=plan` returned the new price (debug ID `f867777d15398`). The SDK exposes it at `plan.billingCycles[regular].pricingScheme.fixedPrice.value`; `planOverridden` changed from false to true.
- The restore PATCH returned HTTP 204 (debug ID `f584318e33fe2`). A separate GET confirmed `ACTIVE`, price `24.0`, and `planOverridden: true` (debug ID `f180521a4dd0a`). Restoring the amount does not clear the override flag.

The check reported `operation=replace verified=true restored=true`. No wrapper/default-operation changes were needed. Sandbox buyer approval for the full cohort is a separate prerequisite: B, C and D are active; Pilot A's approval loop remains under investigation.

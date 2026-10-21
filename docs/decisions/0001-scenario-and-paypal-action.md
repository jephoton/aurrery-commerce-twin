# 0001: Subscription retention scenario, executed by per-subscription price override

**Status:** accepted (2026-10-21), pending sandbox verification of the PATCH path.

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

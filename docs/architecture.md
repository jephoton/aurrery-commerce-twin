# Architecture

**Product:** Aurrery (repo `jephoton/aurrery-commerce-twin`). **Goal:** a subscription merchant states an objective, an AI agent proposes interventions, a digital twin simulates them under uncertainty, and the merchant approves one exact action, which is executed through PayPal Sandbox and read back. Target: PayPal AI Hackathon (deadline 2026-11-13 04:00 SGT). Judging criteria: technological implementation, design, potential impact, innovation, presentation.

## Modular monolith (Next.js 16, TypeScript)

| Module | Path | Responsibility | Depends on |
| --- | --- | --- | --- |
| Twin | `src/twin/` | Pure model: types, seeded RNG, interventions + guardrails (Zod), Monte Carlo simulation, Bayesian calibration and assumptions-only stress testing. No I/O. | nothing |
| Merchant | `src/merchant/` | Builds the twin for the current merchant (today: synthetic Ridgeline Roasters history → estimated parameters + labelled priors). | twin |
| Ledger | `src/ledger/` | SQLite (`node:sqlite`): sandbox subscribers, proposals state machine, executions, observations, audit events, kv settings. | twin types |
| PayPal | `src/paypal/` | Sandbox-only SDK client, typed wrappers (`getSubscription`, `overrideSubscriptionPrice`), error normalisation. | SDK |
| Execution | `src/execution/` | Runs an approved proposal: claim → PATCH each target → GET read-back → record → finish. | ledger, paypal |
| Agent | `src/agent/` (next) | Provider-independent tool-use loop: read state, propose strategies, call simulator, recommend, create proposal. **No execute tool.** | twin, ledger |
| API | `src/app/api/` | Thin route handlers with Zod validation. | all above |
| UI | `src/app/page.tsx`, `src/components/` | Dashboard: KPIs, objective, AG Grid comparison, fan chart, assumptions, approval, execution, pilot cohort. | API |

## Key invariants

AI provider selection is pending evaluation: Gemini first, then Groq, using the same classifier fixture and a tool-call smoke test before choosing the M2/M3 default. See [decision 0003](decisions/0003-ai-provider-evaluation.md). The classifier and agent have not been implemented; no provider runtime has changed.

- Only `POST /api/proposals/{id}/approve` reaches PayPal. It requires the proposal's action hash, and execution is claimed atomically (`UPDATE … WHERE status='approved'`), so it happens at most once.
- Proposal predictions are recomputed server-side; client numbers are never trusted.
- Targets come from registered sandbox subscriptions matching the strategy's segment and assessed reason (or `any`), retaining registration order and capped at 25 per action.
- The PayPal client is hard-wired to `Environment.Sandbox`.
- Execution records what PayPal reports on read-back (`verified` = read-back price equals the requested price), not what was requested.

## Model summary

**Cohorts.** Monthly cohorts by segment (`new`, `core`, `price_sensitive`, `at_risk`, `cancel_intent`) × leaving reason (`price`, `other`) × plan (monthly or annual) × discount state (`offer`, `offered`, `rebound`).

**Each month:**
1. Acquisition: Poisson, price-elastic, split by reason. Campaign offers apply here if the target segment is `new`.
2. Billing and fulfilment.
3. Voluntary churn: segment hazard × price elasticity, or × the reason's discount relative risk while discounted, × the post-discount spike.
4. Involuntary churn, applied to voluntary survivors.
5. Discount and annual countdown.
6. Segment transitions:
   - `new` → `core` or `price_sensitive`
   - `core` and `price_sensitive` → `at_risk`
   - `at_risk` → `core` (recovery first), then → `cancel_intent` (escalation)
   - `cancel_intent` → `at_risk`

**Reasons.** Reason affects discount response and targeting, not baseline churn. Reasons persist across moves, except that entrants to `cancel_intent` are re-split with that segment's price share, because reasons are assessed in the cancel flow. Targeting `reason: "price"` is only valid for `cancel_intent`.

**Calibration and execution boundary.** Aggregate `any` outcomes are skipped by calibration; known assessed per-pilot reasons can update their own posterior. PayPal proposals snapshot today's matching pilots only, with reason and campaign duration bound into the action hash; future entrants need separate approvals. See [decision 0002](decisions/0002-reason-specific-calibration.md).

**Targeted discounts are save-offer campaigns.**
- With `campaignMonths: 0` they reach today's stock only. With N > 0 they also reach entrants for N months, capped at the horizon.
- Each subscriber gets one offer; flags reset after the window.
- `discountedSubscribers` counts recipients.

**Decision metric.** **Total value** is 12-month gross profit plus the value of the base remaining at month 12.
- That value is the discounted margin over the next 24 months, propagating expected segment moves with a per-run `tailValuer`. It is checked against the simple reference `tailValue`.
- Short-term wins that shrink the base are therefore penalised, and saved subscribers are credited with likely recoveries.

**Common random numbers.** Every random draw is keyed by month, event, segment, reason and discount state, so subscribers an intervention doesn't touch draw identical randomness under every strategy. Exact tests pin this.

## Stress scenarios and inspection

`src/twin/stress.ts` exports `stressParams`, `stressTest` and `StressResult`. The pure parameter transform is combined with provenance checks in `stressTest`: only assumptions shift, with exact parameter provenance taking precedence over group provenance. Observed/estimated evidence, including calibrated reason-specific discount effects, stays intact. Historical churn, transitions, acquisition estimates and reason shares remain unchanged.

Means shift adversely by 0.8416 standard deviations, approximating an adverse 80th/20th percentile scenario; Beta/Gamma shifts are not exact quantiles. Normal/Gamma spread and Beta concentration are preserved. Discount retention weakens and post-offer churn rises; annual uptake falls; price sensitivity rises for increases and falls for cuts. Baseline and unchanged list prices have no shifts. Explanations include only shifts actually made. Base/stressed simulations share options and seed, each evaluated against its own do-nothing baseline.

`scripts/inspect-twin.ts` builds the demo twin and uses the exported merchant starter strategies without model overrides. It prints initial cohorts, churn means, simulation options, value-change p10/p50/p90, downside probability, mean discount cost and stress explanations. Defaults are 1,000 runs, 12 months and seed `20261113`, repeatable with unchanged code/data. Verified base → stressed median Δ values: broad campaign −$1,425 → −$2,510; price-driven cancel save +$105 → −$91; annual prepay +$10,357 → +$5,006; list $22 −$56,757 → −$76,611; list $27 +$62,695 → +$28,669. Full intervals and probabilities are in `docs/current-state.md`.

The two-part hero story pairs the modest tactical save offer with annual prepay as the strategic lever. The current approval path executes today's price-override pilots; annual-plan execution remains required M7 work. Legacy proposals without reason/campaign fields have no migration and may display incorrect fallback/undefined metadata; new proposals carry both. Full browser UI verification remains outstanding.

## Commands

See `README.md` (`npm run dev | test | typecheck | lint | build | twin:inspect | paypal:setup | paypal:sync | paypal:check`).

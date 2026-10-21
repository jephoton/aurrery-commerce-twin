# Architecture

**Product goal:** a subscription merchant states an objective, an AI agent proposes interventions, a digital twin simulates them under uncertainty, and the merchant approves one exact action, which is executed through PayPal Sandbox and read back. Target: PayPal AI Hackathon (deadline 2026-11-13 04:00 SGT). Judging criteria: technological implementation, design, potential impact, innovation, presentation.

## Modular monolith (Next.js 16, TypeScript)

| Module | Path | Responsibility | Depends on |
| --- | --- | --- | --- |
| Twin | `src/twin/` | Pure model: types, seeded RNG, interventions + guardrails (Zod), Monte Carlo simulation, Bayesian calibration. No I/O. | nothing |
| Merchant | `src/merchant/` | Builds the twin for the current merchant (today: synthetic Ridgeline Roasters history → estimated parameters + labelled priors). | twin |
| Ledger | `src/ledger/` | SQLite (`node:sqlite`): sandbox subscribers, proposals state machine, executions, observations, audit events, kv settings. | twin types |
| PayPal | `src/paypal/` | Sandbox-only SDK client, typed wrappers (`getSubscription`, `overrideSubscriptionPrice`), error normalisation. | SDK |
| Execution | `src/execution/` | Runs an approved proposal: claim → PATCH each target → GET read-back → record → finish. | ledger, paypal |
| Agent | `src/agent/` (next) | Claude tool-use loop: read state, propose strategies, call simulator, recommend, create proposal. **No execute tool.** | twin, ledger |
| API | `src/app/api/` | Thin route handlers with Zod validation. | all above |
| UI | `src/app/page.tsx`, `src/components/` | Dashboard: KPIs, objective, AG Grid comparison, fan chart, assumptions, approval, execution, pilot cohort. | API |

## Key invariants

- Only `POST /api/proposals/{id}/approve` reaches PayPal. It requires the proposal's action hash, and execution is claimed atomically (`UPDATE … WHERE status='approved'`), so it happens at most once.
- Proposal predictions are recomputed server-side; client numbers are never trusted.
- Targets come from registered sandbox subscriptions in the strategy's segment, capped at 25 per action.
- The PayPal client is hard-wired to `Environment.Sandbox`.
- Execution records what PayPal reports on read-back (`verified` = read-back price equals the requested price), not what was requested.

## Model summary

Monthly cohorts by segment (`new`, `core`, `price_sensitive`, `at_risk`) × plan (monthly/annual) × discount state. Each month: acquisition (Poisson, price-elastic), billing and fulfilment, voluntary churn (segment hazard × price elasticity, or × discount relative risk), involuntary churn, discount/annual countdown (with post-discount rebound), and segment transitions. The decision metric is **total value**: 12-month gross profit plus the discounted margin of the remaining base over the next 24 months, so short-term wins that shrink the base are penalised.

## Commands

See `README.md` (`npm run dev | test | typecheck | lint | build | twin:inspect | paypal:setup | paypal:sync`).

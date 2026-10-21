# Current state

_Last material update: 2026-10-21._

## Done

- Digital twin engine (`src/twin/`) with Monte Carlo, common random numbers, total-value metric, and Gamma–Poisson feedback update; 11 tests.
- Synthetic demo merchant with parameters estimated from generated history; unidentifiable parameters are labelled priors.
- Ledger + proposal state machine (hash-bound approval, single execution); 6 tests.
- PayPal Sandbox adapter (official server SDK) and execution service with read-back verification.
- Setup script for the sandbox product, plan, and pilot subscriptions.
- Dashboard UI with AG Grid comparison, fan chart, assumptions panel, approval, execution result, and live pilot cohort.
- Verified: `npm test` (17 passing), `tsc`, `eslint`, `next build`, and API smoke tests against `next start`.

## Not yet verified

- **PATCH price override in the real sandbox.** Path format `/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price` with `op: replace` comes from the API reference and a mirror example. It needs a live run with credentials, and `add` may be required when no override exists yet. Also confirm that `GET ?fields=plan` returns the overridden price.
- The UI has not been checked in a browser yet.

## Next steps

1. Spike: add sandbox credentials → `npm run paypal:setup` → approve as sandbox buyer → execute a proposal → confirm read-back.
2. AI agent (`src/agent/`): Claude tool use with `get_merchant_state`, `simulate_strategies`, `create_proposal`; streaming reasoning in the UI.
3. Revert action (discount expiry as a second approved proposal) and the observed-outcome → posterior update shown in the UI.
4. Annual-plan execution (create plan + revise links that need buyer consent).
5. Deploy (Render is a sponsor prize, and a hosted demo helps judges), then record a demo video under 3 minutes.

## Known risks

- Elasticity, discount effect, and annual uptake are priors, so price-change results are assumption-driven. The UI labels them, and the agent must say so.
- `node:sqlite` is experimental in Node 24 (prints a warning). Hosted deployments need a persistent disk or a re-seed step.

# Current state

_Last material update: 2026-10-22._

Project: **Aurrery** (repo `jephoton/aurrery-commerce-twin`, public). Design: `docs/superpowers/specs/2026-10-22-aurrery-design.md`. Roadmap: `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md`. Active task plan: `docs/superpowers/plans/2026-10-22-m0-m1-rename-paypal-twin-v2.md`, including its amendment at the bottom.

## Branches

| Branch | Contents | Status |
| --- | --- | --- |
| `main` | Create Next App scaffold only | pushed; foundation not merged yet |
| `feat/digital-twin-foundation` | foundation: twin engine, ledger, PayPal adapter, API, UI, docs, spec, roadmap | pushed |
| `chore/m0-rename-paypal-check` | M0 Tasks 1–3 (Steps 1–3) | local, not pushed |
| `feat/m1-twin-v2` | branched from the M0 tip; M1 work | local, not pushed; **current** |

## Done

- **Foundation:** cohort Monte Carlo twin with common random numbers and the total-value metric; synthetic demo merchant estimated from generated history; SQLite ledger with hash-bound, execute-once approvals; sandbox-only PayPal adapter with read-back; API routes; dashboard with AG Grid.
- **M0 Task 1:** renamed to Aurrery (package, UI, README, PayPal request-ID prefixes `aurrery-ridgeline-*`).
- **M0 Task 2:** each pilot sandbox subscription has a segment and a leaving reason. The pilot cohort is 2 cancel-intent/price, 1 cancel-intent/other, 1 core/other. The ledger migrates older databases.
- **M0 Task 3, Steps 1–3:** `npm run paypal:check` tooling, made safe to re-run after review:
  - defaults to the core pilot
  - refuses if a subscription is stuck at the test price
  - fails loudly if the restore fails
  - tries `add` only after a 400/422 on `replace`
- **M1 Task 4:** `cancel_intent` segment with at-risk ⇄ cancel-intent transitions, estimated from history with destination-level `movedTo`. Estimators are checked against exact exposure counts.
- **M1 Task 5 (implemented, spec-reviewed; quality review pending):** leaving reasons (`price`/`other`) on cohorts, reason-specific discount effect (Gamma priors), targeting by reason, re-split of reasons on entry to cancel intent, per-reason Bayesian update.

All checks pass on `feat/m1-twin-v2` (22 tests, typecheck, lint).

## In progress

- **M0 Task 3, Step 4 onward:** blocked on Jethro creating the PayPal Sandbox REST app (Merchant type). The dashboard errored without a sandbox business account selected. Then `npm run paypal:setup`, approve the 4 pilots as a sandbox personal account, then `paypal:sync` and `paypal:check`.
- **M1 Tasks 5b–8,** in this order:
  - **5b:** the value of subscribers still active at month 12 includes their expected segment moves. Today's version undervalues saved cancel-intent subscribers.
  - **5c:** save-offer campaigns (`campaignMonths`). Entrants to the targeted segment also get the discount. The hero-versus-broad comparison test lives here.
  - **6:** stress test.
  - **7:** proposals target by reason, plus validating reasons read from the ledger.
  - **8:** story check and docs.

## Decisions made during M1

- **Hero action is an ongoing save-offer policy,** not a one-off (Jethro, 2026-10-22). A one-off discount to the ~18 subscribers in cancel intent at month 0 is noise-level. In PayPal, approving executes for today's matching pilots; later entrants need their own proposals.
- **Leaving reasons are assessed when someone tries to cancel,** so entrants to cancel intent take that segment's reason mix.
- **No tuning of parameters to make the story work.** If the precision campaign doesn't beat the broad one under honest assumptions, stop and revisit the story.

## Not yet verified

- The PATCH price override against the real sandbox: `replace` vs `add`, and whether `GET ?fields=plan` shows the override.
- The UI has not been checked in a browser.

## Next steps

M1 Tasks 5b–8, then finish M0 Task 3, then M2 (feedback corpus and classifier). See the roadmap.

## Known risks

- Price sensitivity, discount effect, annual uptake and price-reason shares are priors, so results that depend on them are assumption-driven. The UI labels them and the agent must say so.
- `node:sqlite` is experimental in Node 24 (prints a warning). Hosted deployments need a persistent disk or a re-seed step.
- `main` on GitHub shows only the scaffold until the foundation is merged. GitHub detects the license only on the default branch, and the hackathon wants it visible.

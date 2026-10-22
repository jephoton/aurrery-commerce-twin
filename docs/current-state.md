# Current state (handoff)

_Last material update: 2026-10-22. Execution resumed; **M1 Task 6 passed independent spec-compliance and code-quality reviews; Task 7 is in progress**._

**Project:** **Aurrery**, a digital twin plus AI agent for subscription merchants that executes approved actions through PayPal Sandbox. Repo: `jephoton/aurrery-commerce-twin` (public). Hackathon deadline: 2026-11-13 04:00 SGT.

**Read in this order:**
1. `docs/superpowers/specs/2026-10-22-aurrery-design.md`: the design, including §3a, the story revision.
2. `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md`: milestones in order.
3. `docs/superpowers/plans/2026-10-22-m0-m1-rename-paypal-twin-v2.md`: the active task plan. Read its two amendments and the "Task 5c as built" and "Carry-forward for Task 7" notes at the bottom.
4. `docs/architecture.md`: modules and the model.

## Branches

| Branch | Contents | Pushed? |
| --- | --- | --- |
| `main` | Create Next App scaffold only | yes (foundation not merged) |
| `feat/digital-twin-foundation` | foundation, spec, roadmap, plans | yes |
| `chore/m0-rename-paypal-check` | M0 Tasks 1–3 (Steps 1–3) | **no** |
| `feat/m1-twin-v2` | branched from the M0 tip; M1 Tasks 4–6, plus docs | **no**; **continue here** |

Task 6 verification: `npm test` (46 passing), `npm run typecheck`, and `npm run lint` pass. The build last passed after Task 5c; it was not rerun for the pure stress-test module. Test output still includes the Vite config-format warning and Node's experimental SQLite warning.

## M1 Task 6 implementation (reviews passed)

`src/twin/stress.ts` exports `stressParams` and `stressTest`. The pure transform moves intervention-specific assumption means adversely by 0.8416 standard deviations, preserving Normal/Gamma spread and Beta concentration. This approximates an adverse 80th/20th percentile scenario; Gamma and Beta shifts are not exact quantiles. Discounts have weaker retention and more post-offer churn; annual uptake falls; price sensitivity rises for increases and falls for cuts. Baseline and unchanged list prices produce no shifts.

`stressTest` runs base and stressed comparisons with the same options and seed, each against its own do-nothing baseline. It only shifts parameters explicitly marked as assumptions, retaining observed or estimated evidence (including calibrated reason-specific discount effects); exact parameter provenance takes precedence over group provenance. Historical churn, transitions, acquisition estimates and reason shares remain unchanged. Returned explanations list only shifts actually made. Eleven new tests cover the transforms, immutability, calibration preservation and adverse strategy comparisons. Spec-compliance and code-quality reviews passed independently.

## Done (each task passed a spec-compliance review and a code-quality review)

| Task | What | Key commits |
| --- | --- | --- |
| M0-1 | Renamed to Aurrery; PayPal request-ID prefixes are now `aurrery-ridgeline-*` | `d4a1c81` |
| M0-2 | Pilot sandbox subscriptions carry a segment and a reason; the ledger migrates older databases; 4-member pilot cohort | `94bf2cd` |
| M0-3 (Steps 1–3) | `npm run paypal:check` tooling, safe to re-run (defaults to the core pilot, refuses a stuck test price, fails loudly on a failed restore) | `625ca41`, `5c1673c` |
| M1-4 | `cancel_intent` segment with escalation and de-escalation, estimated from `movedTo` history; estimators pinned by exact tests | `5fffb48`, `41f65ae` |
| M1-5 | Leaving reasons; per-reason discount effect; price-reason targeting limited to cancel intent; per-reason Bayesian update | `da4bdc5`, `dbac210` |
| M1-5b | Month-12 subscribers valued with their expected segment moves and the post-discount spike; fast per-run valuer | `065cae4`, `c9841d4` |
| M1-5c | Save-offer campaigns (`campaignMonths`), one offer per subscriber, `discountedSubscribers`; exact tests for alignment of random numbers, counts and month boundaries | `bd61cc9`, `edbe0d1` |

## Current honest results (1,000 runs, value change vs doing nothing)

| Strategy | Median Δ value | Chance worse than doing nothing |
| --- | --- | --- |
| Broad at-risk 20%, 6-month campaign | −$1,425 | 0.76 |
| Cancel-flow save offer (price-driven, 25%, 6-month campaign) | +$105 | 0.42 |
| Annual prepay at 15% off | +$10,357 | 0.00 |
| Cut list price to $22 | −$56,757 | 1.00 |
| Raise list price to $27 | +$62,695 | 0.00 (assumption-driven) |

Story decision (Jethro): a **two-part payoff**. The save offer is the tactical move and the annual plan is the strategic lever, both executed via PayPal. M7 (annual plan) is now part of the hero path; M6 (CSV) is the only cut candidate.

## Next steps (in order)

1. **Finish M1** on `feat/m1-twin-v2`:
   - **Task 6:** implementation complete; run spec-compliance and code-quality reviews, then address any findings.
   - **Task 7:** proposals target by reason, plus the carry-forward items in the plan: `campaignMonths` in the action, executing only today's pilots, a UI note, validating reason on read, and the calibration decision.
   - **Task 8:** story check and docs, using Amendment 2's acceptance criteria.
   - Same process as before: implementer, then spec review, then code-quality review. Update this file after each task.
2. **Finish M0 Task 3, Step 4 onward.** This needs Jethro: create the PayPal Sandbox REST app (type **Merchant**) with a sandbox **business** account selected; create a sandbox **personal** account too.
   - The app creation failed earlier, probably because no business account was selected.
   - Then run `npm run paypal:setup`, approve the 4 links as the personal account, and run `npm run paypal:sync` and `npm run paypal:check`.
   - Act on the result per the plan, then record the verified request shape in `docs/decisions/0001-*.md`.
3. **Merge and push.** Merge M0 and M1 into `main` (this also makes the LICENSE visible on GitHub), then push.
4. **M2 onward,** per the roadmap: signals and classifier, agent, UI, hosting, then M7 annual plan, M6 CSV, and submission.

## Known issues and follow-ups

- **The hero proposal targets the wrong pilots until Task 7.** `buildAction` doesn't filter by reason yet, so the hero would also discount Pilot C ("other" reason). Don't approve hero proposals before Task 7 lands.
- **The UI is unverified.** It hasn't been checked in a browser since the foundation. `STARTER_STRATEGIES` now contains campaign strategies.
- **Optional test improvements from the 5c review:**
  - decouple test (d) from the `m0:acq` stream key, using `runOnce(...).newSubscribers`;
  - add a move-entrant boundary check (cancel_intent/"any": campaign 1 should match campaign 0);
  - add a horizon-cap test.
- **Assumption-driven priors:** price sensitivity, discount effect (which doesn't scale with discount depth), annual uptake and price-reason shares are all priors. Price-reason shares should come from the M2 classifier.
- **Reason shares drift over the horizon** for segments other than cancel intent (documented).
- **`node:sqlite` is experimental in Node 24** (prints a warning). Hosting needs a persistent disk or a re-seed step.
- **Don't change the `aurrery-ridgeline-*` request-ID prefixes** after the first real PayPal setup run; that would create duplicates.

## Decisions log (M1)

- **Hero is an ongoing save-offer policy,** not a one-off. In PayPal, approval executes for today's matching pilots; later entrants need their own proposals.
- **Reasons are assessed in the cancel flow,** so only cancel intent supports price targeting.
- **No tuning of parameters for the story.** The only prior change, tightening the "other"-reason discount prior after review, made the broad strategy look *better*.
- **Two-part payoff story** (see the spec, §3a).

## Starter-strategy schema regression

Shortened the hero strategy display name to satisfy the existing 80-character API limit. All actual starter strategies now pass the schema regression test (observed failing before the source fix, passing afterward). No simulation parameters changed.

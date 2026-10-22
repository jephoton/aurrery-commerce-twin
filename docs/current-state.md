# Current state (handoff)

_Last material update: 2026-10-22. Execution resumed; **M1 Tasks 6 and 7 passed independent spec-compliance and code-quality reviews; Task 8 story and verification are complete, with independent reviews pending**._

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
| `feat/m1-twin-v2` | branched from the M0 tip; M1 Tasks 4–8, plus docs | **no**; **continue here** |

Task 8 verification: `npm run twin:inspect` passes Amendment 2; `npm test` (53 passing across 5 files), `npm run typecheck`, `npm run lint`, and `npm run build` pass. Tests retain the Vite config-format warning and Node experimental SQLite warning; the build also prints the SQLite warning. No PayPal sandbox check, merge or push was performed.

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
| M1-6 | Assumptions-only adverse stress transform, paired simulations and calibration preservation | `f3de7b7` |
| M1-7 | Reason-targeted pilots, hashed campaign context, approval display and aggregate calibration policy | `440cbdd`, `6ae1208` |

## Current honest results (1,000 runs, value change vs doing nothing)

Canonical command: `npm run twin:inspect`, using `buildDemoTwin()` and `STARTER_STRATEGIES` with no model overrides. Defaults: 1,000 runs, 12-month horizon, seed `20261113`. The printed options make the run repeatable with unchanged code/data. Each stress comparison uses the same options and seed against its own do-nothing baseline. Amounts are rounded dollars; probabilities are printed to two decimals.

| Strategy | Δ value p10 | Median Δ value | Δ value p90 | Chance worse | Mean discount cost | Stressed median Δ value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Do nothing | $0 | $0 | $0 | 0.00 | $0 | — |
| Broad at-risk 20%, 6-month campaign | −$3,926 | −$1,425 | +$1,181 | 0.76 | $4,100 | −$2,510 |
| Cancel-flow save offer (price-driven, 25%, 6-month campaign) | −$487 | +$105 | +$766 | 0.42 | $570 | −$91 |
| Annual prepay at 15% off | +$5,390 | +$10,357 | +$17,962 | 0.00 | $8,859 | +$5,006 |
| Cut list price to $22 | −$73,233 | −$56,757 | −$38,204 | 1.00 | $0 | −$76,611 |
| Raise list price to $27 | +$34,558 | +$62,695 | +$89,799 | 0.00 | $0 | +$28,669 |

Amendment 2 passes: the save offer beats the broad campaign on median value and downside probability; annual prepay has positive median value; every starter strategy's stressed median is at most its base median. The save offer is modest and becomes negative under stress. The price-rise outcome remains assumption-driven; 0.00 is a rounded simulation frequency, not a guarantee. No model parameters were tuned.

Stress explanations: both discount campaigns assume weaker retention for each reason and more churn after offers expire; annual uptake falls across segments; price cuts attract fewer extra signups and prevent fewer cancellations; price increases deter more signups and cause more cancellations. Only assumptions shift; calibrated evidence stays intact. Mean shifts of 0.8416 standard deviations approximate an adverse 80th/20th percentile scenario, not exact Beta/Gamma quantiles.

Story decision (Jethro): a **two-part payoff**. The save offer is the tactical move and the annual plan is the strategic lever, both executed via PayPal. M7 (annual plan) is now part of the hero path; M6 (CSV) is the only cut candidate.

## Next steps (in order)

1. **Finish M1 Task 8 independent reviews** on `feat/m1-twin-v2`. Tasks 6 and 7 passed spec-compliance and code-quality reviews. Task 8 implementation, story check and verification are done; both reviews are pending.
2. **Finish M0 Task 3, Step 4 onward.** Credentials are being configured in ignored `.env.local`. A Sandbox REST app of type **Merchant** needs a sandbox **business** account; a sandbox **personal** account approves the pilots.
   - Run `npm run paypal:setup`, approve all 4 links as the personal account, then run `npm run paypal:sync` and `npm run paypal:check`.
   - Record the verified override/revert request shape in [decision 0001](decisions/0001-scenario-and-paypal-action.md) only after the sandbox check succeeds. This live check remains incomplete.
3. **Merge and push M0/M1 into `main`** after the check and reviews (also making LICENSE visible on GitHub). M0 and M1 remain local and unpushed.
4. **M2: Signals: feedback corpus and classifier.**
5. **M3: Agent: tool loop and streamed timeline.**
6. **M4: Product UI: headline card, orbit language, polish.**
7. **M5: Hosting and observed loop: Render, webhooks, revert, reset.** Then the roadmap's cut checkpoint.
8. **M7: Annual-plan execution** (required hero path; may precede M6).
9. **M6: CSV import** (optional; only cut candidate).
10. **M8: Submission: repo, write-up, video, QA.**

## Known issues and follow-ups

- **Reason targeting is resolved and reviewed.** The hero proposal now targets only price-driven cancel-intent pilots A and B; Pilot C is excluded.
- **Legacy proposal display:** proposals persisted before reason/campaign metadata were added have no migration; the UI can display an incorrect reason fallback and undefined campaign month. New proposals carry both fields and display correctly.
- **Annual-plan execution remains future M7 work.** Simulation exists; PayPal annual switching is not implemented.
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

## M1 Task 7 implementation (reviews passed)

Proposals filter today's registered pilots by segment and reason, retain registration order and the 25-target cap, and carry reason plus `campaignMonths` in the hashed action. No-target errors name both criteria. Stored reasons are validated with a warning and `other` fallback for invalid data. The approval card displays targeting, campaign context, and the requirement for separate approvals for later entrants.

The four-pilot regression cohort proves the price hero reaches A+B at $18.00; `any` reaches A+B+C and excludes core D. Tests cover metadata/hash binding, no matching reason, invalid persisted data, insertion order, cap, and the existing lifecycle. New proposal assertions were observed failing before implementation and passing afterward. The calibration contract now accepts aggregate `any` observations but skips them; its test first failed typechecking under the old contract and now passes, including mixed assessed evidence.

Task 7 passed independent spec-compliance and code-quality reviews. Task 8 subsequently verified all 53 tests, typecheck, lint, production build and the canonical story check. The Vite config-format and experimental SQLite warnings remain unchanged. Browser UI verification remains outstanding.

See [decision 0002](decisions/0002-reason-specific-calibration.md) for the calibration rationale and campaign execution boundary. No future webhook or campaign execution was added. Tasks 6 and 7 passed independent spec and quality reviews. Task 8 awaits both independent reviews.
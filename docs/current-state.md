# Current state (handoff)

_Last material update: 2026-10-22. **M0 and M1 are complete and reviewed. All four registered PayPal pilots are ACTIVE at $24; price override and restoration are verified on Pilot D. Aurrery runs on port 3001. M0/M1 are merged and pushed; the user has resumed M2 after adding both AI provider keys**._

**Project:** **Aurrery**, a digital twin plus AI agent for subscription merchants that executes approved actions through PayPal Sandbox. Repo: `jephoton/aurrery-commerce-twin` (public). Hackathon deadline: 2026-11-13 04:00 SGT.

**Read in this order:**
1. `docs/superpowers/specs/2026-10-22-aurrery-design.md`: the design, including §3a, the story revision.
2. `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md`: milestones in order.
3. `docs/superpowers/plans/2026-10-22-m0-m1-rename-paypal-twin-v2.md`: the active task plan. Read its two amendments and the "Task 5c as built" and "Carry-forward for Task 7" notes at the bottom.
4. `docs/architecture.md`: modules and the model.

## Branches

| Branch | Contents | Pushed? |
| --- | --- | --- |
| `main` | M0/M1, sandbox verification and reviewed recovery fixes | yes |
| `feat/m2-feedback-signals` | M2 design, reviewed corpus and classifier implementation pending review | yes through `9878193`; active |
| `feat/digital-twin-foundation` | foundation, spec, roadmap, plans | yes |
| `chore/m0-rename-paypal-check` | M0 Tasks 1–3 (Steps 1–3); remaining M0 acceptance is on main | yes; preserved handoff ref |
| `feat/m1-twin-v2` | M0/M1 and final sandbox acceptance | yes; merged into main |

Task 8 verification: `npm run twin:inspect` passes Amendment 2; `npm test` (53 passing across 5 files), `npm run typecheck`, `npm run lint`, and `npm run build` pass. Tests retain the Vite config-format warning and Node experimental SQLite warning; the build also prints the SQLite warning. Final integration verification passes all 75 tests, typecheck, lint and production build. The live PayPal override/restore check passed on Pilot D; all four registered pilots are now ACTIVE.

## M1 Task 6 implementation (reviews passed)

`src/twin/stress.ts` exports `stressParams` and `stressTest`. The pure transform moves intervention-specific assumption means adversely by 0.8416 standard deviations, preserving Normal/Gamma spread and Beta concentration. This approximates an adverse 80th/20th percentile scenario; Gamma and Beta shifts are not exact quantiles. Discounts have weaker retention and more post-offer churn; annual uptake falls; price sensitivity rises for increases and falls for cuts. Baseline and unchanged list prices produce no shifts.

`stressTest` runs base and stressed comparisons with the same options and seed, each against its own do-nothing baseline. It only shifts parameters explicitly marked as assumptions, retaining observed or estimated evidence (including calibrated reason-specific discount effects); exact parameter provenance takes precedence over group provenance. Historical churn, transitions, acquisition estimates and reason shares remain unchanged. Returned explanations list only shifts actually made. Eleven new tests cover the transforms, immutability, calibration preservation and adverse strategy comparisons. Spec-compliance and code-quality reviews passed independently.

## Done (each task passed a spec-compliance review and a code-quality review)

| Task | What | Key commits |
| --- | --- | --- |
| M0-1 | Renamed to Aurrery; PayPal request-ID prefixes are now `aurrery-ridgeline-*` | `d4a1c81` |
| M0-2 | Pilot sandbox subscriptions carry a segment and a reason; the ledger migrates older databases; 4-member pilot cohort | `94bf2cd` |
| M0-3 | `npm run paypal:check` tooling, safe to re-run; live replace/read-back/restore verified on D, all four pilots ACTIVE | `625ca41`, `5c1673c` |
| M1-4 | `cancel_intent` segment with escalation and de-escalation, estimated from `movedTo` history; estimators pinned by exact tests | `5fffb48`, `41f65ae` |
| M1-5 | Leaving reasons; per-reason discount effect; price-reason targeting limited to cancel intent; per-reason Bayesian update | `da4bdc5`, `dbac210` |
| M1-5b | Month-12 subscribers valued with their expected segment moves and the post-discount spike; fast per-run valuer | `065cae4`, `c9841d4` |
| M1-5c | Save-offer campaigns (`campaignMonths`), one offer per subscriber, `discountedSubscribers`; exact tests for alignment of random numbers, counts and month boundaries | `bd61cc9`, `edbe0d1` |
| M1-6 | Assumptions-only adverse stress transform, paired simulations and calibration preservation | `f3de7b7` |
| M1-7 | Reason-targeted pilots, hashed campaign context, approval display and aggregate calibration policy | `440cbdd`, `6ae1208` |
| M1-8 | Canonical starter comparison, adverse story checks and updated handoff; final reviews passed | `625f4f4` |

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

1. **M0 and M1 are complete.** All task reviews passed; the latest recovery intent change passed independent spec and quality reviews. Final verification: 75 tests, typecheck, lint and production build pass. Existing Vite config-format and experimental SQLite warnings remain.
2. **PayPal Sandbox is verified.** After the user completed fresh Pilot A checkout, GET confirmed its actual ID, ACTIVE status, expected plan and $24 price (debug ID `f9679149f5315`). Its registry ID and active creation intent were adopted in one ledger transaction, preserving row order and metadata. A full sync then confirmed A/B/C/D ACTIVE at $24. D's override flag remains true after its verified price restoration. See [decision 0001](decisions/0001-scenario-and-paypal-action.md) for the replace/read-back/restore evidence.
   - A uses its explicitly adopted v2 request ID and port-3001 callback. B/C/D retain their legacy v1 intents and port-3000 callbacks. Preserve the ignored APP_URL at port 3000 for legacy recovery; active per-pilot settings override A only. Healthy pilots are reused without POST.
   - The old A remains an unregistered pending subscription for diagnosis; do not use its looping approval link. Do not recreate B/C/D. Historical proposals retain original targets; create fresh proposals for the current registry.
   - Credentials, ledger, candidate history and approval links are ignored local state and do not transfer through Git. New machines need local credentials and their own setup or a securely transferred ledger.
   - The original cohort's earlier 404s remain unexplained. No expiration duration or TTL has been established.
3. **Integration complete.** Main fast-forwarded to the tested M0/M1 tree; all 75 tests passed again on main. Main and both working branch refs were pushed and verified on origin. LICENSE is now on main. The user subsequently resumed M2 after adding provider keys.
4. **M2: Signals: feedback corpus and classifier.** The user approved evaluating **Gemini first, then Groq**, before selecting the default provider for M2/M3. Follow [decision 0003](decisions/0003-ai-provider-evaluation.md) and the [free API research](research/free-ai-api-options.md). Anthropic is no longer required; corpus reviews passed, provider/classification implementation is ready for review, and live evaluation remains pending. Measure actual quotas, classification quality and tool-call behavior; verify the full agent loop in M3.
5. **M3: Agent: tool loop and streamed timeline.**
6. **M4: Product UI: headline card, orbit language, polish.**
7. **M5: Hosting and observed loop: Render, webhooks, revert, reset.** Then the roadmap's cut checkpoint.
8. **M7: Annual-plan execution** (required hero path; may precede M6).
9. **M6: CSV import** (optional; only cut candidate).
10. **M8: Submission: repo, write-up, video, QA.**

## Known issues and follow-ups

- **Active pilot creation intent lookup complete; independent spec and quality reviews passed.** Setup reads only active per-pilot `paypal.pilot.<index>.request_id` and `return_url` settings when creation is already allowed. An explicitly adopted replacement can retain its distinct request key/callback for later recovery; legacy pilots keep the original v1 key and configured callback. Pending `replacement_*` settings are ignored and healthy pilots never trigger POST. The explicit 404 recovery gate, actual response-ID verification and atomic ledger replacement remain unchanged. A fake-transport regression first showed A incorrectly replaying the legacy key/callback, then passed after the lookup fix; another test preserves healthy-pilot reuse with active overrides. All 75 tests, typecheck and lint pass. After user approval, a separate verified transaction adopted the ACTIVE candidate and its creation intent; the helper itself never auto-adopts candidates.

- **PayPal setup recovery fix complete; independent spec and quality reviews passed.** `src/paypal/setup.ts` reads registered pilots before reuse, reprints pending links from GET, and requires `--recover-missing` before replaying a confirmed 404 with the original key/body. Other read failures stop recovery. Existing and newly returned IDs must match the actual GET response ID as well as the wrapper-normalized ID; new/recovered IDs must read back successfully before registration or approval-link output; an atomic ledger UPDATE preserves recovered rows' order and metadata. Historical proposal targets remain unchanged. Sync now exits nonzero if any read fails. Twenty-two fake-transport/in-memory-ledger tests pass, including six response-ID regressions observed failing before the setup-local raw-ID verification fix. Independent final verification passes all 75 tests, typecheck, lint and production build. A live rerun of setup reused the same four recovered IDs, verified their actual GET IDs, and reprinted current links; all four were still `APPROVAL_PENDING` at that earlier smoke check; the final sync after adopting A confirms all four ACTIVE. The tests perform no live PayPal calls. Existing Vite config-format and experimental SQLite warnings persist. README documents recovery and sandbox Personal login. Live approval and override/revert verification are complete.

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

See [decision 0002](decisions/0002-reason-specific-calibration.md) for the calibration rationale and campaign execution boundary. No future webhook or campaign execution was added. Tasks 6–8 passed independent spec and quality reviews; the final review found no blocking issues.

## Local runtime and existing PayPal callbacks

Local dev and start commands now use port 3001. The example APP_URL and setup fallback also use http://localhost:3001 for new cohorts. A live HTTP check returned 200 with the Aurrery title; the existing app on port 3000 retained its original process. Typecheck and lint are checked for this configuration change.

The current cohort was created with http://localhost:3000 callbacks, which PayPal embeds in its approval flow. Existing links still redirect there; open Aurrery on port 3001 afterward and verify approval with paypal:sync. The current ignored APP_URL remains at its original port-3000 value to preserve recovery request bodies. B/C/D were not recreated to change ports. A later received one distinct replacement to resolve its approval loop, using an explicit port-3001 callback and recorded v2 intent. All four approvals and the D override/read-back/restore check are complete.

## Pilot A approval loop and verified PayPal operation

The original recovered A remained APPROVAL_PENDING and returned to checkout login after Agree and subscribe, including in Incognito. The cause was not established. A single explicit replacement used request ID `aurrery-ridgeline-sub-0-v2`, the same plan and pilot-0 custom ID, and a port-3001 callback. The user completed this fresh checkout. GET then verified ACTIVE on the expected plan at $24 before an atomic transaction replaced only A's registry ID and recorded its active request ID/callback. The final sync confirmed all four registered pilots ACTIVE at $24. The original pending A is preserved only in ignored diagnostic history.

The core PayPal operation is proven on D: PATCH replace returned 204, GET showed 23.45, restore returned 204, and independent GET showed ACTIVE at 24.0. The override flag remains true after restoring price. See decision 0001 for exact request/read-back shape and debug IDs. M0 acceptance is complete. The user paused before M2, then resumed after adding provider keys.

## M2 preparation

Both provider credentials are present locally (values never printed). The Gemini credential is named `GOOGLE_GENERATIVE_AI_API_KEY`; support it as an alias for `GEMINI_API_KEY`. Authenticated model-list reads returned HTTP 200: Gemini exposes `gemini-3.8-flash` with generateContent and Groq exposes active `openai/gpt-oss-120b`. These reads establish authentication/model visibility only, not inference access, free-tier quotas or classification quality. No paid billing or fallback was enabled. The user approved the focused M2 design addendum at `docs/superpowers/specs/2026-10-22-m2-feedback-signals-design.md` and authorized implementation on `feat/m2-feedback-signals`. It specifies the corpus, classification contract, evidence update, pilot boundaries and evaluation criteria. No live inference has started.

### M2 Task 1: corpus and contract (reviews passed)

`src/signals/contracts.ts` defines the strict prediction schema, feedback/model-input types, `PROMPT_VERSION = feedback-v1`, `SCHEMA_VERSION = classification-v1` and `MIN_CONFIDENCE = 0.70`. Confidence must be finite and within [0, 1]; below-threshold predictions remain schema-valid so the classifier can report them as unclassified separately.

`src/signals/fixtures/feedback.json` freezes 200 distinct synthetic messages as `feedback-corpus-v1`, spanning all five known segments, both sources, negation, mixed reasons, ordinary requests and adversarial instructions. Exactly four entries retain their exact pilot quotations and stable `pilotIndex` 0–3, with no environment-specific subscription IDs. Hidden labels are keyed by message ID in the separate `truth.json` fixture. The server-only `corpus.ts` exports `feedbackCorpus`, `corpusVersion`, `toModelInput` and the evaluation-only async `loadGroundTruth`; truth is imported only when that loader is called. Production classifier/evidence modules must never import the truth loader or fixture. `toModelInput` explicitly projects only `id`, `text`, `source` and `segment`.

Test-first evidence: the focused suite failed with 18 assertion failures before implementation, including metadata stripping and invalid predictions. `npx vitest run src/signals/corpus.test.ts` passes all 22 tests; `npm run typecheck` passes. The existing Vite config-format warning remains. Independent spec and code-quality reviews passed. No credentials or ignored data were read, and no live calls were made for this task.

### M2 Task 2: provider transport, validation and cache (implemented; reviews pending)

<!-- Generated handoff: M2 Task 2 implementation. -->

`createProvider({ provider, model?, env?, fetch?, sleep?, timeoutMs? })` in `src/signals/providers.ts` returns `{ provider, model, classify(inputs) }`. Provider choice is required and never inferred from available keys. Model configuration is explicit (`model`, then the provider-specific environment variable, then the documented initial model). Gemini prefers a nonempty trimmed `GEMINI_API_KEY`, falling back to `GOOGLE_GENERATIVE_AI_API_KEY`; Groq requires `GROQ_API_KEY`. Both use the same fixed instructions/schema from `prompt.ts` and send only the four allowlisted input fields.

`createTransport(config).send(body)` is exported for the later read-only tool smoke. It adds provider authentication and the configured Groq model to a separate caller-supplied body, then returns parsed unknown JSON with safe metrics. Classification wraps this with provider-specific request/envelope handling. HTTP operations use built-in fetch, reject redirects, bound response bodies to 256,000 bytes, and limit each attempt to 60 seconds including streaming body reads. One retry is allowed for network/timeout/HTTP 5xx, with Retry-After capped at 10 seconds; HTTP 429 and auth/model/request failures never retry. A terminal HTTP status stays terminal even when reading its error body stalls. No fallback or live warmup is performed.

Provider results contain `payload?`, `metrics`, `error?` and `terminal`. Metrics include latency, retries, token usage and an `attempts` array retaining failed-attempt status/usage/quota/error. Errors expose provider/model/category/status/retryCount and safe quota evidence only. Gemini 429 quota violations preserve allowlisted metric/ID/value/limit fields and model/location dimensions, excluding account/project dimensions and raw error messages. Missing usage contributes zero to summed reported-token totals; this is not proof of zero usage or charge.

`validateBatch(inputs, raw)` rejects malformed roots, missing/invalid/duplicate/unknown IDs and low confidence, preserving other valid batch members. `classifyFeedback(inputs, { provider, cache?, onProgress? })` processes batches of 20 sequentially, returning accepted predictions and unclassified `{ id, cause }` records in input order; unknown-ID diagnostics remain separate. It reports `schemaValidCount` before the confidence filter, `total`, `cacheHits`, attempted `batches`, aggregate `metrics`, and `stopped`. Terminal failures preserve prior accepted predictions and mark all pending feedback `provider_error`. Duplicate/blank input IDs fail before any POST.

Evaluation makes fresh calls by default. Explicit `cache: true` uses `createPredictionCache()`; `cache` may instead be an injected `PredictionCache` with `get`/`set`. The SQLite `feedback_prediction_cache` table is separate from PayPal tables; parameterized SQL stores only accepted predictions. SHA-256 keys include full projected input, provider/model and prompt/schema versions. Corrupt JSON, wrong IDs, invalid schema or confidence below 0.70 are misses, and an all-hit run makes no POST. `.env.example` documents both keys, the Gemini alias and explicit provider/model settings. ESLint now ignores the already Git-ignored `data/**`, because local helper scripts and raw evaluation artifacts are not source.

Verification: the initial focused suite showed 30 failures against minimal stubs (including missing cache storage); a later regression run showed four expected failures for stalled terminal responses and absent quota details before those fixes. All 40 Task 2 tests now pass. `npm test` passes all 137 tests; `npm run typecheck` and normal `npm run lint` pass. Existing Vite config-format and experimental SQLite warnings remain. No live provider/PayPal calls were made and the 200-message corpus/labels were unchanged. The root lint command initially scanned ignored local `data` helpers; their contents were not opened or copied. Next: independent Task 2 spec and quality reviews, then evidence/scoring/pilot projection.

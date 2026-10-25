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
| Signals | `src/signals/` | Frozen synthetic feedback, isolated Gemini/Groq transport, validated classification/cache, pure reason evidence, runtime pilot mapping and provider scoring. Includes the evaluation CLI and read-only tool smoke. | twin types, ledger |
| Agent | `src/agent/` | Bounded Groq runner, public events and seven strict tools: isolated run state, classified evidence, explicit rules, cumulative simulation, stress, display-only drafts and one proposed action; abortable NDJSON endpoint/decoder. **No execute tool.** | signals, merchant, twin, ledger |
| API | `src/app/api/` | Thin route handlers with Zod validation. | all above |
| UI | `src/app/page.tsx`, `src/components/` | Dashboard: KPIs, objective, agent Run/Stop and public timeline, AG Grid comparison, fan chart, classified/canonical provenance, exact action approval, execution, pilot cohort. | API |

## Key invariants

Groq `openai/gpt-oss-120b` is the selected M2/M3 provider after the ordered Gemini/Groq evaluation. Groq achieved 93.5% joint agreement on 200 synthetic messages, all pilot labels correct and tool smoke passed; Gemini returned HTTP 503 twice and its accuracy remains unassessed. See [decision 0003](decisions/0003-ai-provider-evaluation.md) and the [measured report](research/m2-provider-evaluation.md). Both explicit adapters remain available with no fallback. Classification begins only after an explicit agent run or CLI invocation; a complete live agent recommendation remains M3 acceptance work.

- Only `POST /api/proposals/{id}/approve` reaches PayPal. It requires the proposal's action hash, and execution is claimed atomically (`UPDATE … WHERE status='approved'`), so it happens at most once.
- Proposal predictions are recomputed server-side; client numbers are never trusted.
- Targets come from registered sandbox subscriptions matching the strategy's segment and assessed reason (or `any`), retaining registration order and capped at 25 per action.
- Agent proposals additionally intersect current classifier-eligible pilots by stable cohort label before that cap. An empty allowlist never falls back to all registered pilots; manual proposal callers omitting it retain the existing behavior.
- Agent comparisons/stress are server-owned and invalidated by evidence or rule revisions. A proposal requires classification, explicit rules, current simulation and stress, and passing base budget/risk bounds. Adverse stress remains visible; no model-supplied metrics or target IDs enter proposal creation.
- Model-facing tool results contain compact means, source summaries and paired value deltas. Full comparison/stress evidence is carried by typed UI events. One proposed action freezes a run; the agent has no approval, execution or message-sending tool.
- `POST /api/agent` accepts objective text only and reserves the process lease before streaming. Request/reader cancellation aborts runner work; normal and exceptional exits clean up the lease/listeners. Browser-safe NDJSON decoding requires one run ID, consecutive sequence numbers and explicit final status, so connection loss cannot imply completion. A stable client session rejects stale events after Stop, a new run or unmount.
- New agent/manual runs and changed evidence/rules clear prior comparisons and review state. Editing the objective or changing strategy clears the old proposal/report/confirmation. Agent evidence provenance and canonical manual estimates remain labelled; all proposals require a separate unchecked merchant confirmation before approval.
- Classification summaries carry provider/model and cache-hit provenance. Provider batch errors or a stopped classification are terminal for the run: partial evidence remains visible, but neither it nor an empty result can authorize a proposal.
- Explicit local classifier cache import validates the current provider/model and corpus/input/prompt/schema fingerprints and all 200 accepted predictions before an atomic transaction. Hidden evaluation labels never enter tools, imported cache identity, or provider inputs.
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

## Feedback classification boundary (M2)

<!-- Generated handoff: M2 Tasks 1–4 code reviews passed; live evaluation completed; Groq selected. -->

`src/signals/contracts.ts` and the frozen `feedback-corpus-v1` fixture define observed feedback and the strict prediction contract. `corpus.ts` projects only ID, text, source and known segment for providers. Hidden labels are loaded separately for evaluation; classification never uses them or pilot identity.

`prompt.ts` contains the shared `feedback-v1` instructions and JSON schema (`classification-v1`). `providers.ts` builds Gemini/Groq structured classification requests and normalizes successful envelopes to unknown JSON. `transport.ts` is the reusable server-only fetch boundary for classification and the later separate read-only tool smoke: explicit provider/model, bounded response bytes/output, a 60-second attempt limit including body reads, at most one transient retry, and no automatic fallback. Auth/model/request errors and quota stop the provider run. Errors contain safe categories, status, retry count and allowlisted quota evidence; raw bodies, request objects and exception messages are excluded.

`classify.ts` exports `validateBatch(inputs, raw)` and `classifyFeedback(inputs, { provider, cache?, onProgress? })`. Validation preserves valid members of partial batches while rejecting duplicates, missing/invalid predictions, unknown IDs and confidence below 0.70. `schemaValidCount` counts known, unique, schema-valid predictions before confidence filtering. Unknown IDs are diagnostics, never feedback entries. Classification processes pending inputs sequentially in batches of 20 and returns ordered accepted/unclassified records, diagnostics, coverage counts, attempted batches, safe failures and per-attempt/aggregate latency, usage and retry metrics. A terminal failure preserves accepted results and marks remaining inputs unclassified.

Evaluation is fresh by default. Explicit `cache: true` enables the accepted-only SQLite cache in its own `feedback_prediction_cache` ledger table; an injected `PredictionCache` is also supported. Keys hash all four input fields plus provider, model and prompt/schema versions. Reads and writes validate prediction ID/schema/confidence. Cache hits are reported separately and all-hit runs make no provider POST.

`evidence.ts` is pure and imports neither provider clients, registry I/O nor hidden labels. `summarizeEvidence(messages, predictions)` revalidates the schema/confidence boundary, reports reason counts by observed segment and intent counts separately, and rejects duplicate/unknown IDs. `applyEvidence(twin, messages, accepted)` changes only a structured copy's affected reason shares to Beta(1 + price, 1 + other), with exact segment provenance and synthetic evidence counts. No evidence preserves the prior; repeated application replaces the estimate. Churn, transitions, discount effects and the default merchant stay unchanged.

`pilotEligibility(messages, predictions, registryRows, labels)` receives current registry rows and stable `PILOT_COHORT` labels from its caller. It resolves indices 0–3 by label, preserving replacement IDs independently of registry order; missing/ambiguous labels or shared IDs produce explicit issues and no target for that pilot. Eligibility requires accepted cancel + price in known `cancel_intent`; registry reasons and hidden labels cannot repair predictions. It never changes registrations or historical proposals.

`scoreClassification(messages, truth, result, toolSmokePassed)` is the scoring-only hidden-label boundary. It reports schema-valid rate before confidence filtering, accepted coverage, accepted-only and whole-corpus intent/reason/joint agreement, confusion matrices with unclassified columns, and all four pilot checks. Unclassified feedback stays in whole-corpus denominators; zero denominators yield zero. Suitability requires valid rate >=95%, coverage >=90%, whole-corpus joint >=90%, accepted correct intent/reason for every pilot, and passing tool smoke.

`tool-smoke.ts` independently probes a single `get_merchant_state` no-argument function using the shared sanitized transport, without classification strict-output mode. It requires exactly one correct call, supplies synthetic merchant/list-price state absent from the prompt, disables tools for the follow-up, and checks that final JSON consumes both supplied fields. Gemini echoes the complete model content, retaining opaque thought signatures and matching optional function-call IDs; Groq returns the assistant tool calls and a matching `tool_call_id`. Invalid arguments/names, multiple calls, malformed/refused results and transport failures produce safe visible failures. Two-request metrics are summed; no execution or PayPal tools exist here. Protocol shapes follow the official [Gemini generateContent reference](https://ai.google.dev/api/generate-content) and [Groq tool-use documentation](https://console.groq.com/docs/tool-use/overview).

`evaluate.ts` coordinates fresh classification, terminal-stop-aware tool smoke, scoring-only truth loading, evidence/pilot reporting, and simulation of base and updated twin copies. Base and updated comparisons each use `{runs:1000,horizonMonths:12,seed:20261113}` and `STARTER_STRATEGIES`; compact metrics include deltas versus their own baseline, changes in median total value, and updated evidence provenance. Zero accepted evidence yields an explicit unavailable result. The canonical merchant and M1 results are not replaced. Default proactive pacing is 30 seconds immediately before each subsequent successful batch; there is no trailing delay, error delay or quota-reset loop. Tests inject fetch, sleep and simulation functions.

`scripts/evaluate-signals.ts` reads the current local registry through `listSandboxSubscribers` and stable `PILOT_COHORT` labels, then explicitly evaluates Gemini followed by Groq even when one fails. `--provider=gemini|groq` is a diagnostic; `--use-cache` requires one explicit provider and cannot contribute comparison candidates. `--batch-delay-ms=0..60000` adjusts pacing. `AI_PROVIDER` never silently narrows the comparison. The CLI prints batch/pacing progress, scores, safe errors/quota evidence, usage/latency/retries, current pilot mapping and simulated round-trip summaries. Existing ledger initialization can create/migrate its schema; the evaluation reader does not mutate registry/proposal/observation records. Accepted cache writes occur only with explicit reuse.

One exclusively created, timestamped UUID JSON artifact per attempted provider goes under ignored `data/`, preserving classification results and safe metrics without request objects. Dimensions include model, corpus/prompt/schema versions and JSON/UTF-8 SHA-256 hashes of corpus, projected input, truth, instruction and schema. Account tier and demonstrated free capacity remain unverified; missing usage is zero in reported-token sums, not evidence of zero charge. Qualifying fresh candidates are ordered by joint agreement then HTTP latency while free-capacity evidence is unavailable. Cached runs are diagnostic only. No suitable result sets a nonzero exit after artifacts are written. The evaluator leaves selection pending review and never changes configuration itself. Independent Task 4 and final code reviews passed. The subsequent measured decision selects Groq explicitly; see the [live report](research/m2-provider-evaluation.md).

## Commands

See `README.md` (`npm run dev | test | typecheck | lint | build | twin:inspect | signals:evaluate | paypal:setup | paypal:sync | paypal:check`).

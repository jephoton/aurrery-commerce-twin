# M3 agent tool loop and timeline implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task by task, with failing tests first, independent spec review, then quality review.

**Goal:** A real Groq agent classifies feedback, tests the broad instinct, compares selective retention and annual prepay, stress-tests its choice, and creates a proposed action with progress streamed into the existing dashboard.

**Authority:** The approved product design, roadmap M3, measured M2 handoff, and the user's instruction to continue M3. These implementation details preserve the approved seven tools, ten-call cap, merchant approval and single-agent scope. No additional product redesign or payment authorization is introduced.

**Architecture:** A server-only tool context owns a copy of the twin, decision rules, classified eligibility and computed results. A bounded Groq protocol loop invokes seven validated tools and emits typed public events. A POST endpoint streams NDJSON events to a small dashboard panel; existing comparison, charts and exact-payload approval are reused.

**Tech stack:** TypeScript, Zod, built-in fetch/ReadableStream, existing SQLite cache and proposal ledger, Vitest, React/Next.js 16.4.2. Read the bundled route-handler guide before API changes. Keep all keys server-side.

## Implementation decisions

- Use the selected `AI_PROVIDER=groq` / `GROQ_MODEL=openai/gpt-oss-120b` explicitly. Unsupported/missing configuration fails clearly; no provider fallback.
- Stream tool starts/results, classifier progress, comparisons, stress, rules, proposed action and brief public model summaries. Do not emit Groq private reasoning fields or raw HTTP requests/errors. This is a live event timeline, not a fabricated scripted answer. Model responses can be buffered per turn; token streaming is not required for the timeline.
- Validate tool names and strict arguments server-side. No execute, approve, reject, email or arbitrary filesystem/network tool. Count every requested call, including invalid calls, toward ten; never execute call eleven. Bound model requests, input size, output tokens, total reported/estimated token use and run duration. Cancellation stops new tools and proposal creation.
- Keep all seven function definitions advertised on every nonfinal turn. Enforce classification/explicit-rule prerequisites in the runner dispatch guard, returning matched `PREREQUISITE` results without analysis dispatch. Preparation uses required tool choice and an accurate recorded explanation that premature analysis calls are rejected; automatic choice resumes after readiness and the final public summary has no tools. A measured production HTTP 400 showed that filtering known analysis functions out of the catalog can cause provider rejection before the server guard. The stable catalog preserves that guard and every run limit; it does not select rule values, candidates or a winner.
- Proposed defaults are a $1,000 simulated discount budget, maximum 0.50 chance worse and 12-month horizon, shown as decision rules and editable by the model's bounded tool. Rules are explicit constraints, not model-prior tuning. Classifier/rule changes invalidate affected simulation/stress results. A recommendation must reference current server-computed results and stress; check current budget/downside rules again at proposal creation.
- Runtime classification uses accepted-only SQLite caching, clearly reporting cache hits and provider/model. An explicit local preparation command may import the genuine M2 output only after checking input/fixture/prompt/schema fingerprints, provider/model and every prediction; never import hidden labels. If cache is cold, classify with live calls and announced proactive pacing. Do not impersonate a fresh run with cached classifications.
- Classifier-derived eligible IDs intersect the existing segment/reason filters before the 25-target cap and action hash. Empty eligibility means no targets. The model cannot supply an allowlist. Preserve manual proposal behavior when no agent allowlist is supplied. Agent recommendation requires classified evidence and current pilot mapping; ambiguous mappings fail closed.
- Annual prepay is compared and explained but remains simulate-only until M7. Only supported price-override actions can become M3 proposals. Do not tune the model, labels or the honest story to make a recommendation pass constraints. A negative stressed result remains visible even if a modest base-case proposal passes rules.
- Use a process-local single-run lease and conservative proactive token pacing for the observed 8,000 TPM limit. Announce waits; abort them promptly on cancellation. A received 429 stops the run visibly. Quota estimates are approximate, not billing guarantees. Hosted per-IP limits and durable multi-instance coordination remain M5.

## Task 1: Seven tools, classified context and selective proposals

**Files:** new `src/agent/contracts.ts`, `tools.ts`, `tools.test.ts`, `src/signals/cache-import.ts`, `cache-import.test.ts`, `scripts/import-signal-cache.ts`; modify `src/ledger/proposals.ts` and its tests, package scripts, relevant handoff.

- [x] Write failing tests for strict tool schemas, prerequisite checks, version-invalidated results, exact decision-rule checks, no-target behavior, and classifier-only eligibility. Observe failures before implementation.

```ts
// An explicitly empty allowlist must never fall back to the registry.
expect(() => buildAction(strategy, 24, [])).toThrow();
// Current segment/reason matching still applies to supplied IDs.
expect(buildAction(strategy, 24, ['I-PRICE000002', 'I-OTHER000001']).targets)
  .toEqual(['I-PRICE000002']);
```

- [x] Add optional server-only `eligibleTargetIds` to proposal creation/buildAction; intersect before cap, hash final targets. Existing API body cannot inject agent context. Test preserved manual behavior, reordered/replaced pilot IDs, exclusions and unchanged approval state machine.
- [x] Define typed events and seven tool schemas: `get_merchant_state({})`; `classify_feedback({})`; `set_decision_rules({discountBudget,maxProbWorse,horizonMonths})`; `simulate_strategies({strategies: Strategy[]})` (1–6); `stress_test({strategyId})`; `draft_customer_message({strategyId,message})` (display only); `recommend({strategyId,rationale,tradeoffs})`. Validate lengths/numbers and expose compact JSON tool definitions.
- [x] Implement an injectable per-run tool context. It owns the twin copy, rules, classification, cumulative comparisons and stress cache. Send compact computed summaries to the model; send full typed comparison/proposal events only to the UI. Model inputs never include hidden labels or credentials. Public results label simulated versus classified data and provenance. `recommend` calls existing createProposal with server-computed prediction and eligibility; never calls approval or execution. Disallow duplicate conflicting strategy IDs. Require current classification/rules/simulation/stress and check rules immediately before proposing.
- [x] Implement explicit cache import from an M2 artifact using current provider/model, version and SHA-256 dimensions. Validate all entries before any cache insert, reject duplicate/unknown IDs and low confidence, and atomically store accepted predictions with the existing cache API. Import neither labels nor proposal targets. CLI takes an explicit local artifact argument; it prints provider/model/count only. Add `npm run signals:import-cache -- <artifact>`.
- [x] Verify focused tests, full tests, typecheck and lint. Update docs/current-state.md with interfaces and red/green evidence; commit `feat(agent): add validated tools and classifier-bound proposals`. Obtain independent spec then quality reviews, fixing and re-reviewing findings before Task 2.

## Task 2: Real Groq loop, budgets and cancellation

**Files:** `src/agent/model.ts`, `run.ts`, `limits.ts`, their tests; `scripts/check-agent.ts`, package script, handoff.

- [x] Write failing fake-model tests for complete tool flow, malformed/unknown calls, count cap, proposal prerequisites, no execute tool, provider/quota failure, cancellation and token/run limits. Use injected clock, sleep, model and tool dependencies.

```ts
expect(events.filter(e => e.type === 'tool_started')).toHaveLength(10);
expect(result.status).toBe('incomplete');
expect(executeEleventh).not.toHaveBeenCalled();
expect(approvalSpy).not.toHaveBeenCalled();
```

- [x] Implement the Groq model adapter with existing sanitized transport, normal tool calling (`parallel_tool_calls:false`, no classification response_format), compact schemas/results and matched tool_call_id history. Strip private reasoning. Bound output, validate model envelopes and call IDs, reject duplicate IDs, and preserve only public summaries/arguments in a recordable transcript. Respect AbortSignal in model fetch/waits and check it before side effects.
- [x] Implement a real loop with at most ten requested tool calls, at most eleven model turns, approximately 32,000 tokens per run and a ten-minute wall cap. Enforce conservative input/output reservation and process-local 8,000-TPM pacing before model requests; report waits. Unknown/missing usage consumes the reservation rather than claiming zero usage. The limiter is approximate and HTTP 429 still terminates. A process-local active-run lease prevents simultaneous runs; always release it on completion/failure/cancellation.
- [x] Prompt the agent to investigate the broad instinct, compare selective retention and annual prepay honestly, inspect assumptions/stress, draft display-only copy and recommend only a supported action that passes current rules. Do not hardcode a winner or bypass tool calls. Return complete only after a valid recommendation; otherwise report incomplete with available results/reason. If no strategy passes, do not fabricate a proposal.
- [x] Add `npm run agent:check` as an explicit live CLI with synthetic default objective, public event progress and a uniquely named ignored transcript artifact. It may create a proposed record but never approves or sends PayPal mutations. Tests always use fakes. Verify tests/typecheck/lint/build, update handoff and commit `feat(agent): run bounded Groq tool loop`. Complete both reviews before Task 3.

## Task 3: Streaming endpoint and existing dashboard integration

**Files:** `src/app/api/agent/route.ts`, `src/agent/stream.ts` and tests, `src/components/AgentPanel.tsx`, minimal `Lab.tsx` edits.

- [x] Read local Next route-handler documentation. Write failing tests for request validation, streamed sequence, split UTF-8/line boundaries, truncated/disconnected streams, abort/lease cleanup and error sanitization. Use injected fake runner; no live calls in tests.
- [x] Add POST `/api/agent` accepting a trimmed 1–2,000 character objective only. Validate before inference. Stream typed NDJSON with monotonically increasing sequence/run ID, no-store headers and a final done/error record. Use request cancellation and stream cancel handling to abort the run. Never emit private reasoning/raw errors. Return a clear busy response for an occupied lease.
- [x] Add Run agent / Stop controls and a readable accessible timeline near the objective. Reuse the existing comparison grid and proposal card via typed callbacks. Reset stale proposal/report/confirmation on a new run; block conflicting controls while running. Show cached/fresh classification counts, rules, simulated metrics/stress, public summaries, incomplete/error state and no false completion on premature EOF. On completion select the proposed strategy and show its exact payload for merchant approval; do not auto-check confirmation or approve.
- [x] Keep manual simulate/propose available and distinguish manual versus agent evidence/provenance. If the merchant later selects another strategy, do not show or approve a stale proposal for the previous selection. Render model text as text, not HTML. Keep product polish/orbit redesign for M4.
- [x] Run tests/typecheck/lint/build, update handoff and commit `feat(agent): stream progress into the dashboard`. Complete spec and quality reviews before live/browser verification.

## Task 4: Actual run, recorded replay and browser acceptance

<!-- Generated progress, 2026-10-25: Tasks 1–3 and runner corrections passed independent spec/quality reviews. Attempt 4 at 36be5dd completed the real CLI flow; the first Task 4 item is verified. The sanitized recording and actual-tools replay are implemented and pass locally; their independent reviews remain pending, so the replay checkbox stays open. Production SSR is HTTP 200, attempted real stream requests are HTTP 409 busy, and visual acceptance is pending after browser tooling failed before initialization. See ../../research/m3-agent-validation.md. Do not merge or mark M3 complete before the unchecked acceptance items pass. -->

- [x] Explicitly import the matching local M2 artifact to warm the classifier cache after fingerprint validation. Run the real Groq loop from the synthetic objective. Record model/tool usage, pacing, exact sequence, classifications, broad-versus-refined/annual comparisons, stress, proposed hash/targets and status. Do not approve a proposal or issue PayPal mutations. Fail honestly if quota/provider/rules block completion; do not substitute a scripted response.
- [ ] Save a sanitized recorded model-response fixture from the real run (no keys, private reasoning, personal paths or live subscription IDs). Replay it against actual tools with in-memory ledger/pilots, asserting the same sequence, current classifier eligibility, computed result grounding and proposed-only state. Review this new test/fixture independently.
- [ ] Verify the dashboard in the browser: timeline advances before completion, comparison updates, recommendation reaches the existing approval card, stop/error handling works, and no approval occurs automatically. Save only useful local screenshots, avoiding credentials. Existing PayPal GET status checks are allowed; no approval clicks.
- [ ] Run final tests/typecheck/lint/build and final independent review, scan tracked files for configured secrets/personal paths, update handoff/roadmap/architecture and measured M3 results, commit atomic changes, merge and push when acceptance passes. M4 is the next milestone; M7 annual execution remains future work.

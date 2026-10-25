# M3 agent validation

<!-- Generated measured handoff, 2026-10-25. -->

The real Groq CLI completed a proposal flow at code `36be5dd`, finishing on 2026-10-25 at 06:12:07 UTC (14:12:07 SGT). This establishes one successful live agent run with cached classifications. M3 remains open for endpoint/browser acceptance, independent review of the recording/replay and final verification. It has not been merged or published as complete.

## Measured live run

Provider: **Groq `openai/gpt-oss-120b`**, explicitly selected. The objective asked the agent to investigate a broad at-risk discount, compare selective cancel-and-price saves, annual prepay and doing nothing, inspect uncertainty and stress, then propose only a supported action within explicit rules. The merchant's instinct was investigated without changing simulation assumptions or prescribing a winner.

| Measure | Observed result |
| --- | --- |
| Final status | `complete / COMPLETE`; proposal remains `proposed` |
| Elapsed time | 301,808 ms, including pacing and simulations |
| Tools requested / dispatched | 7 / 7 |
| Model turns | 8 |
| HTTP requests | 8, all HTTP 200; no retries |
| Reported / accounted tokens | 22,043 / 22,043 |
| Classifications | 200 accepted cache hits; 0 unclassified; no fresh classifier HTTP requests |
| Pilot mapping | 2 eligible of 4; no mapping issues; A/B eligible, C/D excluded |
| Explicit rules | $1,000 mean simulated discount-cost budget; maximum 0.50 chance worse; 12 months |

Exact tool sequence:

```text
get_merchant_state → classify_feedback → set_decision_rules
→ simulate_strategies → stress_test → draft_customer_message → recommend
→ final public summary (no tool)
```

Every tool succeeded. The required preparation mode led to explicit classification and rules before analysis; no prose-only recommendation clarification was needed. All three intervention candidates were compared together, with the server adding the canonical do-nothing baseline. This is a real recorded protocol, not a scripted response sequence used as live inference.

The classification evidence is the genuine accepted M2 Groq output, explicitly imported only after provider/model and corpus/input/prompt/schema fingerprints and predictions were validated. Cache reuse establishes the agent's use of that evidence; it does not constitute a new classification benchmark. M2 agreement remains the separately measured 93.5% joint agreement on the synthetic corpus. Billing tier, charges and free capacity remain unverified; successful calls and token counts do not establish zero cost.

## Computed comparison

All values below are **simulated** paired total-value differences against each comparison's own do-nothing baseline. Options: 1,000 runs, 12 months, seed `20261113`. Classified reason shares update a copy of the merchant twin; canonical M1 results remain unchanged.

| Strategy | p10 Δ value | Median Δ value | p90 Δ value | Chance worse | Mean discount cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Do nothing | $0.00 | $0.00 | $0.00 | 0.0% | $0.00 |
| Broad at-risk: 20% for 3 months, 6-month campaign | −$3,842.49 | −$1,326.81 | +$1,066.46 | 75.8% | $4,104.35 |
| Cancel + price: 25% for 3 months, 6-month campaign | −$435.73 | +$87.78 | +$600.30 | 41.4% | $408.41 |
| Annual prepay: 15% off, core/price-sensitive | +$5,220.74 | +$10,351.21 | +$17,884.30 | 0.0% | $8,862.83 |

The selective save fits both base-case rules. The broad discount fails both. Annual prepay has stronger simulated upside but exceeds this run's budget and remains simulation-only until M7. A simulated 0% chance worse is a sample frequency, not a guarantee.

The selected save's adverse assumptions-only stress changes median Δ value from **+$87.78 to −$42.79** and chance worse from **41.4% to 53.6%**; stressed p10/p90 are −$561.58 / +$458.33. This risk was visible in the public final summary. Stress uses the same simulation options, paired against its own stressed do-nothing baseline. The base-case rule passes; a negative stressed outcome remains a material limitation rather than an automatic veto.

## Proposed action and observed boundary

The durable action is a price override for current eligible pilots **A and B only**, $24.00 → $18.00, 25% discount, 3-month offer, 6-month campaign metadata. Its live action hash is `4153b4bb6c7cba3d5d69f0d7c6424ff958c8b876256c3fed36ad8e486fb34293`. Future campaign entrants require separate proposals and merchant approvals; this action snapshots today's eligible registered pilots.

The row remains `proposed`, without approval or completion. Customer copy is display-only; no communication was sent. The agent has no approval, execution or messaging tool. A fresh read-only PayPal check after the run confirmed all four registered subscriptions remain **ACTIVE at $24.00**; D's existing override flag remains true after its earlier verified restoration. No approval or PayPal mutation was performed for this validation. Simulated deltas are not observed payment outcomes.

## Earlier unsuccessful attempts

These attempts remain part of the measured history; the successful run does not erase them.

| Attempt / code | Outcome | Tools / model turns / HTTP | Tokens | Elapsed | Finding |
| --- | --- | --- | ---: | ---: | --- |
| 1 / `1b75bcf` | `incomplete / TOKEN_LIMIT` | 8 / 9 / 8; HTTP 200, no retry | 25,086 | 302,429 ms | Three incompatible baseline calls consumed budget; final recommendation lacked classification/rules. Server baseline contract and workflow instructions were clarified. |
| 2 / `b2897c8` | `incomplete / NO_PROPOSAL` | 5 / 6 / 6; HTTP 200, no retry | 18,435 | 241,618 ms | Cached classification, comparison, stress and draft completed, but model skipped explicit rules and gave only a verbal recommendation. Runtime prerequisite gating and one neutral clarification were added. |
| 3 / `1b59401` | `incomplete / NO_PROPOSAL` | 2 / 3 / 3; HTTP 200, no retry | 3,741 | approximately 10 seconds | Model read state and classified, then treated temporary tool restrictions as missing support. Required preparation mode and explicit explanation were added. |
| 4 / `36be5dd` | `complete / COMPLETE` | 7 / 8 / 8; HTTP 200, no retry | 22,043 | 301,808 ms | Explicit preparation, actual computed comparison/stress and proposed action all completed. |

Attempts 1–3 created no proposal. None approved an action or mutated PayPal. The ten-tool, eleven-turn, 32,000-token, ten-minute run limits and model assumptions were not relaxed to make attempt 4 complete.

## Recording and offline replay

`src/agent/fixtures/m3-recorded-groq.json` contains eight public assistant responses from attempt 4, 200 genuine accepted M2 predictions and expected measured summaries. It is copied from a prepared sanitized extract, rather than opening the full local evaluation or ledger in the replay. Provenance hashes identify the ignored source artifacts:

- Agent artifact SHA-256: `00accef44667ab3b3a05666febae46f80564bd5e6221b3c77ec4f3eb1b1d2c94`.
- M2 classification artifact SHA-256: `6a0b4acfa2b118a4a4e13616ced6ab7179d2b14bfe6fd3e33f0e04f832ca9b00`.

The public assistant projection contains only `role`, `content` and optional function `tool_calls`. All eight assistant responses exactly match the live transcript's public projection: content, tool names, argument strings and opaque `fc_…` UUID call IDs are unchanged. A source audit found no live subscription or proposal identifiers in these responses, so defensive text replacement changed no model content. Expected-action targets were replaced with fictitious `I-REPLAYA` / `I-REPLAYB`; the other test registrations use `I-REPLAYC` / `I-REPLAYD`. All other unselected CLI event/result data and M2 data were discarded; only accepted M2 predictions were extracted. Raw requests, headers, credentials, private reasoning, full twin parameters, hidden labels, local paths and live identifiers are absent. The fixture carries predictions, not evaluation truth. Its live usage counters are provenance and are not charged again during replay.

`src/agent/replay.test.ts` seeds the actual prediction cache using current `toModelInput`, provider and model identity, registers fictitious pilots with current stable cohort labels and replays those responses through the actual runner, classification cache path, evidence update, 1,000-run simulator, stress test and SQLite proposal ledger. It does not replace classifier, simulator, stress or proposal results. A throwing fetch spy makes any network attempt fail.

The test asserts the exact seven-tool/eight-turn sequence, matched opaque call IDs, unchanged public assistant responses, no inserted proposal clarification, all 200 cache hits, A/B eligibility with C/D excluded, the recorded paired distributions/costs and stress to numerical tolerance, display-only draft, exactly one proposed row with null approval/completion, exact fake-target action and its freshly computed hash, no execution rows, no approval audit and unchanged canonical twin. Live hash comparison is intentionally absent because fictitious target IDs change the payload hash. A missing-fixture assertion was observed failing before the recording was added; the complete integration replay then passed.

Run the replay without credentials or live calls:

```bash
npm test -- src/agent/replay.test.ts --maxWorkers=1
```

The replay verifies deterministic grounding and safe proposed-only state. It does not reproduce live HTTP pacing, token metering or demonstrate another independent model inference.

Local replay verification passed `npm test -- --maxWorkers=1` (333 tests across 28 files), `npm run typecheck`, `npm run lint` and `git diff --check`. Existing Vite config-format and experimental SQLite warnings remain. The parent subsequently completed the production build and independent replay/final code-quality reviews successfully. The later diagnostics-only runner delta described below passes all 350 tests across 29 files, typecheck, lint, production build and diff checks; its targeted reviews remain pending.

## Acceptance still open

Production SSR returned HTTP 200 with agent and manual controls rendered. Initial endpoint attempts returned HTTP 409 busy before inference. A later parent-run production POST at `28ae0b0`, using the default Lab objective, decoded eight valid frames: the first event arrived after 59.6 ms, state and classification completed with 200 cache hits, then `PROVIDER_FAILED` and final incomplete status arrived after 3,397 ms. No proposal was created. The ignored evidence is `data/m3-stream-2026-10-25T06-24-21-251Z-109352be-0725-4c09-976f-fa1b6f625f30.json`. This establishes actual progress/error streaming and later lease availability, but not a completed API workflow. The old generic failure event does not identify the underlying provider category or HTTP status.

The runner now projects the adapter's already sanitized error into optional `RunResult.providerFailure` containing only an allowlisted category and optional integer HTTP 100–599 status. Existing error-event text includes those safe values without changing its shape or reason code. Extra fields, requests, raw errors and private reasoning are excluded. This adds diagnostics to CLI artifacts and API/UI text; it changes no model protocol, retry behavior, limits or M2 inputs. The production failure's cause remains unclassified until a further parent-run attempt supplies diagnostic evidence.

Automated endpoint/decoder/session tests cover ordering, cancellation and incomplete/error handling. Full visual acceptance is **pending**: the computer-use tool failed before initialization with “failed to write kernel assets: The system cannot find the path specified”; reset/retry also failed. The user plans to restart Codex to restore browser automation. This infrastructure failure supplies no browser observation. A manual dashboard check at `http://localhost:3001` has been requested; its result is not yet established.

Remaining checks are targeted diagnostics-delta reviews, a completed endpoint workflow and browser/manual walkthrough of progress before completion, refreshed comparison, A/B-only $18 approval payload with unchecked confirmation, Stop/error behavior and no automatic approval, plus final verification after any follow-up. Independent replay/final code reviews already passed. Only after remaining acceptance passes should M3 be marked complete, merged and pushed. M4 product polish follows M3; annual-plan execution remains M7.

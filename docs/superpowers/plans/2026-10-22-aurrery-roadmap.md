# Aurrery: milestone roadmap

Source spec: [`docs/superpowers/specs/2026-10-22-aurrery-design.md`](../specs/2026-10-22-aurrery-design.md).
Submission deadline: 2026-11-13 04:00 SGT (fixed by the hackathon). Milestones run in the order below.

Each milestone ends with working, tested software, committed on its own branch and merged before the next starts. Each milestone gets a detailed task plan in this folder before work begins. M0 and M1 are already written: [`2026-10-22-m0-m1-rename-paypal-twin-v2.md`](2026-10-22-m0-m1-rename-paypal-twin-v2.md).

| Order | Milestone | Depends on |
| --- | --- | --- |
| M0 | Rename and PayPal check | — |
| M1 | Twin v2: cancel intent, reasons, stress test | M0 |
| M2 | Signals: feedback corpus and classifier | M1 |
| M3 | Agent: tool loop and streamed timeline | M2 |
| M4 | Product UI: headline card, orbit language, polish | M3 |
| M5 | Hosting and observed loop: Render, webhooks, revert, reset | M4 |
| ✱ | **Checkpoint: cut decision** | after M5 |
| M6 | CSV import *(cut line 2)* | M5 |
| M7 | Annual-plan execution *(cut line 1)* | M5 |
| M8 | Submission: repo, write-up, video, QA | all kept milestones |

## M0: Rename and PayPal check
**Goal:** the project is called Aurrery everywhere, and the hero PayPal operation is proven against the real sandbox.
- Rename the package, UI, README and docs; update PayPal idempotency-key prefixes.
- Verification script: patch one live sandbox subscription's price, read it back, then revert. Settle `replace` versus `add` and confirm the read-back field.
- **Needs you:** a PayPal Sandbox REST app (client ID and secret in `.env.local`) and a sandbox personal account to approve the pilot subscriptions.

**Done when:** `npm run paypal:check` prints a verified override and revert with PayPal debug IDs; the decision record notes the verified request shape.

## M1: Twin v2
**Goal:** the twin can express and evaluate the hero story.
- `cancel_intent` segment with escalation and de-escalation transitions, estimated from history.
- Reason attribute (`price` | `other`) on groups; discount effect by reason; targeting by `{segment, reason}`.
- `stressTest`: assumptions shifted to their unfavourable 80th percentile.
- Proposals and the pilot cohort carry a reason; the setup script registers 2 price-driven cancel-intent, 1 other cancel-intent and 1 core subscription.

**Done when:** tests pass. `twin:inspect` shows the precision discount beating the broad one on median value, and the stress test is never better than the base case. If the precision discount does *not* beat baseline under honest assumptions, we stop and revisit the story rather than tune numbers.

## M2: Signals
**Goal:** the AI reads customer text, and that becomes evidence the twin uses.
- Synthetic corpus fixture (about 200 messages with hidden ground-truth labels) linked to segments and pilot subscriptions.
- Claude classifier with structured output `{intent, reason, confidence}`, schema-validated, cached by content hash.
- Classifier counts become each segment's price-reason Beta distribution, with provenance changed to estimated.
- An accuracy report against ground truth, run manually.

**Done when:** a classify → re-estimate → simulate round trip works. Accuracy is reported, and invalid outputs are flagged as unclassified.

## M3: Agent
**Goal:** a single tool-use agent produces an auditable recommendation and proposal.
- The seven tools from spec §4; at most 10 tool calls; no execute tool.
- Streaming endpoint; UI timeline of the agent's steps (tool calls, results, reasoning summaries).
- Tests: tools with a fake model client; one recorded run replayed.

**Done when:** from the objective text, the agent classifies, tries the broad discount, refines to the precision discount, stress-tests it, and creates a proposal the merchant can approve.

## M4: Product UI
**Goal:** the first 30 seconds of the demo sell it.
- Headline recommendation card (expected value, chance of doing worse, Approve).
- Orbit and trajectory visual language for the fan charts and segments.
- AG Grid polish: grouping by strategy family, value-interval cell renderer, pinned baseline.
- Assumptions panel with evidence, assumption and observed badges; clear simulated-versus-observed styling; mobile-safe layout.

**Done when:** a browser walkthrough of the whole flow looks demo-ready. Checked with the `run` skill or a screenshot on the hosted build.

## M5: Hosting and observed loop
**Goal:** judges can use it live, and observed outcomes feed back into the twin.
- Render web service with a persistent disk for SQLite; environment configuration; rate limits and a token cap per run.
- Webhook endpoint with PayPal signature verification and event deduplication; observations update the discount-effect posterior.
- Revert proposal; demo-reset admin action.

**Done when:** the hosted URL runs the full flow end to end; a webhook from a sandbox event appears as an observation.

## ✱ Checkpoint (after M5)
If the remaining time looks too short for both M6 and M7: cut M7 first (the annual plan stays simulate-only, with its PayPal route explained in the UI), then M6. The hero path is never cut.

## M6: CSV import
**Goal:** "works on your data".
- History CSV (spec §5, amended columns `moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent`) and an optional feedback CSV.
- Per-row validation errors; a template and sample file; re-estimation reuses the calibration code.
- A sample "second merchant" CSV for the demo close.

**Done when:** uploading the sample produces a different, explained recommendation; bad files produce per-row errors and leave the twin unchanged.

## M7: Annual-plan execution
**Goal:** a second real PayPal action, one that needs the buyer's consent.
- Create an annual plan via the API; generate per-subscriber `revise` approval links; track approval through read-back or webhook.

**Done when:** a sandbox buyer approves a switch and the subscription reads back on the annual plan.

## M8: Submission
- Create the public GitHub repo (name agreed with you then), with the MIT license visible.
- README with a hosted URL and local setup; Devpost text, including the tools-used explanation.
- Video script, then record (under 3:00), upload to YouTube as public.
- Final QA on the hosted build; submit with margin before the deadline.

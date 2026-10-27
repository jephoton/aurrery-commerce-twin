# M5 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, with spec then quality reviews.

**Goal:** Host the existing app safely and make verified PayPal outcomes visible and usable as measured evidence, with separately approved recovery actions.

**Architecture:** One Render Free Node 24 service and authoritative Turso libSQL ledger, with local SQLite compatibility; isolated pure computation worker; hosted request admission; signature-verified, idempotent event ingestion; derived posterior and explicit recovery proposals. The user selected free hosting on 2026-10-27: complete the separate free-storage adaptation plan after Task 2, before Task 3. Follow the detailed M5 design, existing overall spec and exact-payload approval invariants.

**Tech stack:** Next 16.4.2, TypeScript, Node worker_threads/SQLite, esbuild for the independent worker bundle, existing PayPal Sandbox SDK, Render.

## Task 1: Bound CPU work outside the web process

Files: create `src/twin/worker-entry.ts`, `src/twin/worker-client.ts`, `src/twin/worker-client.test.ts`, `scripts/build-workers.mjs`; modify `package.json`, lockfile, `src/agent/tools.ts`, `src/app/api/simulate/route.ts`, `src/app/api/proposals/route.ts`; add meaningful route/tool integration regressions.

- [x] Read installed Next route documentation and current simulation/stress signatures/tests. Write failing tests for seed/result parity, abort-before-start, abort while running, true hung worker timeout, abnormal exit, capacity rejection and capacity release after each terminal path. Use a test-only injected worker path/constructor for hung/crash fixtures; never expose this in request JSON.
- [x] Build a pure, independently bundled CommonJS worker with explicit esbuild dev dependency. Build it for dev/test/production through package scripts into ignored `build/`; it imports only twin math, receives structured jobs and emits results or sanitized errors. Pass an empty environment, a 128 MiB heap limit, and no ledger/provider code.
- [x] Add async compare/stress adapters with a 30-second hard parent timeout and one process-wide active worker. Abort must terminate the worker, listeners/timers must be cleaned, and capacity must stay owned until termination completes. No synchronous fallback. Tests may shorten timeouts through server-only injection.
- [x] Await adapters in agent tools, manual simulation and the proposal route's server-side recomputation, preserving synchronous injected test dependencies and current exact seed/options/results. Bound request bodies, pass request abort and map resource/timeout failures safely. A cancelled recomputation must not persist a new proposal.
- [x] Run focused new and existing twin/tool/HTTP/replay tests, typecheck and zero-warning lint. Update current-state with verified task status and limitations, then commit `feat(twin): isolate bounded simulation workers`.
- [x] Independent spec review, then quality review; fix and re-review findings before Task 2.

## Task 2: Hosted admission and administrator access

Files: new `src/hosting/` configuration, session and durable-limit modules with tests; admin session route/component; wrap agent/manual/proposal/PayPal polling routes; `.env.example`.

- [x] Test hosted fail-closed configuration, wrong/missing/expired/tampered cookies, same-origin and CSRF checks, bounded login/body handling and public/private route separation before implementation.
- [x] Implement explicit hosted mode (mandatory on Render), a strong secret, hashed constant-time password checks, authenticated expiring cookies, login/logout, and a small accessible admin control. Preserve local development behavior. No admin credential in client props/logs.
- [x] Add SQLite-backed hashed-client and global quotas, atomic admission and expiry cleanup. Initial fixed-window agent admission: three/client/hour, six/global/hour and twenty/global/day; simulation/proposal preparation: thirty/client/hour and sixty/global/hour; live polling: thirty/client/hour and sixty/global/hour; login: five/client/15 minutes and thirty/global/15 minutes. Invalid login attempts count. Test header spoofing cannot bypass the global cap, parallel admission, restart behavior and safe Retry-After. Preserve existing run/provider limits. Prefer opaque random administrator sessions stored only as token hashes with two-hour expiry and server-side logout revocation; password rotation must invalidate old sessions. No browser storage for credentials.
- [x] Protect existing approval/rejection endpoints and provide the reusable boundary for Task 5 reset, require same-origin for public mutations, expose safe hosted capability state. Test API paths directly rather than only hidden buttons.
- [x] Run focused integration/security tests, typecheck/lint; update handoff; atomic commits and spec/quality reviews.

## Task 3: Verified, deduplicated sandbox webhook observations

Files: new `src/paypal/webhooks.ts`, `src/ledger/webhooks.ts`, `src/app/api/paypal/webhook/route.ts` and tests; extend ledger migrations; safe observations GET route.

Implementation boundary: retain the existing observation columns and add a dedicated `paypal_webhook_events` table containing unique event ID, allowlisted type, event time, receipt time, historical subscription ID, disposition/ignored reason, and an optional FK to its observation. This preserves legacy observations and separates occurrence from delivery without adding ambiguous status columns. Store no raw event, payer/contact data, signature headers or OAuth token. Insert the event and its observation in one checked transaction; append facts instead of updating a global latest-status record. Subscription events use `resource.id`; sale events use `resource.billing_agreement_id`. A sale payment is not proof that the subscription is ACTIVE and its charged amount is not the recurring override price: retain it as a payment fact with unknown regular price. Current-status/price evidence still comes from explicit subscription data or verified read-back.

Use the installed SDK's public Sandbox credential manager or an equivalent narrowly scoped, cached Sandbox OAuth REST helper with full-response bounds, followed by a bounded HTTPS POST to the Sandbox verification endpoint. Both reuse the same server credentials. Preserve the original strict UTF-8 raw event JSON verbatim as the verification request's webhook_event value; parsing for validation is separate and must not cause re-serialization of that value. Normalize only afterward, and accept strict `verification_status=SUCCESS`. Verification failure consumes no event ID. Missing/invalid headers/signature fail closed; upstream verification failure remains retryable. The webhook bypasses browser Origin/session requirements but has its own bounded admission (30/minute and 1,200/day global; no model budget). Safe observation GETs use Next's request-time boundary before storage. Never generate an event by mutating a pilot during implementation.

- [x] Write failures for missing/bad signatures, retryable verification failure, duplicate/concurrent delivery, unknown pilots, subscription versus sale identifiers, malformed/oversized input, unsupported events and out-of-order event times. Use recorded/synthetic sanitized payloads and fake verification, never disabled production verification.
- [x] Use SDK-supported webhook verification if available; otherwise a narrowly scoped sandbox OAuth REST helper with bounded timeout. Require configured webhook ID and all transmission headers, and strict SUCCESS. No arbitrary URL fetches, live endpoint or raw event/payer persistence.
- [x] Transactionally record unique event ID and safe observation together; rollback permits retry after ingestion failure. Normalize timestamps/status/payment facts and preserve receipt versus event time. Read-back may enrich facts without changing the signed event.
- [x] Extend runtime migrations and the safe-import tests for older local ledgers lacking webhook tables/new observation fields. Normalize only a temporary consistent source copy or apply explicit legacy defaults; never mutate the original source to make import pass. Preserve count/hash checks and existing observation semantics.
- [x] Expose safe observation summaries; test polling cannot create event duplicates, and unauthorized source data never reaches the ledger/model. Update handoff, verify and commit; spec/quality reviews.

## Task 4: Derive measured discount outcomes and posterior

Files: new `src/ledger/discount-outcomes.ts` and tests; update verified execution/read-back observations, merchant view, twin API and minimal evidence UI.

- [x] Test zero exposure after an override alone, fractional elapsed exposure bounded by verified active observations/campaign end, one factual cancellation with whole-episode censoring (current PayPal facts cannot qualify voluntary intent/discounted price), out-of-order and duplicate events, unverified/failed PATCH exclusions, restore boundaries, unrelated status/payment failure exclusions and immutable repeated posterior reads.
- [x] Derive reason-specific subscriber-months only from verified discount executions and qualified observed intervals. Snapshot assessed segment/reason with the verified exposure start, cap at the configured end, and split overlapping successive actions so a pilot's time is never counted twice. Aggregate once against canonical baseline and call existing `updateDiscountEffect`; do not mutate the merchant singleton or infer survival from silence. Retain observational, assumed-counterfactual and selection/censoring limitations in provenance; no causal retention claim. Qualified posterior cancellations remain zero until a real qualifying evidence channel exists.
- [x] Show measured event count/exposure/changes separately from simulation assumptions. Keep `currentMerchant()` canonical and introduce a separate request-time observed view for agent/manual/proposal computation; do not access a runtime disk during Next build/prerender. Ensure the displayed evidence explains current observed parameters and classifier updates preserve those effects. Test streaming with fractional subscriber-month provenance: the current decoder requires integer `evidenceCount`, while calibration legitimately emits fractional exposure. Permit finite nonnegative exposure there without relaxing actual integer feedback/run counts.
- [x] Focused integration tests plus unchanged canonical/replay checks where no outcomes exist; handoff, commit and spec/quality reviews.

## Task 5: Separate recovery proposal and restricted demo reset

Files: extend `src/ledger/proposals.ts`, execution layer, proposal API/review UI; new admin reset preview/confirm API and tests.

- [ ] Test fresh approval/hash requirement, source verified targets only, list-price immutability, no arbitrary source/revert-of-revert, registration and current-price races, duplicate claim, partial execution and no revertAfter on a revert.
- [ ] Add a discriminated revert action with source reference and exact per-target expected/current-to-list prices. Never reuse the original benefit prediction as a revert forecast. Preview it, then use the existing explicit approval and atomic execution flow with precondition GETs and read-back.
- [ ] Add admin reset preview/hash/explicit confirmation restricted to the registered cohort and canonical list price, with bounded targets and logged outcomes. Persist preview as a proposed recovery action; administrator confirmation must supply a fresh exact-hash approval and pass the same atomic execution claim. Preserve all historical rows and never auto-run. Test unauthorized API access, preview tampering, registration changes and partial failures.
- [ ] Extend the safe-import validator and round-trip tests for the recovery action union and its truthful reference/prediction metadata. Existing discount hashes stay unchanged; recovery approvals, pending states and history must remain portable without manufacturing approvals.
- [ ] Minimal accessible UI controls only; preserve unchecked confirmation and no agent recovery tools. Offline checks, handoff, atomic commits, spec then quality reviews. No live subscription writes during implementation.

## Task 6: Prepare and validate deployment

Files: `render.yaml`, Node/start/build configuration, health route, deployment/import helpers and `docs/research/m5-hosting-validation.md`; update README, architecture/current-state and roadmap status.

- [ ] Prepare a one-instance **Render Free + Turso** blueprint, PORT-aware start, runtime configuration validation and no build-time secrets. Document private environment setup, safe existing-pilot import, remote cache/import, consistent SQLite source backup and remote recovery, plus free-service wake-up limitations. Never copy an open SQLite file without its WAL; use a supported consistent backup. No paid disk or billing upgrade.
- [ ] Run full tests/typecheck/lint/build, hygiene scan and local production browser acceptance, including real worker integration and protected admin paths. Record exact results before provisioning.
- [ ] Resolve account access for the selected free services after unblocked work; configure secrets privately, deploy the authorized free service/database, and prove persistent state across restart/sleep and public resource/auth boundaries. Do not repeat setup requests while independent work remains.
- [ ] Register the sandbox webhook and receive/resend a genuine event. Verify one observation after duplicate delivery; no exposure means no posterior change. Run the hosted Gemini proposal flow without approving. Record any unmet acceptance honestly.
- [ ] Final independent review, full relevant verification, handoff and publication. M5 is complete only when hosted flow and verified genuine webhook acceptance pass. Defer visual iteration to M8; do not start M6/M7 automatically.

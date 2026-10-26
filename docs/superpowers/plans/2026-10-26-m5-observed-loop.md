# M5 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, with spec then quality reviews.

**Goal:** Host the existing app safely and make verified PayPal outcomes visible and usable as measured evidence, with separately approved recovery actions.

**Architecture:** One Node 24 service and persistent SQLite ledger; isolated pure computation worker; hosted request admission; signature-verified, idempotent event ingestion; derived posterior and explicit recovery proposals. Follow the detailed M5 design, existing overall spec and exact-payload approval invariants.

**Tech stack:** Next 16.4.2, TypeScript, Node worker_threads/SQLite, esbuild for the independent worker bundle, existing PayPal Sandbox SDK, Render.

## Task 1: Bound CPU work outside the web process

Files: create `src/twin/worker-entry.ts`, `src/twin/worker-client.ts`, `src/twin/worker-client.test.ts`, `scripts/build-workers.mjs`; modify `package.json`, lockfile, `src/agent/tools.ts`, `src/app/api/simulate/route.ts`; add meaningful route/tool integration regressions.

- [ ] Read installed Next route documentation and current simulation/stress signatures/tests. Write failing tests for seed/result parity, abort-before-start, abort while running, true hung worker timeout, abnormal exit, capacity rejection and capacity release after each terminal path. Use a test-only injected worker path/constructor for hung/crash fixtures; never expose this in request JSON.
- [ ] Build a pure, independently bundled CommonJS worker with explicit esbuild dev dependency. Build it for dev/test/production through package scripts into ignored `build/`; it imports only twin math, receives structured jobs and emits results or sanitized errors. Pass an empty environment, a 128 MiB heap limit, and no ledger/provider code.
- [ ] Add async compare/stress adapters with a 30-second hard parent timeout and one process-wide active worker. Abort must terminate the worker, listeners/timers must be cleaned, and capacity must stay owned until termination completes. No synchronous fallback. Tests may shorten timeouts through server-only injection.
- [ ] Await adapters in agent tools and manual route, preserving synchronous injected test dependencies and current exact seed/options/results. Bound request bodies for the manual route, pass request abort and map resource/timeout failures safely.
- [ ] Run focused new and existing twin/tool/HTTP/replay tests, typecheck and zero-warning lint. Update current-state with verified task status and limitations, then commit `feat(twin): isolate bounded simulation workers`.
- [ ] Independent spec review, then quality review; fix and re-review findings before Task 2.

## Task 2: Hosted admission and administrator access

Files: new `src/hosting/` configuration, session and durable-limit modules with tests; admin session route/component; wrap agent/manual/proposal/PayPal polling routes; `.env.example`.

- [ ] Test hosted fail-closed configuration, wrong/missing/expired/tampered cookies, same-origin and CSRF checks, bounded login/body handling and public/private route separation before implementation.
- [ ] Implement explicit hosted mode (mandatory on Render), a strong secret, hashed constant-time password checks, authenticated expiring cookies, login/logout, and a small accessible admin control. Preserve local development behavior. No admin credential in client props/logs.
- [ ] Add SQLite-backed hashed-client and global quotas, atomic admission and expiry cleanup. Apply conservative agent, simulation, polling and login limits; test header spoofing cannot bypass the global cap, parallel admission, restart behavior and safe Retry-After. Preserve existing run/provider limits.
- [ ] Protect approval/rejection/reset endpoints, require same-origin for public mutations, expose safe hosted capability state. Test API paths directly rather than only hidden buttons.
- [ ] Run focused integration/security tests, typecheck/lint; update handoff; atomic commits and spec/quality reviews.

## Task 3: Verified, deduplicated sandbox webhook observations

Files: new `src/paypal/webhooks.ts`, `src/ledger/webhooks.ts`, `src/app/api/paypal/webhook/route.ts` and tests; extend ledger migrations; safe observations GET route.

- [ ] Write failures for missing/bad signatures, retryable verification failure, duplicate/concurrent delivery, unknown pilots, subscription versus sale identifiers, malformed/oversized input, unsupported events and out-of-order event times. Use recorded/synthetic sanitized payloads and fake verification, never disabled production verification.
- [ ] Use SDK-supported webhook verification if available; otherwise a narrowly scoped sandbox OAuth REST helper with bounded timeout. Require configured webhook ID and all transmission headers, and strict SUCCESS. No arbitrary URL fetches, live endpoint or raw event/payer persistence.
- [ ] Transactionally record unique event ID and safe observation together; rollback permits retry after ingestion failure. Normalize timestamps/status/payment facts and preserve receipt versus event time. Read-back may enrich facts without changing the signed event.
- [ ] Expose safe observation summaries; test polling cannot create event duplicates, and unauthorized source data never reaches the ledger/model. Update handoff, verify and commit; spec/quality reviews.

## Task 4: Derive measured discount outcomes and posterior

Files: new `src/ledger/discount-outcomes.ts` and tests; update verified execution/read-back observations, merchant view, twin API and minimal evidence UI.

- [ ] Test zero exposure after an override alone, fractional elapsed exposure bounded by verified active observations/campaign end, one cancellation, out-of-order and duplicate events, unverified/failed PATCH exclusions, restore boundaries, unrelated status/payment failure exclusions and immutable repeated posterior reads.
- [ ] Derive reason-specific subscriber-months only from verified discount executions and qualified observed intervals. Aggregate once against canonical baseline and call existing `updateDiscountEffect`; do not mutate the merchant singleton or infer survival from silence. Retain an observational limitation in provenance.
- [ ] Show measured event count/exposure/changes separately from simulation assumptions. Verify agent/manual paths receive a fresh derived twin consistently and classifier updates preserve observed effects.
- [ ] Focused integration tests plus unchanged canonical/replay checks where no outcomes exist; handoff, commit and spec/quality reviews.

## Task 5: Separate recovery proposal and restricted demo reset

Files: extend `src/ledger/proposals.ts`, execution layer, proposal API/review UI; new admin reset preview/confirm API and tests.

- [ ] Test fresh approval/hash requirement, source verified targets only, list-price immutability, no arbitrary source/revert-of-revert, registration and current-price races, duplicate claim, partial execution and no revertAfter on a revert.
- [ ] Add a discriminated revert action with source reference and exact per-target expected/current-to-list prices. Never reuse the original benefit prediction as a revert forecast. Preview it, then use the existing explicit approval and atomic execution flow with precondition GETs and read-back.
- [ ] Add admin reset preview/hash/explicit confirmation restricted to the registered cohort and canonical list price, with bounded targets and logged outcomes. Preserve all historical rows and never auto-run. Test unauthorized API access, preview tampering, registration changes and partial failures.
- [ ] Minimal accessible UI controls only; preserve unchecked confirmation and no agent recovery tools. Offline checks, handoff, atomic commits, spec then quality reviews. No live subscription writes during implementation.

## Task 6: Prepare and validate deployment

Files: `render.yaml`, Node/start/build configuration, health route, deployment/import helpers and `docs/research/m5-hosting-validation.md`; update README, architecture/current-state and roadmap status.

- [ ] Prepare one-instance persistent-disk blueprint, PORT-aware start, runtime configuration validation and no build-time secrets. Document private environment setup, safe existing-pilot import, cache placement/import, consistent SQLite backup/recovery and disk restart limitations. Never copy an open SQLite file without its WAL; use a supported consistent backup.
- [ ] Run full tests/typecheck/lint/build, hygiene scan and local production browser acceptance, including real worker integration and protected admin paths. Record exact results before provisioning.
- [ ] Resolve hosting budget/account access and show final paid configuration before purchase. Configure secrets privately, deploy authorized service, prove persistent state across restart and public resource/auth boundaries.
- [ ] Register the sandbox webhook and receive/resend a genuine event. Verify one observation after duplicate delivery; no exposure means no posterior change. Run the hosted Gemini proposal flow without approving. Record any unmet acceptance honestly.
- [ ] Final independent review, full relevant verification, handoff and publication. M5 is complete only when hosted flow and verified genuine webhook acceptance pass. Defer visual iteration to M8; do not start M6/M7 automatically.

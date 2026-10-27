# M5: hosting and the observed loop

<!-- Generated implementation detail for the approved overall design and M5 roadmap. -->

The user authorized M5 after accepting M0–M4 and deferred further visual iteration to M8. Preserve the existing navy/gold workspace and all exact-action approval controls. This design elaborates the already approved hosting, verified webhooks, posterior updates, separately approved reverts and restricted reset. No deployment, purchase or sandbox subscription mutation is implied by local verification.

## Boundaries and order

Use one Node 24 **Render Free** web-service instance and an authoritative **Turso libSQL** database. The user selected this free deployment on 2026-10-27; [decision 0006](../../decisions/0006-free-render-and-turso.md) and the [storage adaptation plan](../plans/2026-10-27-m5-free-storage.md) supersede the original paid-disk assumption. Preserve local SQLite and the sandbox-only PayPal boundary. After computation isolation and access controls, implement the async storage boundary and migrate durable consumers, then resume webhook ingestion, measured evidence, recovery actions and deployment acceptance. Render's ephemeral disk is never the hosted source of truth.

The agent keeps its seven existing tools and cannot approve, execute, reset or change deployment configuration. Annual execution stays in M7. UI changes here are limited to observed evidence, recovery review and admin access controls.

## CPU isolation

Bundle a pure twin worker independently of the Next server. Both manual comparison and agent simulation/stress use the worker by default. Pass only structured twin/strategy/options data; no environment credentials, ledger or network dependency belongs in it. A parent timer terminates the worker after 30 seconds; request cancellation also terminates it. Bound active computation to one worker per instance and its V8 heap to 128 MiB. Always release capacity after success, error, cancellation, exit or timeout. Never fall back to synchronous production computation. Existing injected synchronous test implementations remain usable through an awaited adapter. Seeded mathematics and results remain unchanged.

## Hosted access and budgets

Hosted mode is explicit and mandatory on Render. Public visitors may inspect the synthetic dashboard and run bounded simulations/agent proposals. Merchant approval/rejection and admin reset require a server-validated admin session. Use a strong server-only admin password, short-lived HttpOnly/Secure/SameSite cookies, constant-time checks, bounded login attempts and explicit logout. Check same-origin mutation requests against the configured public origin. Webhooks use PayPal verification instead of session/origin checks. Missing hosted secrets/configuration fail closed. Local development preserves current workflows.

Persist admission limits in SQLite so restarts cannot reset them. Apply conservative per-client and global agent quotas, plus simulation and login limits. Hash client identifiers instead of storing raw IP addresses. Configure proxy trust explicitly; a global quota still bounds aggregate consumption if clients vary or proxy headers are forged. Keep the current 32,000-token/run, 10-minute, tool/turn and provider pacing limits. Do not enable paid AI billing or automatic provider fallback. One instance is required because existing rolling provider budgets and leases are process-local.

## Verified events and privacy

Accept a bounded JSON body and required PayPal transmission headers. Verify via the hardwired Sandbox `/v1/notifications/verify-webhook-signature` endpoint with the configured webhook ID; only `SUCCESS` permits ingestion. Never fetch arbitrary certificate URLs. Missing/bad signatures fail closed; verification/network failures are retryable and do not consume event IDs. The PayPal simulator cannot pass this postback verification: hosted acceptance must use a genuine app event or resend.

Atomically deduplicate by PayPal event ID and store an allowlisted observation, not raw payer payloads. Only registered pilot subscriptions are eligible. Subscription events identify `resource.id`; subscription sale events identify `resource.billing_agreement_id`. Unsupported or unrelated verified events may be acknowledged as ignored, without model updates. Retried events, multiple deliveries and polling must not count twice. Preserve event time separately from receipt time. Out-of-order events must not overwrite newer state or fabricate negative exposure. Expose safe observed evidence and verification/source labels in the dashboard.

## Honest discount evidence

A price PATCH/read-back is execution evidence, not a retention outcome. Track exposure only after a successful, price-verified discount execution for a registered pilot, using its recorded segment/reason. Accumulate actual elapsed discounted subscriber-months (30 days/month), capped at the verified discount end or cancellation and never in the future. Count a factual cancellation once per open episode. Current PayPal cancellation facts prove neither voluntary intent nor discounted recurring price: exclude the entire ambiguous episode, including preceding survival, from posterior calibration. Cancellation after an uncertain status/price boundary still censors prior survival; cancellation after a verified different-price restore, expiration, approved end or next episode does not belong to that closed episode. Current qualified posterior cancellation count is zero. Suspensions, payment failures and expiration are never classified as voluntary cancellation. Stop exposure when the discount is restored or status is no longer verifiably active. Do not infer continued survival from absence of events: extend only through a verified event/read-back demonstrating the subscription state.

Derive the posterior from the immutable canonical twin plus the deduplicated measured outcomes on each read. Never repeatedly update an already updated singleton. Reuse `updateDiscountEffect` with its Gamma–Poisson interpretation and baseline hazard, retaining the observational/assumed-counterfactual limitation. New twins are copies; history and frozen classifier fixtures stay unchanged. An activation/update webhook with no discounted exposure records an observation but changes no effect parameter. UI distinguishes this from an actual posterior update and separately shows factual exposure/cancellations, calibration exposure, censored episodes and parameter changes. Evidence remains observational with an assumed counterfactual, selection/censoring limitations and no causal retention claim. See decision 0007 for the qualification policy.

## Revert and reset

Create a separate hash-bound revert proposal from verified executions of a prior discount. Snapshot exact registered targets and the original list price; reject arbitrary target/price requests, unresolved source execution, unregistered targets and reverts of reverts. Re-read before executing so an unrelated later price change is not overwritten. Revert has its own explicit merchant approval and atomic claim; it never inherits approval. Do not present the original discount prediction as a simulated revert benefit. Its result follows the existing partial-failure/read-back report. Successful revert does not schedule another revert.

Admin demo reset is an explicit preview/confirmation flow restricted to currently registered pilots and the canonical list price. Store the preview as a proposed recovery action and bind confirmation to its exact payload/hash; confirmation supplies its own administrator approval and uses the same atomic execution claim. Revalidate registration/price before execution and audit each attempt and result. Never clear audit/history or recreate subscriptions. No automatic reset, scheduled PayPal write or agent reset tool. Local tests use fake PayPal clients; live mutations require the user's explicit execution instruction.

## Deployment and acceptance

Prepare a Render Free blueprint, portable setup/recovery instructions, dynamic `PORT` binding, health endpoint, Node version and a bounded build. The hosted ledger and classifier cache live in Turso; no Render disk is provisioned. Runtime secrets are entered privately, never committed or pasted into chat. Seed/register existing healthy pilots through an explicit safe import, not provisioning replacements. Provide a safe cache import path without exposing corpus labels to providers. Merely entering Turso credentials does not switch the local backend before the explicit import and selection.

After account access is configured privately, deploy on the selected free plans and verify health, persistence across restart/sleep, resource admission, real agent proposal and untouched confirmation controls. Disclose and measure Render Free wake-up behavior. Configure the app's sandbox webhook and receive/resend one genuine app event; verify exactly one safe observation and unchanged posterior when no qualifying outcome exists. Approval/execution acceptance remains separate until explicitly authorized. Record actual results and remaining gaps; never mark M5 complete on local tests alone. The user requested all unblocked work before account setup; do not stop offline implementation for missing deployment credentials.

## Verification

Use focused tests for real worker timeout/cancellation/release and exact numeric parity; hosted auth/origin/rate bypasses and restart durability; signature failures, event dedup/retry/order and privacy; measured exposure and posterior replay; revert/reset tampering, state races and partial failures. Finish with full tests, typecheck, lint, production build, tracked-file secret/path scan and browser checks. Each implementation task receives independent spec then quality review and updates the persistent handoff.

Sources checked: [Render persistent disks](https://render.com/docs/disks), [Render Next.js deployment](https://render.com/docs/deploy-nextjs-app), [PayPal webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/). Installed Next.js route-handler documentation governs API implementation.

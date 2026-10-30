# M5 verified webhook result evidence

<!-- Generated task note within the user-authorized M5 deployment/verification scope. -->

## Problem and decision

PayPal accepted a resend with HTTP202 but its public event API omits delivery attempts. The Developer Dashboard is stuck during sign-in, and Render Free disables request logs. Existing unit tests prove idempotent ingestion, but neither a queued resend nor unchanged rows proves that a genuine duplicate was verified and acknowledged by the deployed handler.

Add minimal application-level operational evidence after successful signature verification and completed ingestion: one fixed log line for each allowlisted result (`observed`, `ignored`, `duplicate`). Use no event/subscription/transmission identifiers, provider payload, headers, tokens, credentials or customer data. Unknown injected results produce no line. Logging is best effort; its failure must never change the existing HTTP acknowledgement after a committed ingestion. No database, payload, signature, approval, posterior, budget, retry or timeout behavior changes.

This is a contained verification/operability adjustment to the approved M5 signature-verification and safe-logging boundaries, rather than a new milestone or a new subscription test. Existing genuine events from the cancelled disposable probe are reused.

## Execution and gates

1. Fresh implementer reads the installed Next route-handler guide and current webhook code/tests. Write failing tests for privacy-safe allowlisted result logging, signature/ingestion failure producing no success line, unknown result suppression and logging failure preserving HTTP200.
2. Add the minimal best-effort fixed-line log after verification/ingestion; run relevant webhook/storage tests, typecheck and focused lint. Update the handoff task record without claiming live acceptance. Do not access runtime secrets, production data, network providers or app controls.
3. Independent spec review, then quality review; resolve findings before parent integration/deployment.
4. Parent runs full relevant verification, publishes the feature branch, manually deploys the Free service, and requests one documented resend of a previously observed genuine event. Match the deployed `duplicate` line to the resend window and unchanged event/observation hashes/counts plus unchanged posterior. No fake signature or simulator can satisfy acceptance.
5. Only after live evidence and final reviews pass, reconcile roadmap/handoff records and merge M5 into main. Keep the four pilots unchanged and the disposable probe cancelled. M6/M7 remain separate.

Parent integration: independent spec and quality reviews passed without findings. Full parent verification passes **793 tests across 80 files**, generated Next types/strict typecheck, focused zero-warning lint and diff checks. Deployment and actual verified duplicate evidence remain pending; the earlier 781-test Linux CI covers the preceding code revision.

## Local implementation handoff

The handler now emits only `paypal.webhook result=observed`, `paypal.webhook result=ignored` or `paypal.webhook result=duplicate` through `console.info`, after exact successful verification and completed ingestion. Strict result equality suppresses unknown injected values; a sink exception is swallowed independently of the existing response and storage error handling. Tests use synthetic requests and an in-memory ledger to cover fixed log arguments, commit-before-log ordering, duplicate storage, rejected verification, failed ingestion, unknown results and sink failure preserving committed ingestion plus HTTP200. TDD RED: the new success-line and sink-attempt tests failed because no lines were emitted; GREEN: `npx vitest run src/paypal/webhooks.test.ts src/ledger/webhooks.test.ts src/ledger/connection.test.ts` passed 53 tests across three files. `npx tsc --noEmit`, focused ESLint and `git diff --check` also passed. TypeScript used existing generated route types to avoid loading local environment files through `next typegen`. Existing Vite configuration and experimental SQLite warnings remain. No runtime database, private environment file, provider or deployment was accessed. Independent reviews and genuine deployed resend evidence remain outstanding; this local result does not complete M5 acceptance.

Live acceptance passed at 4da3c6e: Render instance 58kfv logged the verified duplicate result five seconds after the controlled genuine cancellation-event resend. Full business-table count/hash equality, one observation per original event and zero posterior changes were verified. Parent and Linux CI pass 793 tests/typecheck/lint/build; final spec and quality reviews passed without conditions. No raw payload, credential, new subscription or simulator was used. Final merge/publication is complete on main.

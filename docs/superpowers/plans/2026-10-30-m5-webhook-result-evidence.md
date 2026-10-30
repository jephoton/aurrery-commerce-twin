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

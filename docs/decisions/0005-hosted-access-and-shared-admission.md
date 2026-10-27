# 0005: Hosted access and shared client admission

**Status:** accepted local M5 Task 2 checkpoint at `38e0a2a`, independently reviewed. Decision 0006 supersedes the Render persistent-disk assumption. The B2 async session/quota migration is an intermediate implementation awaiting review; hosted acceptance remains pending.

## Context

M5 permits public synthetic exploration but keeps PayPal mutation under merchant control. Hosted requests can arrive through a proxy. A forwarded IP header is client-controlled unless the proxy's overwrite and hop semantics are verified; the available Render description does not establish enough detail to select one safely. The existing process-local agent lease and model pacing also disappear on restart, so they cannot replace a durable visit budget.

## Decision

Activate hosted access on `HOSTED_DEMO=true` and unconditionally on Render. Require an exact HTTPS origin, separate generated administrator password and session secret. An explicit `APP_URL` takes precedence; Render may use its trusted `RENDER_EXTERNAL_URL` when `APP_URL` is unset. Render Free requires explicit `LEDGER_BACKEND=turso`, a validated Turso URL and token, and no `LEDGER_PATH`. Explicit non-Render hosted SQLite mode retains an absolute durable `LEDGER_PATH`. Reject hosted mutations when any requirement is invalid. Require configured-origin checks for public mutations and a server-validated, revocable two-hour administrator cookie for approval/rejection. A future reset endpoint must use the same boundary.

Use authoritative ledger write transactions for fixed-window admission, session creation, validation and revocation, checking foreign-key enforcement on the actual transaction handle. Admit before expensive work and before password comparison. Hash bucket identifiers with the server secret. Until proxy semantics are verified, assign every visitor to one shared client bucket. This makes the three-agent-runs-per-client hourly cap effectively three runs per hour across the entire hosted demo, while the independent six/hour and twenty/day global caps still apply. Never infer an IP from an unverified `X-Forwarded-For` or another caller-supplied header.

## Consequences

The shared capacity is conservative and may cause visitors to receive 429 responses sooner than expected. A later change to verified proxy identity must include spoofing and multi-hop tests, preserve the global caps and update the public capacity description. Sessions remain server-only; logout and password rotation revoke their authority. Local development keeps its existing workflow. This B2 migration alone does not establish Render Free readiness: signal cache/import remains on raw SQLite until B3, and live remote acceptance remains pending. This decision does not authorize deployment, provider billing, subscription writes or a reset operation.

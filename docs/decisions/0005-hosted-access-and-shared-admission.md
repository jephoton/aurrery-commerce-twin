# 0005: Hosted access and shared client admission

**Status:** proposed in M5 Task 2; local implementation pending independent review and hosted acceptance.

## Context

M5 permits public synthetic exploration but keeps PayPal mutation under merchant control. Hosted requests can arrive through a proxy. A forwarded IP header is client-controlled unless the proxy's overwrite and hop semantics are verified; the available Render description does not establish enough detail to select one safely. The existing process-local agent lease and model pacing also disappear on restart, so they cannot replace a durable visit budget.

## Decision

Activate hosted access on `HOSTED_DEMO=true` and unconditionally on Render. Require an exact HTTPS `APP_URL` origin, separate generated administrator password and session secret, and an explicit absolute SQLite path on durable storage. Render additionally requires that path under `/var/data/`. Reject hosted mutations when any requirement is invalid. Require configured-origin checks for public mutations and a server-validated, revocable two-hour administrator cookie for approval/rejection. A future reset endpoint must use the same boundary.

Use SQLite fixed-window admission before expensive work and before password comparison. Hash bucket identifiers with the server secret. Until proxy semantics are verified, assign every visitor to one shared client bucket. This makes the three-agent-runs-per-client hourly cap effectively three runs per hour across the entire hosted demo, while the independent six/hour and twenty/day global caps still apply. Never infer an IP from an unverified `X-Forwarded-For` or another caller-supplied header.

## Consequences

The shared capacity is conservative and may cause visitors to receive 429 responses sooner than expected. A later change to verified proxy identity must include spoofing and multi-hop tests, preserve the global caps and update the public capacity description. Sessions remain server-only; logout and password rotation revoke their authority. Local development keeps its existing workflow. The user has requested a free host and a storage alternative, so the actual hosting/storage choice remains open; this SQLite version cannot safely run on ephemeral stateless storage. This decision does not authorize deployment, provider billing, subscription writes or a reset operation.

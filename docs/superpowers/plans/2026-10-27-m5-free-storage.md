# M5 free storage adaptation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, with spec then quality reviews after each task.

**Goal:** Make the selected Render Free + Turso deployment durable without weakening execution authority or losing local SQLite compatibility.

**Architecture:** An async SQL boundary supports an authoritative Turso libSQL client remotely and the current Node SQLite connection locally. Explicit transaction handles preserve atomic operations; local connection access is serialized during transactions. Existing twin workers stay independent of storage. [Decision 0006](../../decisions/0006-free-render-and-turso.md) supersedes the paid-disk assumption.

**Tech stack:** Node 24 SQLite, TypeScript, supported `@libsql/client`, Next 16 route handlers.

## Storage Task A: async adapters and transaction proof

Files: new `src/ledger/connection.ts` and tests; export reusable schema from `src/ledger/db.ts` or a focused schema module; package/lock; `.env.example`.

- [x] Write failing tests for local SQL read/write/changes, rollback, two competing conditional claims, serialized local transaction isolation (an unrelated query must wait), same schema/constraints on a real libSQL file client, restart persistence, and remote transport timeout/failure with no ephemeral fallback.
- [x] Introduce small async `query`/`execute`/transaction interfaces with explicit transaction callback handles. Preserve SQLite value types and affected-row semantics. Wrap the existing local `DatabaseSync` rather than create an independent in-memory test database. Serialize all local operations against an active async transaction; no implicit ambient transaction or network/model call inside callbacks.
- [x] Add the supported libSQL client as a production dependency, remote HTTPS/libsql URL validation and server-only credential configuration. Select `LEDGER_BACKEND=sqlite|turso` explicitly, defaulting to local SQLite; merely adding cloud credentials must not switch the local database. Reject partial selected-remote credentials. Bound network requests with an AbortSignal-based fetch timeout and sanitized errors; do not log URL/token/request objects. No offline/local-first write mode, background sync, automatic query retry or silent fallback.
- [x] Provide idempotent schema initialization/migration at runtime, with no runtime-disk or network dependency during Next build. Use SDK write transactions and primary/authoritative operations for decisions; test adapter behavior against a real local libSQL client, and injected HTTP for protocol timeout/auth failures. A cloud credential is not required for this offline task.
- [x] Keep production consumers on their current path for this independently reviewable foundation commit; document that free-host readiness remains incomplete until Task B. Run focused tests/typecheck/lint; handoff, atomic commit, spec and quality review.

## Storage Task B: migrate durable workflows and prepare safe import

Execute the following three slices sequentially, each with a fresh implementer and independent spec then quality review. They form one migration; intermediate commits are not hosted readiness or permission to switch the running app. Do not start the next slice with unresolved review findings.

### B1: proposal and execution authority

Scope: async settings/audit helpers, proposals/registered pilots/state transitions, execution recording, PayPal setup/sync/status and core CLI callers, proposal routes and agent registry/proposal awaits, plus affected tests. Keep synchronous injected test dependencies usable through awaited adapters. Group state/audit writes and verify FK enforcement in the actual write transaction. Cover conditional claim races and storage failure before/after external effects with fake PayPal calls. Leave hosting/signals/import to later slices; their raw local SQLite access remains a documented intermediate risk, so do not build/deploy/switch a mixed backend.

### B2: session and quota authority

Scope: async hosting store/guard/session API and every guarded route caller, hosted configuration, access-related tests. Move sessions, revocation and admission to authoritative transactions with verified constraints, preserve existing security behavior, and add two-connection concurrency/restart tests. Replace Render's obsolete disk requirement with the selected remote backend requirements. Signals/raw import remain pending B3; do not claim full migration yet.

### B3: classifier cache, explicit import and integrated migration acceptance

Scope: bulk async classifier cache/import/classification and their test/CLI callers; safe local-to-empty-remote import; production raw-query audit and final integration. Preserve sync test cache injection through an awaited interface when practical. Remove every remaining production raw-ledger bypass, guard accidental hosted local access, test bulk round-trip bounds and genuine provider replays, and complete the dry-run/import validation. Only after B3 reviews/full verification may the app be built for remote-hosted acceptance.

### Cross-slice acceptance checklist

Files: ledger/proposals/db helpers, execution, hosting store/guard/session, PayPal setup/status, signals cache/import/classifier, agent tools/run dependencies, route handlers, CLI helpers and affected tests; add safe import/check tooling and portable instructions.

- [ ] Convert all production durable operations to the async adapter. Conditional approve/claim and deduplication must remain server-atomic; group related ledger/audit writes transactionally through explicit handles. Verify `PRAGMA foreign_keys` on the actual authoritative write-transaction handle and fail closed if enforcement is absent; the HTTP client's initialization call uses another logical connection. Use authoritative write transactions for session validation/revocation and decision authority, not stale replica reads. Never hold transactions over PayPal/model calls. Treat ambiguous claims/storage acknowledgements as requiring reconciliation, never as permission to repeat an external write. A failed ledger acknowledgement after a PayPal call must not turn into an automatic retry; document unresolved execution states honestly.
- [ ] Adapt classifier cache with awaited persistence and bounded bulk reads/writes; avoid one remote round trip per cached message. Preserve provider/model/content fingerprints, truth-label separation and existing test cache injection. Update agent registry/proposal dependencies and routes to await durable results without changing the tool catalog, priors or rules.
- [ ] Move hosted sessions and quotas to the same authoritative backend. Test concurrent admissions across two clients/handles, restart durability, expiration/revocation and rollback. When Render + remote storage is selected, remove the obsolete local `/var/data/` requirement; missing remote hosted settings must fail closed before any writes or inference. Raw local `ledger()` must not be used by hosted consumers.
- [ ] Add an explicit consistent local-to-empty-remote import, with dry-run/count/hash checks, refusing a nonempty target or partial credentials. Preserve existing IDs, proposal hashes, pilot metadata, classification cache and audit history. Never overwrite the source, copy an open WAL file naively, delete history or print token-bearing URLs. Implement and test offline; the parent alone may use private runtime credentials for the eventual authorized cloud import.
- [ ] Update affected tests meaningfully for async APIs. Verify local compatibility plus remote/libSQL fixture parity, atomic claim races, no duplicate execution and cache identity/replay. Full suite, typecheck, lint, build preparation, hygiene scan, handoff and independent reviews. No live PayPal or model call in implementation.

After both storage tasks, resume M5 webhook/observation/recovery work using the async boundary. The hosting task uses Render Free without a disk and Turso credentials entered privately, then proves persistence across Render restart/sleep. Webhooks require a genuine signed sandbox event. M5 remains incomplete until hosted acceptance passes.

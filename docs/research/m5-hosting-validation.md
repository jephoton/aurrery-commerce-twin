# M5 hosting and observed-loop validation

<!-- Generated validation record. Preparation is not deployment acceptance. -->

## Baseline and scope

M5 started from published main `35867fc`; M4 application code is `e194c25`. The existing acceptance is 454 tests, typecheck, lint and production build, with local Gemini/browser validation. M5 work is on `feat/m5-observed-loop`. Further visual iteration is deferred to M8 at the user's request.

The M5 [design](../superpowers/specs/2026-10-26-m5-observed-loop-design.md) and [implementation plan](../superpowers/plans/2026-10-26-m5-observed-loop.md) define the acceptance boundaries. Tasks 1–3 and the async storage adaptation have passed independent offline spec and quality reviews. No hosted deployment acceptance has been established yet.

## Deployment research

The original paid-disk research below is historical and superseded by the accepted Render Free + Turso revision. Current deployment and recovery instructions are in [the runbook](../runbooks/render-turso.md); no paid resource is authorized.

Official sources checked on 2026-10-26:

- [Persistent disks](https://render.com/docs/disks): disks require a paid service; only the mounted filesystem survives redeploy/restart. A disk is accessible to one service instance, is unavailable during builds/pre-deploy commands, and prevents horizontal scaling and zero-downtime deploys. Plan runtime initialization and a single instance accordingly.
- [Next.js deployment](https://render.com/docs/deploy-nextjs-app): the full app needs a Node web service rather than a static export. Bind the service to its assigned port and keep the pure computation bundle in the deployed build.
- [Compute plans](https://render.com/docs/compute-plans): the smallest paid web-service plan is listed as 0.5 CPU / 512 MB, identifier `0.5c-512mb`, legacy name `starter`. A 128 MiB worker heap limit is not a whole-process RSS guarantee; measure the combined Next/worker footprint before accepting that size.
- [Pricing](https://render.com/pricing): verify the actual plan/disk cost in the service creation preview before purchase. No purchase or spending authorization has been inferred. The pricing page's current machine-readable text omits the compute prices, so no unverified total is quoted here.
- [Blueprint schema](https://render.com/docs/blueprint-spec): the current schema and validation endpoint should validate the prepared configuration before provisioning. Do not assume old plan aliases remain the preferred identifiers.

No Render-specific connected tool or installed Render CLI was found in the initial discovery. Browser/account access or a deliberately configured CLI/API will be needed for provisioning. An unrelated Sites deployment would not provide the approved Node/SQLite-disk architecture.

## PayPal verification research

[PayPal's integration guide](https://developer.paypal.com/api/rest/webhooks/rest/) requires the stored webhook ID and transmission headers for postback verification. It documents retries up to 25 times over three days for non-2xx delivery. Its webhook simulator events are not associated with an app and **cannot** be verified by the postback endpoint; they cannot establish this implementation's hosted acceptance. Use an actual sandbox app event or resend instead, preserving event IDs for deduplication.

The installed SDK exposes Sandbox subscription calls and an OAuth controller, but the initial source inventory found no webhook verification controller. If no supported helper is available, a small bounded Sandbox-only REST verification adapter is appropriate; it must never fetch the inbound certificate URL or persist bearer tokens/raw payer payloads.

Follow-up source inspection: `paypal().client.clientCredentialsAuthManager` is public in the installed SDK and supports bounded Sandbox OAuth token retrieval. The verification adapter can reuse that authority without introducing a second credential store. [PayPal's current verification endpoint](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post) accepts the transmitted event and signature metadata; retain the original strict UTF-8 raw event JSON verbatim in the verification request, using parsing separately for validation, then persist only normalized allowlisted facts. Never verify a stripped/reconstructed event or treat a local fake verifier as hosted acceptance.

[Subscription event names](https://developer.paypal.com/api/rest/webhooks/event-names/) include activation, update, cancellation, suspension, expiration and failed payment; subscription payments use sale events. Cancellation is distinct from suspension/payment failure. Record event identity/type/time so the posterior can make that distinction instead of interpreting every non-active status as voluntary churn. The webhook endpoint is exempt from browser-origin/session checks but requires signature verification, bounded ingress and its own resource admission.

## Free hosting revision (2026-10-27)

The user explicitly requested free hosting and a storage alternative. Paid Render/disk provisioning is excluded. The user selected **Render Free plus a Turso free remote SQLite-compatible database**. The async SQLite/libSQL adapter and all durable consumers have passed offline reviews; remote persistence/transaction acceptance remains pending. Render preserves the current long-running Node process; its free service sleeps after 15 idle minutes, may take about a minute to wake and loses local files on sleep/restart. Remote storage must be authoritative for proposals, approvals, execution claims, observations, classification cache, sessions and quotas. A periodically uploaded local SQLite backup is insufficient.

Turso currently lists a no-card $0 plan with 5 GB storage. Its official SDK documentation distinguishes the new Turso engine from the SQLite-derived libSQL backend and their clients. Choose a supported backend deliberately, test transaction/claim semantics and bound network operations before adapting the application. Do not assume the current synchronous `node:sqlite` API is a drop-in remote client. Do not use offline/local-first writes for payment authority or acknowledge success before remote commit.

Alternatives presented: Vercel Hobby plus Turso (five-minute free function maximum requires a shorter hosted agent deadline and distributed lease/budget coordination), or Oracle Always Free VM/block storage (retains local SQLite, but requires VM/TLS operations and available home-region capacity). No account, database or service has been created. Task 2's generic access implementation remains useful, but its local SQLite persistence is not deployment acceptance on a free stateless host.

Sources checked: [Render Free](https://render.com/docs/free), [Turso pricing](https://turso.tech/pricing), [Turso TypeScript clients](https://docs.turso.tech/sdk/ts/reference), [Vercel limits](https://vercel.com/docs/functions/limitations), [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Acceptance tracking

| Check | State |
| --- | --- |
| Pure worker, hard timeout, cancellation and capacity | reviewed at `35da88f`; full 474 tests/41 files pass; production build/browser integration pending |
| Hosted access, durable request limits and secret configuration | implemented locally at `38e0a2a`; spec and quality reviews passed; async free-host persistence adaptation reviewed; remote acceptance pending |
| Async SQLite/libSQL adapter | reviewed at `75068b7` + oversized-response cleanup `31e2904`; parent full 518 tests/48 files passed |
| Async proposal/execution authority (B1) | reviewed at `0e4270c`; parent full 528 tests/51 files and 173-file hygiene scan passed |
| Async session/quota authority (B2) | reviewed at `b93f55d` and concurrency-test follow-up `3cfa9e0`; both reviews passed; parent full 537 tests/53 files at the implementation checkpoint and follow-up seven-test store suite passed |
| Bulk classifier cache and safe import (B3) | reviewed at `16ee349`, target-schema correction `8007080` and legacy-order correction `0be333b`; parent full 561 tests/56 files passed; actual read-only source dry-run and shared-read DB/WAL hashes passed without remote access |
| Signature verification and transactional event deduplication | reviewed at `adc93d1` with accepted bounded OAuth clarification `160ccf2`; full offline suite 582 tests/59 files; parent focused 35 tests/3 files and typecheck; quality independently 42 tests/5 files; genuine delivery pending |
| Measured exposure and repeatable posterior derivation | reviewed at `9e9374c` + current-run evidence `a4a936b`; quality 91 focused tests/seven files; parent production build passed with invalid runtime storage settings; browser/live acceptance pending |
| Separate approved revert and restricted reset | revert reviewed through `dc1ab9b`; full offline 667 tests/69 files; spec pagination/evidence corrections and quality price-format/reuse corrections passed; admin reset reviewed through `dd19c76`; full offline 752 tests/74 files; independent spec125/7 and quality156/10 pass; final build/browser/live acceptance pending |
| Local production/browser validation | pending |
| Hosting budget/account and final configuration | user selected Render Free + Turso; async durable storage adaptation reviewed locally; private settings deferred while unblocked work continues; no purchase |
| Deployed URL and persistent state across restart | pending |
| Genuine verified sandbox webhook observation | pending |
| Hosted Gemini proposal, confirmation unchecked | pending |

Live subscription mutations, merchant approvals, admin resets and paid provisioning have not been performed in M5 preparation.

Verification compatibility follow-up: the official guide warns that parsing/re-serializing the webhook event can fail signature checks; the original JSON text must be preserved as the postback event value. Its certificate example uses api.sandbox.paypal.com, which must not be rejected merely because OAuth and verification calls use api-m.sandbox.paypal.com. Certificate metadata is never fetched by this app. These are offline wire-format requirements, not evidence of a genuine signed delivery.

## Free deployment preparation follow-up

The [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Free service limitations](https://render.com/docs/free) and [Next.js deployment guide](https://render.com/docs/deploy-nextjs-app) were checked again on 2026-10-27. Prepare a Node web service with an explicit free plan, no disk, one instance, PORT-aware start and the worker bundle in its build. The platform's ephemeral filesystem cannot hold authoritative state. Keep model, PayPal and Turso calls out of build/prerender; validate private runtime configuration separately. Free sleep/restart and webhook retry behavior require live acceptance, not just local health checks. Blueprint preparation and schema validation do not provision a service or prove remote persistence.

## First production-build integration finding

The first M5 production build reproduced 117 Turbopack errors: the statically imported Node Worker constructor combined with its server-only fixture-path override produced a broad workspace module context, pulling docs, ignored scratch files and tests into compilation. Runtime resolution through Node 24's process.getBuiltinModule confines construction to Node instead. The nine worker behavior tests pass and the next build compiled successfully; that attempt then stopped on intentionally incomplete Task 4 snapshot regression types during active implementation. A final full build is still required. No ignored files were moved into the product or silenced through loader exclusions. Build probes deliberately used invalid hosted/Turso runtime settings so storage access would fail rather than contact a real ledger; no deployment acceptance is inferred.

The completed Task 4 snapshot correction and worker fix passed the full parent production build (including typecheck/prerender) with deliberately invalid Turso/hosted runtime settings. This supersedes the intermediate typecheck stop above. Task 4 spec re-review passed 51 tests/six files and quality passed 91 tests/seven files, including worker review. Parent fresh final snapshot/worker checks passed 20 tests/four files. Browser and hosted acceptance remain pending.

## Runtime and recovery source checks

[Render Node version selection](https://render.com/docs/node-version) supports an explicit upper-bounded Node 24 range; do not rely on a changing service default. Its [HTTP health checks](https://render.com/docs/health-checks) run frequently, require a response within five seconds and recommend an operation-critical database query. The health implementation therefore needs bounded/coalesced readiness work, generic failures and no provider/PayPal mutations, rather than an unconditional success response.

[Turso db export](https://docs.turso.tech/cli/db/export) explicitly warns that its exported snapshot may omit the latest changes. Do not treat that alone as an authoritative payment-ledger backup. Deployment/recovery preparation must use a consistent authoritative read or prove synchronization before relying on an export. Preserve approvals, executions, unresolved coordination and all observations; restoring an older backup cannot authorize replay of possibly completed PayPal writes. Recovery requires comparison with current PayPal and durable records before enabling further execution. No cloud export or restore has been attempted.

## Task 6 offline implementation checkpoint

`render.yaml` prepares one free Node 24 service, no disk, manual deployment, explicit upper-bounded runtime version, dev-tool installation, worker-before-Next build, assigned-PORT start and `/api/health`. Startup validates hosted storage/access, the explicitly selected provider/model/key/pacing and PayPal Sandbox keys without a provider request. The Blueprint selects Gemini 3.5 Flash-Lite; deliberate Groq configuration remains supported without automatic fallback. The genuine webhook ID is optional during URL bootstrap and added privately after Sandbox app registration. Runtime configuration and ledger access remain out of build/prerender. Parent validation against the current official Blueprint schema is still pending.

Health is request-only, Node runtime, generic/no-store, validates a readable worker bundle and a small authoritative storage probe, and inserts no business/audit/quota/session rows. The process-global coalesced probe caches results for two seconds and responds within a 3.5-second dependency deadline. Early deadline responses retain underlying work until settlement, including initialization, so repeated probes cannot start unlimited requests/transactions. The existing per-HTTP response/body bound remains ten seconds. Offline tests verify success/failure/recovery, deadline/ownership, coalescing, runtime-only access, no provider HTTP and zero row changes. Worker job execution and actual production integration remain separate parent checks.

The authoritative export helper opens the existing remote source without schema initialization/migration; it validates and snapshots all canonical tables in one checked primary write transaction without source row changes. It reconstructs a private SQLite backup using importer snapshot validation, verifies counts/ordered hashes/FKs/schema/records and performs a read-only importer dry-run before exclusive publication. An explicit local source uses read-only SQLite online backup, including committed WAL. Logs contain safe manifests, not rows/tokens/paths. Tests use real temporary SQLite/libSQL file clients and cover pending/approved/executing resets and reverts, source execution/episode/event facts, unresolved claims, pilot order, sequences, cache, sessions/quotas, roundtrip manifests, concurrent later-write exclusion, rollback, ambiguous commit, incompatible schema, existing outputs, local source/WAL byte preservation and CLI privacy/flag rejection. A native Windows libSQL handle can outlive `close()`; test teardown uses the repository's existing best-effort fixture cleanup convention. No actual ledger or live remote backup was read.

Initial full offline checkpoint: `npm test -- --maxWorkers=1` passed **775 tests across 80 files** (including the pure worker build); `npm run typecheck` and zero-warning `npm run lint` passed. Existing Vite configuration and experimental Node SQLite notices remain. No Next production build, browser/server, real providers/PayPal, cloud provisioning or private environment/source access occurred in this slice. Final focused checks, diff/hygiene scan and independent reviews follow. Parent owns production build/browser/source dry-run, Blueprint schema validation and all external acceptance. M5 remains incomplete until deployed persistence and a genuine signed event pass.

Final offline verification after the startup environment-order correction: `npm test -- --maxWorkers=1` passed **777 tests across 80 files**; typecheck, zero-warning lint and `git diff --check` passed. The wrapper uses Next's own environment loader before validation while preserving process-environment precedence and generic errors. Four startup tests include the actual tsx CLI entrypoint in an owned temporary cwd with invalid fixture-only `.env.local`, with all child spawning blocked so no server can start even if validation regresses. No repository private environment was read. The 231-file tracked/nonignored hygiene scan found no personal absolute paths or credential-shaped literals. The runbook uses `npm run --silent` for private path arguments so npm's command echo cannot expose them. Final reviews and all external acceptance remain pending.

# M5 hosting and observed-loop validation

<!-- Generated validation record. Preparation is not deployment acceptance. -->

## Baseline and scope

M5 started from published main `35867fc`; M4 application code is `e194c25`. The existing acceptance is 454 tests, typecheck, lint and production build, with local Gemini/browser validation. M5 work is on `feat/m5-observed-loop`. Further visual iteration is deferred to M8 at the user's request.

The M5 [design](../superpowers/specs/2026-10-26-m5-observed-loop-design.md) and [implementation plan](../superpowers/plans/2026-10-26-m5-observed-loop.md) define the acceptance boundaries. No hosted deployment or M5 implementation acceptance has been established yet.

## Deployment research

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

## Free hosting revision (2026-10-27)

The user explicitly requested free hosting and a storage alternative. Paid Render/disk provisioning is excluded. The parent recommends **Render Free plus a Turso free remote SQLite-compatible database**, subject to the user's pending platform preference and a persistence/transaction spike. Render preserves the current long-running Node process; its free service sleeps after 15 idle minutes, may take about a minute to wake and loses local files on sleep/restart. Remote storage must be authoritative for proposals, approvals, execution claims, observations, classification cache, sessions and quotas. A periodically uploaded local SQLite backup is insufficient.

Turso currently lists a no-card $0 plan with 5 GB storage. Its official SDK documentation distinguishes the new Turso engine from the SQLite-derived libSQL backend and their clients. Choose a supported backend deliberately, test transaction/claim semantics and bound network operations before adapting the application. Do not assume the current synchronous `node:sqlite` API is a drop-in remote client. Do not use offline/local-first writes for payment authority or acknowledge success before remote commit.

Alternatives presented: Vercel Hobby plus Turso (five-minute free function maximum requires a shorter hosted agent deadline and distributed lease/budget coordination), or Oracle Always Free VM/block storage (retains local SQLite, but requires VM/TLS operations and available home-region capacity). No account, database or service has been created. Task 2's generic access implementation remains useful, but its local SQLite persistence is not deployment acceptance on a free stateless host.

Sources checked: [Render Free](https://render.com/docs/free), [Turso pricing](https://turso.tech/pricing), [Turso TypeScript clients](https://docs.turso.tech/sdk/ts/reference), [Vercel limits](https://vercel.com/docs/functions/limitations), [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Acceptance tracking

| Check | State |
| --- | --- |
| Pure worker, hard timeout, cancellation and capacity | reviewed at `35da88f`; full 474 tests/41 files pass; production build/browser integration pending |
| Hosted access, durable request limits and secret configuration | implemented locally at `38e0a2a`; independent reviews pending; free-host persistence adaptation remains open |
| Signature verification and transactional event deduplication | pending |
| Measured exposure and repeatable posterior derivation | pending |
| Separate approved revert and restricted reset | pending |
| Local production/browser validation | pending |
| Hosting budget/account and final configuration | free hosting required; Render Free + Turso recommended; platform preference pending; no purchase |
| Deployed URL and persistent state across restart | pending |
| Genuine verified sandbox webhook observation | pending |
| Hosted Gemini proposal, confirmation unchecked | pending |

Live subscription mutations, merchant approvals, admin resets and paid provisioning have not been performed in M5 preparation.

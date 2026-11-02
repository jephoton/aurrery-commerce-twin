# Current state (handoff)

_Last material update: 2026-11-02. Milestone-by-milestone history is archived in [docs/history/current-state-log.md](history/current-state-log.md)._

**Aurrery** is a digital twin plus AI agent for subscription merchants. It simulates retention and pricing strategies, then executes merchant-approved actions through PayPal Sandbox. Repo: `jephoton/aurrery-commerce-twin` (public, MIT). Hackathon deadline: 2026-11-13 04:00 SGT. Design: [docs/superpowers/specs/2026-10-22-aurrery-design.md](superpowers/specs/2026-10-22-aurrery-design.md).

## Status

- M0-M7 are complete, including M6 (CSV import, simulate-only imported merchants) and M7 (consent-based annual-plan offers). All are merged on `main` and live at https://aurrery.onrender.com.
- `main` is at the latest commit (application code last deployed at `5b8356f`; later commits are docs only). Hosted acceptance for M5, M6 and M7 passed.
- Hosting: Render Free (Singapore) with an authoritative Turso libSQL ledger. Render tracks `main` with manual deploys only (`autoDeployTrigger: "off"`).
- Active branch for M8 work: `chore/m8-tidy-ups`.
- Last full local gates: 1320 tests, typecheck, lint and build passed (M6 acceptance); Linux CI passed on the deployed commit.

## What's next (M8: Submission)

Per the M8 section of [docs/superpowers/plans/2026-10-22-aurrery-roadmap.md](superpowers/plans/2026-10-22-aurrery-roadmap.md):

1. UI theme pass: a deliberate, stylised identity (celestial star-chart / planisphere look with brass-gold accents; reference notes are in the roadmap).
2. Review tidy-ups: this rewrite, GitHub homepage URL and topics, flaky-test fixes.
3. Judge-facing README with the hosted URL and local setup; warn about the cold start or keep the instance warm during judging.
4. Devpost text, video script and recording (under 3:00, public on YouTube).
5. Final QA on the hosted build and submit with margin before 2026-11-13 04:00 SGT.

## Commands

Node 24 is required (`engines`). Run from the repo root. All scripts below exist in `package.json`.

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Dev server (port 3001, builds workers first) | `npm run dev` |
| Tests (use few workers; see Known issues) | `npm test -- --maxWorkers=2` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Production build | `npm run build` |
| Rebuild twin workers only | `npm run build:workers` |
| Sandbox pilots: create or sync | `npm run paypal:setup`, `npm run paypal:sync` |
| Sandbox read-only status check | `npm run paypal:check` |
| Annual-offer live check (disposable subscription only) | `npm run paypal:annual-check` |
| Ledger backup / restore into an empty target | `npm run ledger:export`, `npm run ledger:import` |
| Regenerate sample merchant files in `public/samples/` | `npm run samples:generate` |
| Agent smoke check against the configured AI provider | `npm run agent:check` |
| Update the Ridgeline golden fixture on purpose | `UPDATE_RIDGELINE_GOLDEN=1 npm test -- src/merchant/ridgeline-golden.test.ts` |

Also available: `twin:inspect`, `signals:evaluate`, `signals:import-cache`, `start`. The ledger scripts do not auto-load `.env.local`; set their environment privately (see the runbook).

## Hosting and operations

- **Deploy:** push to `main` after CI passes, then trigger a manual deploy in Render. Health check path: `/api/health`.
- **Ledger:** Turso libSQL is authoritative when hosted (`LEDGER_BACKEND=turso`); local runs use SQLite at `LEDGER_PATH`.
- **Required environment variable names** (values live only in Render and local `.env.local`; never commit them): `LEDGER_BACKEND`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `ADMIN_PASSWORD`, `HOSTED_SECRET`, `HOSTED_DEMO`, `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `APP_URL` (optional; `RENDER_EXTERNAL_URL` is the fallback), `SIMULATION_RUNS` (optional override). Full setup order: [docs/runbooks/render-turso.md](runbooks/render-turso.md).
- **Hosted AI limits:** agent runs 10 per hour per client, 15 per hour global, 30 per day global; feedback classification 10 per hour per client, 15 per hour global, 15 per day global.
- **AI budget:** a measured agent run took about 7 requests (7 model turns, about 27K tokens). 30 runs x 7 plus 15 classifications x up to 10 is about 360 requests per day, within Gemini's free quota of 500 per day.
- **Simulation budget:** hosted comparisons use 400 futures (1,000 locally) because Render Free has about 0.1 CPU.
- **PayPal polling:** refresh from PayPal sparingly; the global poll cap is 60 per hour.
- **Backups:** take a consistent backup with `npm run ledger:export` before any risky change. Exports contain sensitive authority; keep them private and outside the repository.
- **Stuck `executing` proposals:** an ambiguous `revise` or an unstored issued offer can leave a proposal `executing`, and no tool finishes it. Follow the manual reconciliation steps in the runbook ("Annual offers: unresolved targets and links" and "Administrator access and uncertain executions").

## Sandbox state

- Pilots A-D: ACTIVE subscriptions at $24 per month on the monthly plan, unchanged by M5: A `I-91S3L62FLPRH` and B `I-RSN1JH6WP5C0` (cancel intent, price), C `I-4NYUGXLB9CYN` (cancel intent, other), D `I-YTK64HUF985K` (core; shows `plan_overridden=true` from the M0-3 check). Pilot D has an annual offer pending (not approved by the buyer); it resolves as declined only after its 7-day window plus six hours and a confirming read.
- Pilot E ("loyal, 9 months", core): `I-0MVRKCE1RUF4`, switched to the annual plan at $244.80 per year (read-back verified).
- Disposable test subscriptions `I-4UFG7A89M5YV` (webhook probe) and `I-PDK7VBGHPPRX` (annual check) are CANCELLED, verified by PayPal GET.
- Local-only: one *proposed* save-offer proposal from the agent measurement run exists in a local ledger; it was never approved and has no PayPal action.
- Demo rules: never rehearse `revise` against the real Pilots D and E from a local ledger; a switched Pilot E is not moved back.

## Decisions

All records are in [docs/decisions/](decisions/).

- [0001](decisions/0001-scenario-and-paypal-action.md): subscription retention scenario, executed by per-subscription price override.
- [0002](decisions/0002-reason-specific-calibration.md): reason-specific calibration and campaign execution.
- [0003](decisions/0003-ai-provider-evaluation.md): evaluate Gemini, then Groq, before choosing the provider.
- [0004](decisions/0004-gemini-flash-lite-primary.md): Gemini Flash-Lite is the primary provider.
- [0005](decisions/0005-hosted-access-and-shared-admission.md): hosted access and shared client admission.
- [0006](decisions/0006-free-render-and-turso.md): Render Free with an authoritative Turso ledger.
- [0007](decisions/0007-authoritative-ledger-export.md): consistent authoritative ledger export and bounded readiness.
- [0008](decisions/0008-annual-plan-offers.md): annual-plan offers through PayPal `revise`.
- [0009](decisions/0009-csv-import.md): CSV import as a simulate-only, stateless twin.
- [0010](decisions/0010-conservative-discount-evidence.md): conservative measured discount evidence (renumbered from the duplicate 0007).

## Known issues and risks

- **Flaky tests under load:** timeouts in `src/agent/run.test.ts` (deadline and BUSY tests) and `src/hosting/guard.test.ts`; they pass alone and on re-run. Use `--maxWorkers=2`.
- **libsql test-driver contention bug:** affects tests only (`src/ledger/import.test.ts` WAL snapshot test times out under parallel workers); production is unaffected.
- **Cold start:** about 35-50 s on Render Free after idle. Warn in the README and video, or keep the service warm during judging.
- **Price response is an assumption:** the price-rise result is the largest simulated lever but is simulate-only and not recommended; the annual plan is the executable headline.
- **Synthetic data:** Ridgeline and Hollowbrook histories are generated; observed evidence from the sandbox is tiny and carries a sandbox caveat.
- **Annual offers:** offers cannot be withdrawn; PayPal gives no link expiry and the real token lifetime is untested; a late approval still counts.
- **Webhook coverage:** webhook subscription UPDATED events are not subscribed, so annual switches are detected by read-back.
- **Docs hygiene (M8):** the README is internal and stale and needs a judge-facing rewrite; the GitHub homepage URL and topics are empty.

## Handoff pointers

- Architecture: [docs/architecture.md](architecture.md)
- Roadmap: [docs/superpowers/plans/2026-10-22-aurrery-roadmap.md](superpowers/plans/2026-10-22-aurrery-roadmap.md)
- Specs: [docs/superpowers/specs/](superpowers/specs/); plans: [docs/superpowers/plans/](superpowers/plans/)
- Research and validation reports: [docs/research/](research/)
- Runbook: [docs/runbooks/render-turso.md](runbooks/render-turso.md)
- Archived milestone log: [docs/history/current-state-log.md](history/current-state-log.md)

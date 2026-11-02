# 0009: CSV import as a simulate-only, stateless twin

**Status:** accepted (M6). Spec: `docs/superpowers/specs/2026-11-01-m6-csv-import-design.md`. Plan: `docs/superpowers/plans/2026-11-01-m6-csv-import.md`. Where this record and the plan differ, this record describes the committed code.

## Context

M6 lets a merchant upload monthly subscriber history (and optional cancellation feedback) and get a twin estimated from it, with the same simulation, agent and evidence views as the demo merchant. PayPal actions are tied to Ridgeline's registered Sandbox pilots, so an imported merchant cannot act.

## Decision

### Stateless and simulate-only

- **Stateless rebuild.** The browser keeps the validated import in memory and sends it with each validate, simulate and agent request. The server re-validates it and rebuilds the twin for that request. Nothing about the upload is stored, logged or exported. Reloading the page returns to Ridgeline.
- **Shared builder.** `buildTwinFromHistory` (`src/twin/build-twin.ts`) holds the estimation that used to live in `buildDemoTwin`. A byte-for-byte golden fixture proves Ridgeline's twin and history are unchanged.
- **No observed evidence, no proposals.** Imported simulate and agent runs never call `observedMerchant` (discount outcomes and annual-offer evidence belong to Ridgeline's pilots), never emit an observed snapshot, never read the pilot registry, never create proposals or annual offers, and never reach PayPal. `POST /api/proposals` answers 422 `DEMO_ONLY` to any body with an `import` field. The agent's `recommend` records a simulate-only recommendation (`recommendation` event).
- **UI.** The workspace is keyed per merchant, so switching merchants remounts it and nothing (comparison, proposal, evidence, agent session) crosses twins. While imported, the approval, annual offer, recovery and pilot sections are not mounted, and administrator sign-in is hidden (a plan-review decision); "Back to Ridgeline" restores it. One notice says PayPal actions are for the demo merchant only.

### History semantics

- `active_start` excludes the month's signups. Signups join `new` at the start of their month and are exposed to that month's churn, as in Ridgeline's generator.
- For `new` rows the capacity rule is `voluntary + involuntary + moves <= active_start + new_signups`, because that month's signups can cancel or graduate in the same month. A strict reading would reject 3 of the original sample's 60 rows. Other segments use the spec's rule unchanged. A `new` row's exposure is `active_start + new_signups`.
- Histories with no active subscribers are rejected. Count columns are capped at 10,000,000.

### Estimation

- **Reason shares are anchored to segment priors.** Classified feedback updates each segment's own reason prior (strength 10) with its price and other counts, so a handful of rows cannot swing a segment far. Segments without feedback keep the prior, and the provenance note says so. A segment with no exposure in the CSV falls back to the prior and says so.
- **Starter strategies scale with list price** (-1/12 and +1/8, whole dollars, kept within $5-$200). The cancel-intent save is dropped when fewer than 5 subscribers start in cancel intent. Price-reason strategies are available only when at least one feedback row was accepted (`REASON_UNAVAILABLE` otherwise).
- **Headline.** The pick rule is the same for both merchants: retention discounts and annual plans within the decision rules. List-price changes stay simulate-only levers because price response is unobserved. For imports nothing is labelled executable, `alsoExecutable` is empty, and the pick reads "Best within your rules" with "simulate only".

### Input hardening

- History and feedback files are at most 256 KiB, checked against the bytes before parsing (the browser checks `File.size` before reading). Feedback is at most 200 rows, 1-1,000 characters each after trimming.
- Header problems and row errors are capped (50 reported, then one "more" entry), so a hostile file cannot produce an unbounded response. Unknown payload keys report a fixed message that does not echo the key.
- Feedback text may not contain control characters other than tab, CR and LF. Merchant and plan names may not contain control or formatting characters. This is also why the classify body cap of 640 KiB is safe.
- Request bodies are bounded: 64 KiB for validate, simulate and agent (the agent cap rose from 16 KiB), 640 KiB for classify. Server replies are treated as untrusted by the client.

### Feedback classification

- `POST /api/import/classify` uses the existing classifier behind its own hosted `classify` admission, the shared agent lease (409 `BUSY` during an agent run) and a 300 s deadline. A deadline, token or provider stop returns partial counts with `stopped: true`. A client abort returns 408 `ABORTED`. No provider configured gives a fixed 503 `CLASSIFIER_UNAVAILABLE`.
- Imports never write the persistent `feedback_prediction_cache` (it holds hashed keys and labels, never text, but travels in ledger exports). A bounded process-memory cache (2,000 entries, the same hashed keys, labels at or above 0.70 confidence only) is read first. The classify response exposes no `cacheHits`: a hit would show that another uploader sent the same text. Notes never mention cache reuse.
- Agent runs on an imported twin do not classify again: `classify_feedback` reports the counts the server classified before the run and makes no model call.

### Hosted AI limits

Sized to the Gemini free quota for `gemini-3.5-flash-lite` (15 requests per minute, 500 per day). The client bucket is shared site-wide (decision 0005).

| Kind | Client per hour | Global per hour | Global per day |
| --- | --- | --- | --- |
| `agent` | 10 | 15 | 30 |
| `classify` | 10 | 15 | 15 |

Classification never uses up agent runs. The daily totals should stay under about 420 provider requests (30 agent runs and 15 classifications at their measured request counts). The request count of one real agent run is **not yet measured**. It is to be measured during acceptance (agent budget counters), and the daily caps lowered if the product exceeds that figure.

### Sample merchant

"Hollowbrook Treat Box" is a synthetic $20 per month dog-treat box (seed 7311, 12 months, 40 feedback rows). It uses a milder rate set so its headline differs from Ridgeline's on history alone: core churn 1.5%, price sensitive 3% with 15% monthly drift to at risk, at risk churn 0.50 with 0.75 recovery, 26 signups per month. Measured on the committed code, without feedback: "At-risk: 20% off for 3 months" has a median of about +$2,163 at 400 futures against about +$1,271 for annual prepay, at a mean discount cost of about $635. Classified feedback keeps the same pick (about +$2,414 at 400). Ridgeline's pick is "Annual prepay at 15% off". The cost sits close to the $700 ceiling (70% of the default budget) that the plan review set, so a model change that raises it can break `src/import/sample-headline.test.ts`, which pins the outcome at 200 futures.

## Consequences

- The client's row numbers are physical CSV lines (header is row 1). The server numbers payload rows as index + 2. They agree for files without blank lines or multi-line cells.
- A classification on the hosted demo takes about a minute per 20 rows at the default Gemini rate profile.
- Saving, sharing or syncing imported merchants, PayPal actions for them, and estimating price sensitivity from a CSV remain out of scope.

## Maintaining the fixtures and tests

- **Ridgeline golden fixture** (`src/merchant/fixtures/ridgeline-golden.json`) changes only for an intentional model change. Regenerate it deliberately with `UPDATE_RIDGELINE_GOLDEN=1 npx vitest run src/merchant/ridgeline-golden.test.ts`, then review the diff before committing. A failing test without that flag means Ridgeline's twin changed by accident.
- **Samples** (`public/samples/`) are produced by `npm run samples:generate` (deterministic). A test compares the committed files with the generator, so change the generator and regenerate together.
- **Known flaky tests:** the deadline and BUSY tests in `src/agent/run.test.ts` and timeouts in `src/hosting/guard.test.ts` can fail under parallel load. They pass alone and on re-run (use `--maxWorkers=2`).
- **Known test-driver issue:** contention tests on the libsql test driver can fail intermittently because of a driver bug in the test environment. Production's Turso path is unaffected.

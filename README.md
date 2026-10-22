# Aurrery

**Simulate before you transact.** Aurrery is an orrery for your business: a digital twin of a subscription business that you can run forward. It tests retention and pricing strategies under uncertainty, an AI agent recommends one with its trade-offs, and only after the merchant approves the exact payload is the change executed through the PayPal Subscriptions API (Sandbox) and read back from PayPal.

Built for the PayPal AI Hackathon (2026).

## The loop

1. **Twin from data.** Segment churn, payment-failure churn, acquisition and segment transitions are Beta/normal posteriors estimated from 18 months of subscriber history. Parameters history can't identify (price sensitivity, discount effect, annual uptake) are explicit priors, labelled as assumptions.
2. **Strategies.** Targeted retention discounts, list-price changes and annual prepay plans, each bounded by server-side guardrails.
3. **Monte Carlo comparison.** 1,000 runs per strategy over 12 months. Every strategy sees the same parameter draws and random streams (common random numbers), so paired differences against "do nothing" isolate the intervention. Output: median and 80% interval of value change, and the probability of doing worse than baseline.
4. **Approval.** A recommended action becomes a proposal bound to a SHA-256 hash of its exact PayPal payload. Approval moves `proposed → approved`; execution atomically claims `approved → executing`, so it runs at most once.
5. **PayPal execution.** `PATCH /v1/billing/subscriptions/{id}` overrides the regular-cycle price for each targeted sandbox subscription. This is merchant-side; PayPal does not require buyer consent for it, and billing within 10 days is unaffected. Each subscription is then read back with `GET` and the observed price is recorded.
6. **Feedback.** Observed outcomes update the discount-effect posterior (Gamma–Poisson rate ratio).

Simulated numbers are always labelled *simulated*; values read back from PayPal are labelled *observed*. The demo merchant (Ridgeline Roasters) and its history are synthetic; the PayPal Sandbox calls are real.

## Quick start

Requires Node.js 24+.

```bash
npm install
cp .env.example .env.local   # add credentials for the integrations you use
npm run dev                  # http://localhost:3001
```

The twin and simulations work without credentials. To execute through PayPal:

Local development and `npm start` use port **3001**, leaving port 3000 available for other apps. Before creating a new pilot cohort, set `APP_URL` to the address where Aurrery runs; the example and setup fallback use `http://localhost:3001`. PayPal stores the return URL when each subscription is created. Changing local configuration does not rewrite existing approval links. A legacy link may still return to port 3000; open Aurrery on port 3001 afterward and use `paypal:sync` to check approval. The redirect alone is not proof of approval.

1. Create a Sandbox REST app at developer.paypal.com and put its client ID and secret in `.env.local`.
2. Run `npm run paypal:setup`. This creates the catalog product, a $24/month plan and four pilot subscriptions, and prints an approval link for each.
3. Open each link signed in as a **sandbox personal** account so the subscriptions become `ACTIVE`, then run `npm run paypal:sync`. Find the test email and password in Developer Dashboard → Testing Tools → Sandbox Accounts → the Personal account's **⋮ → View/Edit Account**. Use those sandbox credentials at the approval login; your real PayPal email or passkey belongs to a separate account. See [PayPal's sandbox setup guide](https://developer.paypal.com/api/get-started/).

Rerun `npm run paypal:setup` to read the current pilot statuses and reprint pending approval links. Healthy subscriptions, including `ACTIVE` pilots, are reused without creating subscriptions. New subscriptions are read back successfully before they enter the ledger or their approval links are printed. Sync exits nonzero if any subscription cannot be read.

If a registered pilot returns HTTP 404, setup stops by default. To explicitly recover confirmed missing pilots, run `npm run paypal:setup -- --recover-missing`. This replays each missing pilot's recorded creation request ID and body, verifies the returned subscription with GET, then replaces only that pilot's ledger ID in place, preserving its order and metadata. Keep the original plan settings and callback URL unchanged so the replay body stays identical. Other read failures never trigger recovery. Do not change request IDs or clear the ledger merely to retry the same intent. Historical proposals retain their original target IDs; create a fresh proposal for recovered pilots.

An explicitly approved replacement is a distinct creation intent. After adopting it, its active request ID and callback can be recorded in ledger settings `paypal.pilot.<index>.request_id` and `paypal.pilot.<index>.return_url` (zero-based cohort index). Setup uses those active settings for that pilot's creation/recovery; pilots without them retain `aurrery-ridgeline-sub-<index>-v1` and the configured callback. Pending `replacement_*` settings are ignored: setup never promotes a candidate or replaces a healthy subscription automatically. Do not overwrite another pilot's intent or change the legacy keys during recovery.

For a legacy cohort created with the old port-3000 default, preserve `APP_URL=http://localhost:3000` for recovery rather than silently changing its original request body. New cohorts should use port 3001.

## Development

```bash
npm test             # simulation, calibration and approval state-machine tests
npm run typecheck
npm run lint
npm run twin:inspect # print a strategy comparison from the command line
```

See [docs/architecture.md](docs/architecture.md) and [docs/current-state.md](docs/current-state.md).

## Feedback provider evaluation

M2 is complete. **Groq `openai/gpt-oss-120b` is selected**: 93.5% joint agreement on the 200-message synthetic fixture, all four pilots correct, and tool smoke passed. Gemini returned HTTP 503 twice, so its accuracy remains unassessed. See the [measured report](docs/research/m2-provider-evaluation.md). Configure Gemini with `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) and Groq with `GROQ_API_KEY` in `.env.local`. Optional `GEMINI_MODEL` and `GROQ_MODEL` override the initial `gemini-3.8-flash` and `openai/gpt-oss-120b` models. Keys are read by the server-only adapter and are never printed.

```bash
npm run signals:evaluate                              # fresh Gemini, then fresh Groq
npm run signals:evaluate -- --provider=gemini           # one-provider diagnostic
npm run signals:evaluate -- --provider=groq --use-cache # explicit cached diagnostic
npm run signals:evaluate -- --batch-delay-ms=60000      # optional pacing, 0..60000ms
```

Evaluation uses the same frozen 200-message synthetic fixture, prompt, schema and batch order for both providers. It defaults to fresh calls and 30-second proactive pacing between successful batches, with progress printed before each delay. This pacing does not wait for quota reset: HTTP 429 and terminal authentication/model/configuration failures stop that provider, skip its tool smoke and continue to the next configured provider. `AI_PROVIDER` does not skip the comparison. `--use-cache` requires an explicit single `--provider`; cached diagnostics are marked and excluded from candidate ranking. Unknown or duplicate flags fail before inference.

Reports contain schema validity, coverage, accepted-only and whole-corpus agreement, confusion counts, all four pilot checks, current local pilot eligibility/mapping issues, safe errors/quota evidence, reported token totals, latency, retries and a separate read-only tool call/result smoke. Missing usage contributes zero to the reported totals, which does not establish zero usage or charge. Account billing tier and demonstrated free capacity remain **unverified**; successful authentication or inference alone cannot establish them.

Each attempted provider gets a timestamped UUID artifact in ignored `data/signals-eval-*.json`, written without overwriting earlier runs. Artifacts include predictions, safe adapter metrics, fixture/input/truth/prompt/schema SHA-256 dimensions (JSON serialization, UTF-8), and a simulated classify → evidence copy → compare round trip. Both base and updated strategy summaries use 1,000 runs, 12 months and seed `20261113`, report differences against their own do-nothing baseline, and retain estimated evidence provenance. With no accepted evidence the round trip is explicitly unavailable. Hidden truth and pilot identity are never sent to providers.

Suitability requires >=95% schema-valid output, >=90% accepted coverage, >=90% whole-corpus joint agreement, all four pilots correctly classified, and passing tool smoke. No qualifying result gives a nonzero exit after saving both comparison artifacts. Fresh candidates are ranked by demonstrated free capacity (currently unverified), then joint agreement and HTTP latency; cached diagnostics only report their threshold result. The evaluation command itself leaves selection pending review; the completed M2 decision records `AI_PROVIDER=groq` explicitly. Evaluation does not change the canonical merchant/results, registrations, proposals or PayPal. Local pilot mapping uses the existing ledger reader; explicit cache reuse writes only accepted predictions to its separate cache table. No payment, approval or observation tool is available to the smoke check.

## Tools used

- **PayPal Subscriptions API** (Sandbox) via the official `@paypal/paypal-server-sdk`; Catalog Products REST API for setup.
- **Groq GPT-OSS 120B**, selected after the ordered Gemini/Groq evaluation; the full strategy agent is future M3 work. The agent will call the simulator through structured tools and cannot execute payments itself. See [the evaluation decision](docs/decisions/0003-ai-provider-evaluation.md).
- **AG Grid Community** for the scenario comparison grid.
- Next.js, TypeScript, Zod, Node's built-in SQLite, Vitest.

## License

MIT, see [LICENSE](LICENSE).

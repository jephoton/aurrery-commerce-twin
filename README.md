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
cp .env.example .env.local   # add PayPal Sandbox credentials; AI setup is pending
npm run dev                  # http://localhost:3000
```

The twin and simulations work without credentials. To execute through PayPal:

1. Create a Sandbox REST app at developer.paypal.com and put its client ID and secret in `.env.local`.
2. Run `npm run paypal:setup`. This creates the catalog product, a $24/month plan and four pilot subscriptions, and prints an approval link for each.
3. Open each link signed in as a **sandbox personal** account so the subscriptions become `ACTIVE`, then run `npm run paypal:sync`. Find the test email and password in Developer Dashboard → Testing Tools → Sandbox Accounts → the Personal account's **⋮ → View/Edit Account**. Use those sandbox credentials at the approval login; your real PayPal email or passkey belongs to a separate account. See [PayPal's sandbox setup guide](https://developer.paypal.com/api/get-started/).

Rerun `npm run paypal:setup` to read the current pilot statuses and reprint pending approval links. Healthy subscriptions, including `ACTIVE` pilots, are reused without creating subscriptions. New subscriptions are read back successfully before they enter the ledger or their approval links are printed. Sync exits nonzero if any subscription cannot be read.

If a registered pilot returns HTTP 404, setup stops by default. To explicitly recover confirmed missing pilots, run `npm run paypal:setup -- --recover-missing`. This replays each missing pilot's original request ID and body, verifies the returned subscription with GET, then replaces only that pilot's ledger ID in place, preserving its order and metadata. Keep the original plan settings and `APP_URL` unchanged so the replay body stays identical. Other read failures never trigger recovery. Do not change the `aurrery-ridgeline-*` request IDs or clear the ledger to retry. Historical proposals retain their original target IDs; create a fresh proposal for recovered pilots.

## Development

```bash
npm test             # simulation, calibration and approval state-machine tests
npm run typecheck
npm run lint
npm run twin:inspect # print a strategy comparison from the command line
```

See [docs/architecture.md](docs/architecture.md) and [docs/current-state.md](docs/current-state.md).

## Tools used

- **PayPal Subscriptions API** (Sandbox) via the official `@paypal/paypal-server-sdk`; Catalog Products REST API for setup.
- **AI provider evaluation planned: Gemini first, then Groq.** The classifier and strategy agent are not implemented yet. The agent will call the simulator through structured tools and cannot execute payments itself. See [the evaluation decision](docs/decisions/0003-ai-provider-evaluation.md).
- **AG Grid Community** for the scenario comparison grid.
- Next.js, TypeScript, Zod, Node's built-in SQLite, Vitest.

## License

MIT, see [LICENSE](LICENSE).

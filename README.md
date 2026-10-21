# Autonomous Commerce Lab

**Simulate before you transact.** A digital twin of a subscription business tests retention and pricing strategies under uncertainty, an AI agent recommends one with its trade-offs, and only after the merchant approves the exact payload is the change executed through the PayPal Subscriptions API (Sandbox) and read back from PayPal.

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
cp .env.example .env.local   # add PayPal Sandbox + Anthropic credentials
npm run dev                  # http://localhost:3000
```

The twin and simulations work without credentials. To execute through PayPal:

1. Create a Sandbox REST app at developer.paypal.com and put its client ID and secret in `.env.local`.
2. Run `npm run paypal:setup`. This creates the catalog product, a $24/month plan and four pilot subscriptions, and prints an approval link for each.
3. Open each link signed in as a **sandbox personal** account so the subscriptions become `ACTIVE`, then run `npm run paypal:sync`.

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
- **Anthropic Claude** for the strategy agent (in progress), which calls the simulator through structured tools and cannot execute payments itself.
- **AG Grid Community** for the scenario comparison grid.
- Next.js, TypeScript, Zod, Node's built-in SQLite, Vitest.

## License

MIT, see [LICENSE](LICENSE).

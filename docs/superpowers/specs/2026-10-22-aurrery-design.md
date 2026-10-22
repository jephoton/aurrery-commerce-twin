# Aurrery: design spec

**Status:** approved in brainstorming on 2026-10-22. Supersedes the working name "Autonomous Commerce Lab".
**Event:** PayPal AI Hackathon. Submission deadline 2026-11-13 04:00 SGT. Internal target: submit by 2026-11-12.

## 1. Product

**Pitch:** Aurrery is an orrery for your business. It is a working model of a subscription business that you can run forward. It shows which retention or pricing move pays, and how uncertain that is. Then it executes the move you approve through PayPal and records what PayPal reports. Tagline: *Simulate before you transact.*

**Name:** *orrery* (a clockwork model of the heavens, used to see future configurations) with *aur-* (gold, Au) folded in. The visual language: subscribers are bodies in orbit around the business, churn is escape velocity, and an intervention is a nudge. Uncertainty shows as fans of possible trajectories.

**Framing:** a merchant copilot. The safety flow (simulate → approve one exact payload → execute once → verify) is visible and named, but the pitch leads with the merchant outcome.

**Prize targets:** Grand, Best Use of PayPal + AI, Most Impactful, Most Creative, Best Use of AG Grid. Agentic Commerce is a secondary target: PayPal's own agentic-commerce products are consumer-side shopping agents.

**User:** a small or mid-size subscription merchant without a data science team. Demo merchant: *Ridgeline Roasters*, a fictional coffee subscription at $24/month with about 2,400 synthetic subscribers.

## 2. Demo arc (video target about 2:40; hard limit 3:00)

1. **Hook (0:00–0:20):** "Churn is up. The obvious move is a discount. Is it worth it?" A headline card shows the merchant's state.
2. **AI reads signals (0:20–0:45):** the agent classifies about 200 cancel-survey and support messages into intent and reason, finding price-driven, cancel-intent subscribers.
3. **First instinct, then correction (0:45–1:25):** the agent tries a broad at-risk discount and the twin shows it is about break-even. The agent narrows it to price-driven cancel intent, and the twin shows a clear gain with a low chance of doing worse than baseline. The annual plan is checked as an alternative.
4. **Trade-offs (1:25–1:50):** AG Grid comparison, trajectory fan chart, and which assumptions the result depends on. The agent explains the key sensitivity.
5. **Approval and PayPal (1:50–2:20):** the exact payload is shown and approved. Sandbox subscription prices are overridden, then each subscription is read back from PayPal and marked *observed*.
6. **Generality and close (2:20–2:40):** a different merchant's CSV is uploaded, the twin re-estimates, and a different recommendation comes back. Close on the tagline.

## 3. Scope

**In:**
- one deep case (Ridgeline)
- CSV import
- the agent with four roles
- two PayPal actions (precision discount as the hero; annual plan secondary)
- revert action, webhooks for observed outcomes, feedback update
- hosted demo plus local setup instructions

**Out:** multiple preset merchants, an auto-execute mode, live (non-sandbox) payments, ML model training, multi-agent orchestration.

**Cut lines.** Checkpoint on 2026-11-05. If behind, cut in this order:
1. Annual-plan *execution*: it stays a simulated strategy, with its PayPal route explained in the UI.
2. CSV import.

The hero path is never cut.

## 4. Architecture (modular monolith, Next.js 16, TypeScript)

| Module | Responsibility | Status |
| --- | --- | --- |
| `twin/` | Pure model: cohort Monte Carlo, common random numbers, total-value metric, guardrails, Bayesian calibration | exists; extend (§5) |
| `signals/` | Synthetic feedback corpus; Claude classifier with structured output `{intent, reason, confidence}`, cached by content hash | new |
| `import/` | CSV parse, validation and re-estimation, reusing the calibration functions | new |
| `agent/` | Single Claude tool-use loop, at most 10 tool calls, every step streamed to the UI | new |
| `ledger/` | SQLite: proposals state machine, executions, observations, audit, kv | exists |
| `execution/` | Approved proposal → PayPal → read-back → record | exists; extend |
| `paypal/` | Sandbox-only SDK client and typed wrappers | exists; extend |
| `app/api/`, UI | Route handlers; dashboard | exists; extend and polish |

### Agent tools (no execute tool, by design)
1. `get_merchant_state`: key metrics, segments, and which parameters are evidence versus assumption.
2. `classify_feedback`: runs or reads the cached classifier; returns counts by segment × reason.
3. `set_decision_rules`: turns the objective into explicit limits `{discountBudget, maxProbWorse, horizonMonths}`, shown in the UI.
4. `simulate_strategies`: up to 6 strategies per call; returns a compact comparison.
5. `stress_test`: reruns one strategy with every assumed parameter at its unfavourable 80th percentile.
6. `draft_customer_message`: offer copy for a targeted group. Display only.
7. `recommend`: creates a *proposed* action with rationale, trade-offs and key assumptions.

## 5. Model and data

- **New segment `cancel_intent`:** subscribers who opened the cancel flow or stated intent to leave. High churn, estimated from history. Transitions: `at_risk → cancel_intent` (escalation) and `cancel_intent → at_risk` (de-escalation), both Beta posteriors from history.
- **Hero strategy target:** `{segment: "cancel_intent", reason: "price"}`. The broad first attempt targets `{segment: "at_risk", reason: "any"}`.
- **Reason attribute:** groups carry `price` or `other`. The split per segment is a Beta distribution built from classifier counts (for example, 41 price-driven of 60 gives Beta(42, 20)). The AI's reading of the text becomes evidence with uncertainty.
- **Discount effect varies by reason:** Gamma priors centred on 0.45× churn for price-driven and about 0.9× for other. They are labelled assumptions until observed outcomes update them through the existing Gamma–Poisson update.
- **Targeting:** a strategy targets `{segment, reason: "price" | "any"}`. Guardrails are unchanged: discount 5–50%, 1–12 months.
- **Stress test:** shifts assumption priors only. Estimated parameters stay as they are.
- **Synthetic corpus:** about 200 messages, generated once and committed as a fixture labelled *synthetic*. Each has a hidden ground-truth label so the UI can report classifier agreement. Each of the four sandbox pilot subscriptions is linked to a message, so the PayPal action targets exactly the subscribers the AI flagged. The pilot mix is two price-driven cancel-intent, one cancel-intent for another reason, and one core, so the targeting is visibly selective (two of four).

### CSV import
- **History (required):** one row per month × segment with `month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups` (amended 2026-10-22: `at_risk` now has two exits). Unit economics are entered in a form.
- **Feedback (optional):** `segment, text`. Without it, reason targeting is unavailable and the agent says so.
- **Validation:** known segments, non-negative integers, cancels ≤ active, at least 6 months of history. Errors are reported per row; the current twin is unchanged on failure. A template and sample file can be downloaded.

## 6. PayPal (Sandbox only)

| Capability | API | Consent |
| --- | --- | --- |
| Precision discount (hero) | `PATCH /v1/billing/subscriptions/{id}` regular-cycle `fixed_price` + `GET` read-back | merchant only |
| Revert discount | the same PATCH back to the list price, as a separate approved proposal | merchant only |
| Annual plan | `POST /v1/billing/plans` + `POST /v1/billing/subscriptions/{id}/revise` approval links | buyer must approve |
| Observed outcomes | webhooks (subscription and payment events) verified with `POST /v1/notifications/verify-webhook-signature`; deduplicated by event ID. Hosted deployment only; local runs use `paypal:sync` polling | — |
| Demo reset (hosted) | PATCH pilot subscriptions back to the list price; explicit and logged; restricted to that operation | admin |

The PATCH path format still needs live verification (first task in implementation).

## 7. Safety and errors

- The only route to PayPal is: a hash-bound proposal → merchant approval → an atomic single claim → execute → read back. Limits are enforced server-side; the client is sandbox-only.
- **Hosted demo:** per-IP rate limit on agent runs, a token cap per run, and a spend cap on the API key.
- **PayPal failures:** HTTP status, error name and debug ID are shown and stored. Partial failures are reported as partial.
- **Claude unavailable:** stated plainly in the UI. The twin, grid and manual strategies still work. There is no scripted stand-in for the AI.
- **Invalid classifier items:** marked as unclassified, never guessed.
- **Agent at its tool-call cap:** returns its best result so far, marked incomplete.

## 8. Testing

- **Twin:** reason targeting, stress-test direction (pessimistic never beats the base-case assumptions), CSV round trip re-estimates parameters.
- **Agent:** tools unit-tested with a fake model client; one recorded end-to-end run replayed.
- **Classifier:** accuracy against synthetic ground truth, run manually because it costs tokens.
- **PayPal:** manual sandbox check script (patch → read back → revert); webhook handler tested with recorded payloads.
- **Before recording:** a full browser walkthrough on the hosted build.

## 9. Effort estimate (days)

| Work | Days |
| --- | --- |
| PayPal test and fixes | 0.5–1 |
| Twin: reason targeting and stress test | 1–1.5 |
| Feedback corpus and classifier | 1–1.5 |
| Agent loop and streamed UI | 3 |
| UI polish and headline card | 3 |
| Hosting, reset, rate limits | 1–1.5 |
| Webhooks and revert | 1.5 |
| CSV import | 1.5–2 |
| Annual-plan execution | 1.5–2 |
| Video and Devpost write-up | 2 |

That totals about 17–19 days against about 21 available, leaving 3–4 days of buffer.

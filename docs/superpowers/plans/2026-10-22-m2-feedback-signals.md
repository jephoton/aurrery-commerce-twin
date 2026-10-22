# M2 feedback signals implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task requires failing tests before implementation, then spec and quality reviews.

**Goal:** Compare Gemini and Groq on the same synthetic feedback, producing validated evidence for the twin and an honest provider decision.

**Architecture:** Server-only fixture loading and provider adapters feed a batch classifier with per-item validation and SQLite caching. Pure evidence and scoring functions feed an explicit CLI round trip; the default twin and PayPal registry remain unchanged.

**Tech stack:** TypeScript, Zod, built-in fetch, Node SQLite, tsx and Vitest. No AI SDK or orchestration framework is required.

**Approved specification:** `docs/superpowers/specs/2026-10-22-m2-feedback-signals-design.md`. Work in the already selected `feat/m2-feedback-signals` checkout. No new worktree or live PayPal calls. Keep provider keys and raw outputs in ignored local state.

## Task 1: Corpus and classification contracts

Completed in `5337fcc`; independent spec and quality reviews passed (22 focused tests).

**Files:** `src/signals/contracts.ts`, `corpus.ts`, `fixtures/feedback.json`, `fixtures/truth.json`, `corpus.test.ts`.

- [x] Write and run failing fixture/contract tests. Assert 200 unique IDs and texts; all five known segments; a matching truth label for each ID; four stable pilot mappings; no truth/pilot identity in model input; confidence bounds; strict object validation. Include mixed reasons, negation and adversarial messages.

```ts
expect(corpus).toHaveLength(200);
expect(new Set(corpus.map(m => m.id)).size).toBe(200);
expect(new Set(corpus.map(m => m.text)).size).toBe(200);
expect(Object.keys(truth).sort()).toEqual(corpus.map(m => m.id).sort());
expect(toModelInput(corpus[0])).toEqual({
  id: corpus[0].id, text: corpus[0].text,
  source: corpus[0].source, segment: corpus[0].segment,
});
```

- [x] Implement contracts and a static 200-message synthetic corpus with separate truth. Keep fixtures fixed before either live evaluation. Pilot texts: A `honestly it's just too expensive right now`; B `can't justify $24 a month anymore`; C `moving abroad next month`; D `loyal, 14 months`. The first three use cancel_flow/cancel_intent, D support/core. Truth: A/B cancel+price, C cancel+other, D stay+other. Pilot index is local metadata, removed by toModelInput.

```ts
export const IntentSchema = z.enum(['cancel', 'considering_cancel', 'stay']);
export const PredictionSchema = z.object({
  id: z.string().min(1), intent: IntentSchema,
  reason: z.enum(['price', 'other']), confidence: z.number().min(0).max(1),
}).strict();
export const PROMPT_VERSION = 'feedback-v1';
export const SCHEMA_VERSION = 'classification-v1';
export const MIN_CONFIDENCE = 0.70;
```

- [x] Run `npx vitest run src/signals/corpus.test.ts` and `npm run typecheck`. Update handoff, commit `feat(signals): add synthetic feedback corpus and contracts`. Independent spec review then quality review; fix/re-review before Task 2.

## Task 2: Provider transport, validation and cache

Implemented; independent spec and quality reviews passed. HTTP transport is split into `src/signals/transport.ts` so provider request/envelope handling stays separate from retry, timeout and safe metrics.

**Files:** `src/signals/providers.ts`, `prompt.ts`, `classify.ts`, `cache.ts`, `providers.test.ts`, `classify.test.ts`; `.env.example`.

- [x] Write and observe failures for fetch envelope shapes, Gemini key alias, bounded retries and sanitized errors. Test classification missing/duplicate/unknown IDs, low confidence, malformed batches, valid members of partial batches, batches of 20, accepted-only caching, corrupted cache, and provider/model/prompt/schema/input cache separation. Tests use injected transport/sleep, never credentials or live inference.

```ts
// Duplicate IDs fail closed; another valid item in the same batch survives.
const raw = {items: [
  {id:'a', intent:'cancel', reason:'price', confidence:0.9},
  {id:'a', intent:'stay', reason:'other', confidence:0.8},
  {id:'b', intent:'stay', reason:'other', confidence:0.9},
]};
const result = validateBatch(inputs, raw);
expect(result.accepted.map(x => x.id)).toEqual(['b']);
expect(result.unclassified.find(x => x.id === 'a')?.cause).toBe('duplicate');
```

- [x] Implement explicit Gemini/Groq adapters using documented REST structured output, shared schema/prompt, 60-second per-request timeout and bounded output. Preserve response usage and allowlisted quota headers only. Transport returns parsed unknown payload plus sanitized metrics; body parsing errors never expose request credentials. A provider failure contains provider/model, status/category, retry count and safe quota evidence, never the raw request/error message.

```ts
const key = createHash('sha256').update(JSON.stringify({
  input: toModelInput(message), provider, model,
  prompt: PROMPT_VERSION, schema: SCHEMA_VERSION,
})).digest('hex');
// Cache uses its own table in ledger(); accepted entries are revalidated on read.
// Classification evaluation sets useCache:false, while normal reuse is explicit.
```

- [x] Permit at most one retry for a timeout/network error or HTTP 5xx; bounded Retry-After is at most 10 seconds. Authentication/model errors and HTTP 429 end that provider run, marking remaining inputs unclassified. Preserve accepted results from preceding batches. Do not retry JSON validation failures, switch models/providers or wait for quota reset. Report attempted batches, schema-valid count before confidence filtering, accepted/unclassified results, cache hits, duration, usage, retries and failure/quota evidence.

- [x] Add env placeholders: `GEMINI_API_KEY`, alias comment `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, explicit optional model/provider configuration. Leave PayPal config untouched. Run task tests/typecheck/lint; update handoff and commit `feat(signals): classify feedback with isolated provider caches`.
- [x] Complete independent spec and quality reviews before Task 3. Implementation verification: 40 focused tests / 137 total tests, typecheck and lint pass. Branch pushed through `9878193`. The global ESLint ignore now excludes already ignored local `data/**` helpers/evaluation artifacts.

## Task 3: Evidence projection, scoring and pilot eligibility

Implemented; independent spec and quality reviews passed. Verification: 11 focused tests / 148 total tests, typecheck and lint pass.

**Files:** `src/signals/evidence.ts`, `score.ts`, `evidence.test.ts`, `score.test.ts`.

- [x] Observe failing tests for exact Beta counts, provenance isolation, no source mutation, zero-evidence preservation, repeated application equality, duplicate evidence rejection, and A/B-only runtime pilot mapping. Score missing/unclassified items against the full corpus denominator and calculate accepted-only agreement separately.

```ts
expect(updated.params.segments.cancel_intent.priceReasonShare)
  .toEqual({alpha:3,beta:2}); // two price, one other
expect(applyEvidence(updated, messages, accepted)).toEqual(updated);
expect(updated.provenance['segments.cancel_intent.priceReasonShare'])
  .toMatchObject({source:'estimated',evidenceCount:3});
expect(original).toEqual(before);
```

- [x] Implement evidence on a structured clone using known segments. Use Beta(1+price,1+other), evidenceCount=accepted count, and synthetic AI-evidence note. No confidence weighting. Never mutate currentMerchant(), global registry, churn or discount-effect assumptions. Duplicate input/prediction IDs must not double-count evidence. Ground truth is a scoring-only dependency, not imported by classify/providers/evidence.

```ts
const eligible = messages.filter(m => m.segment === 'cancel_intent'
  && acceptedById.get(m.id)?.intent === 'cancel'
  && acceptedById.get(m.id)?.reason === 'price');
// Only eligible messages with a stable pilot index resolve to local registry IDs.
// Missing/ambiguous pilot mappings fail closed and are reported, never substituted.
```

- [x] Report schema-valid rate and coverage over all 200, accepted/whole-corpus intent/reason/joint agreement, confusion counts and four pilot checks. Suitable requires valid >=.95, coverage >=.90, whole-corpus joint >=.90, all pilots' accepted intent/reason labels correct and tool smoke passed. Run task tests, full tests/typecheck/lint, update docs and commit `feat(signals): project classified evidence and score provider agreement`.
- [x] Complete independent Task 3 spec then quality reviews before Task 4.

## Task 4: Tool smoke, evaluation CLI, live comparison and integration

**Files:** `src/signals/tool-smoke.ts`, `evaluate.ts`, `evaluate.test.ts`, `tool-smoke.test.ts`, `scripts/evaluate-signals.ts`, `package.json`, README/architecture/current-state, research report and decision 0003.

- [x] Write and observe failing fake-transport tests for Gemini tool call/result and Groq tool call/result. Only `get_merchant_state` is available; require exact empty arguments, one call, and a final response consuming supplied synthetic list price and merchant state. No classification strict mode on tool requests. Refusals/incorrect calls fail visibly. Include sanitized failure/usage metrics.

- [x] Implement a fresh-by-default CLI `npm run signals:evaluate` (Gemini then Groq), plus explicit `--provider=gemini` or `--provider=groq` and `--use-cache` for diagnostic reuse. Cache reuse requires an explicit single provider and cannot contribute comparison candidates. Never silently overwrite previous artifacts: timestamped ignored data report. Print compact per-batch progress, sanitized errors, full scoring and tool result. If a provider stops, evaluate the next explicitly configured provider. Set a nonzero exit if no candidate qualifies, while still writing both results. Default proactive interbatch pacing is 30 seconds, configurable with `--batch-delay-ms=0..60000`; progress announces delays, with none after the last batch or error.

- [x] Implement the classify → evidence copy → simulate round trip in the report with `compareStrategies(updatedTwin, STARTER_STRATEGIES, {runs:1000,horizonMonths:12,seed:20261113})`. Both base and updated results must be clearly simulated; report the seed/options and provenance. Do not replace the canonical M1 numbers or silently set runtime default during evaluation.

- [x] Complete code verification and independent spec then quality reviews before live inference. All 184 tests, typecheck, lint and production build pass; both code reviews passed and quality independently reran the 36 focused tests.
- [x] Run `npm run signals:evaluate`, Gemini first then Groq. Freeze corpus/prompt first; record artifacts, quota evidence and any inaccessible/failed provider honestly. A transport compatibility fix may be tested/reviewed and retried, but do not rewrite fixture labels or prompt to chase scores.

- [x] Commit sanitized evaluation summary and provider selection rationale only after actual results. If neither qualifies, report without selecting another provider. If account billing/free tier cannot be proven from API, say so and do not claim free account verification. Complete final independent review, tests/typecheck/lint/build and handoff. Merge/push the milestone when acceptance is achieved, preserving credentials and ledger locally. M3 remains the next milestone; no full agent/UI work is included here.


Completed: Groq selected from the actual run; Gemini HTTP 503 results are recorded without an accuracy claim. All task reviews, final code/results reviews, 184 tests, typecheck, lint and build passed. Main fast-forwarded to the verified M2 tree and both refs were pushed. M3 full-loop/streaming work remains next.

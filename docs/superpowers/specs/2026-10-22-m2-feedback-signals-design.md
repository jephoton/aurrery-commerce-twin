# M2: Feedback signals and provider evaluation

<!-- Generated design addendum. Status: proposed for user review; implementation not started. -->

This makes the approved M2 milestone concrete. It follows the product [design](2026-10-22-aurrery-design.md), [roadmap](../plans/2026-10-22-aurrery-roadmap.md) and [Gemini-then-Groq decision](../../decisions/0003-ai-provider-evaluation.md). M3's agent, streaming UI and PayPal execution remain separate work.

## Approach and alternatives

Use a committed synthetic corpus, provider adapters, validated classification, and a reproducible evaluation command. Run Gemini first and Groq second, then choose from measured results. This is the recommended approach: it produces comparable evidence without coupling the twin to a provider.

A Gemini-only implementation would be smaller but would skip the approved comparison. A general AI orchestration framework would offer more integrations but add abstractions the two-provider evaluation does not need. Neither is proposed.

## Corpus and labels

Commit 200 distinct synthetic messages with stable IDs, known subscriber segments, and source (`cancel_flow` or `support`). Include the four existing pilot quotations exactly once, linked by stable pilot index rather than environment-specific PayPal IDs. Resolve current pilot IDs from the local registry at runtime. Include price concerns, non-price departures, mixed reasons, negation, ordinary requests, and messages that try to instruct the classifier.

Ground truth is a separate server-only fixture keyed by message ID. Neither provider receives ground truth or pilot identity. Its input contains only message ID, text, source and known segment. Segment is observed context, not a prediction to score.

## Classification contract

Each prediction has `{id, intent, reason, confidence}`:

- `intent`: `cancel`, `considering_cancel`, or `stay`. An explicit cancellation or a cancel-flow departure is `cancel`; tentative future departure is `considering_cancel`; ordinary requests and affirmative retention are `stay`.
- `reason`: `price` or `other`, describing the primary issue stated in the message. A shipping, relocation or taste issue is `other`, even if a price appears incidentally. A message that affirms retention can still express a price concern.
- `confidence`: a finite number from 0 to 1. It is model-reported confidence, not a calibrated probability of correctness.

Schema-invalid, missing, duplicate, unknown-ID and confidence-below-0.70 items are reported as unclassified. Do not guess or assign a reason to these items. Unknown IDs never become corpus entries. Distinguish malformed provider envelopes from per-item failures, and preserve valid items in a partially invalid batch. Treat message text as data; it cannot change instructions, schema or available tools.

Use batches of 20 and bounded output. Cache only accepted classifications in SQLite, keyed by the full input content (including known segment/source), provider, model, prompt version and schema version. Revalidate cached entries. Evaluation defaults to fresh calls, explicitly reports any cache use, and never compares one provider's cache against the other's live output.

## Evidence and pilot boundaries

For each known segment, count accepted `price` and `other` classifications and replace its price-reason distribution with `Beta(1 + priceCount, 1 + otherCount)`. Apply this to a copy of the twin. Mark only affected segment reason-share provenance as estimated, including sample count and a note that the source is AI-classified synthetic feedback. Segments with no accepted evidence retain their prior and provenance. Repeated application replaces the estimate rather than counting cached feedback twice. Confidence is a filter, not a fractional observation weight.

Report intent counts separately from the known segment counts. A price-reason share is evidence about reasons within the supplied segment; it is not an estimate of the population's cancellation rate or a causal estimate of discount effectiveness. Do not alter churn, transitions, discount-effect assumptions or the canonical M1 fixture/results.

Return pilot eligibility only for accepted `cancel` + `price` messages whose known segment is `cancel_intent`. Expected fixture behavior is A/B eligible and C/D excluded. Ground truth is used to score this behavior, never to repair predictions. Preserve the existing registry and proposal history; M3 will consume the classifier eligibility explicitly when constructing a new recommendation. M2 does not approve proposals or call PayPal mutations.

## Provider adapters and failures

Use a small server-only adapter boundary with built-in fetch, structured-output JSON schema, timeouts, and sanitized errors. Gemini uses `GEMINI_API_KEY` or the existing `GOOGLE_GENERATIVE_AI_API_KEY` alias; Groq uses `GROQ_API_KEY`. Models are explicit configuration, initially `gemini-3.8-flash` and `openai/gpt-oss-120b`, verified visible through authenticated model-list reads on 2026-10-22.

Keep strict classification calls separate from tool calls. A minimal read-only tool smoke test requests merchant state, supplies a synthetic result, and checks that the model can consume it. This does not establish M3 end-to-end suitability. It has no execution or payment tool.

Limit a transient-failure retry to one per batch, record it, and honor a bounded Retry-After. Stop the provider run on authentication, inaccessible model, or exhausted quota; report incomplete coverage and continue to the explicitly requested second provider. Never silently substitute another model/provider, enable billing, or loop until quota resets. API errors/logs must exclude keys, authorization headers and raw secret-bearing request objects.

## Evaluation and selection

Use the same fixed corpus, schema, prompt and batch order for Gemini then Groq. Record model IDs, fixture/prompt/schema versions, valid-output rate, accepted coverage, intent and reason agreement, joint agreement, confusion counts, pilot eligibility, latency, token usage, retries/errors, and the read-only tool smoke result. Report agreement on accepted items and over the whole corpus, so abstention cannot inflate performance. Unclassified items count as unsuccessful for whole-corpus agreement.

A provider is a suitable candidate when valid-output rate is at least 95%, accepted coverage at least 90%, whole-corpus joint agreement at least 90%, all four pilots are handled correctly, and the tool smoke test passes. These are demo acceptance thresholds on a synthetic fixture, not claims of general accuracy. Do not rewrite labels or tune the fixture after seeing a provider's answers. If neither qualifies, report the evidence before selecting another provider.

Prefer a qualifying provider with demonstrated free-tier capacity for the run, then joint agreement, then latency. Record actual quota evidence exposed by response headers/errors; if account billing tier or absolute quota cannot be established, state that explicitly. Model visibility alone does not prove free inference access. Do not invent a quota number or claim a zero charge from a successful response alone.

Save raw evaluation artifacts under ignored `data/`; commit a credential-free summary and the provider decision. A classify → re-estimate → simulate command demonstrates integration without changing the default merchant silently. Runtime selection is explicit configuration and does not add automatic fallback.

## Implementation and verification boundaries

Implement in tasks: corpus/contracts; adapters and bounded errors; validation/cache; evidence and pilot mapping; evaluation/tool smoke/round trip; live comparison and selection documentation. Write focused failing tests before implementation and obtain independent spec and quality reviews per task. Fake transports cover malformed output, duplicate/unknown IDs, partial failures, cache separation, low confidence, repeated application, missing segment evidence and pilot selectivity. Live inference is an explicit manual check, not part of the unit suite.

Completion requires both provider evaluations (or an honest access/quota failure report), documented selection when a candidate qualifies, the round trip, passing tests/typecheck/lint/build, and updated handoff docs. The full agent loop and product UI remain M3/M4.

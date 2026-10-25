# 0003: Evaluate Gemini, then Groq, before selecting the AI provider

**Status:** accepted (2026-10-22); Gemini-then-Groq evaluation completed; **Groq `openai/gpt-oss-120b` selected** for M2/M3.

**Follow-up:** [0004](0004-gemini-flash-lite-primary.md) updates the M3 primary-provider selection to Gemini 3.5 Flash-Lite after the user's requested reevaluation. The evaluation process and no-automatic-fallback boundary below remain accepted; the original measured selection is retained as history.

## Context

The original plan named Claude, but the product needs structured classification and tool calling rather than a particular provider. The user requested free options and approved evaluating Gemini first, then Groq. M2 classification is now implemented; the M3 agent remains next.

## Decision

1. Evaluate Gemini first, starting with the documented free-tier Flash candidate in the [research notes](../research/free-ai-api-options.md). Confirm current model availability and the account's active quota before calling it.
2. Evaluate Groq second against the same synthetic fixture and validation rules, starting with GPT-OSS 120B if available on the account's free plan. Keep strict classification output calls separate from streaming/tool calls as required by the provider.
3. Record valid-output rate, intent/reason agreement against hidden labels, errors/retries, latency, token usage and actual free-tier limits. Cache keys must include provider/model and prompt/schema version so the evaluations cannot reuse each other's responses.
4. Select the default from measured results and document why. During M2, add a minimal tool-call smoke test; during M3, verify the selected provider on the complete agent loop and its streamed timeline. Do not claim end-to-end suitability from a classification test alone.

Keep a small provider boundary for classification and tool calls. Server-side validation, the twin, the action hash, merchant approval and PayPal execution remain provider-independent. Do not enable an automatic provider fallback or paid billing as part of evaluation. If both free options are unsuitable, report the evidence before choosing another provider.

## Consequences

The roadmap and design no longer require Anthropic. Its installed but unused SDK can remain until implementation settles the dependencies. Provider credentials are local configuration and are never committed. Public free-tier claims are not guarantees of account access, capacity or quality.

## Measured selection

The fresh comparison used frozen code `e64696b`, 200 synthetic messages and the same prompt/schema for both providers. Gemini returned HTTP 503 on both allowed attempts; no accuracy conclusion is available for it. Groq accepted all 200 items, with 97.5% intent, 96.0% reason and 93.5% joint agreement. All four pilots were correctly classified (only A/B eligible), and the separate read-only tool round trip passed. Groq made 12 successful requests without retries and was the only qualifying provider. See the [full measured report](../research/m2-provider-evaluation.md), including retained errors and the simulated evidence round trip.

Set explicit `AI_PROVIDER=groq` with `GROQ_MODEL=openai/gpt-oss-120b`. Keep Gemini configured for explicit diagnostics; do not add automatic fallback. Groq headers exposed 1,000 requests/day and 8,000 tokens/minute; account billing tier and actual charges remain unverified. No billing settings were changed. M3 must validate the full tool loop, streaming, token limits and classifier-derived targeting before claiming complete agent suitability.

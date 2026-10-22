# 0003: Evaluate Gemini, then Groq, before selecting the AI provider

**Status:** accepted (2026-10-22); evaluation order approved by the user, final provider not selected.

## Context

M2 classification and the M3 agent have not been implemented. The original plan named Claude, but the product needs structured classification and tool calling rather than a particular provider. The user requested free options and approved evaluating Gemini first, then Groq.

## Decision

1. Evaluate Gemini first, starting with the documented free-tier Flash candidate in the [research notes](../research/free-ai-api-options.md). Confirm current model availability and the account's active quota before calling it.
2. Evaluate Groq second against the same synthetic fixture and validation rules, starting with GPT-OSS 120B if available on the account's free plan. Keep strict classification output calls separate from streaming/tool calls as required by the provider.
3. Record valid-output rate, intent/reason agreement against hidden labels, errors/retries, latency, token usage and actual free-tier limits. Cache keys must include provider/model and prompt/schema version so the evaluations cannot reuse each other's responses.
4. Select the default from measured results and document why. During M2, add a minimal tool-call smoke test; during M3, verify the selected provider on the complete agent loop and its streamed timeline. Do not claim end-to-end suitability from a classification test alone.

Keep a small provider boundary for classification and tool calls. Server-side validation, the twin, the action hash, merchant approval and PayPal execution remain provider-independent. Do not enable an automatic provider fallback or paid billing as part of evaluation. If both free options are unsuitable, report the evidence before choosing another provider.

## Consequences

The roadmap and design no longer require Anthropic. Its installed but unused SDK can remain until implementation settles the dependencies. Provider credentials are local configuration and are never committed. Public free-tier claims are not guarantees of account access, capacity or quality. No live AI evaluation has been performed yet.

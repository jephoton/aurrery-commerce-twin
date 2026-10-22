# Free AI API options for Aurrery

<!-- Generated research notes; ordered evaluation completed in M2, with Groq selected. -->

M2 update: Groq GPT-OSS 120B passed the frozen synthetic benchmark and read-only tool smoke; Gemini returned HTTP 503 twice. See the [measured report](m2-provider-evaluation.md) and [decision](../decisions/0003-ai-provider-evaluation.md). The public-offer research below is historical context, not account billing verification.

Checked against official public sources on 2026-10-22. These are published offers, not account-level quota or model-quality tests. Recheck availability before implementation.

## Recommendation to evaluate

The user approved evaluating Gemini first, then Groq, before selecting the M2/M3 default. The approved starting candidates were Gemini 3.8 Flash and Groq GPT-OSS 120B, using the same fixture; the completed results are linked above. Follow [decision 0003](../decisions/0003-ai-provider-evaluation.md). Anthropic is not an implementation requirement: its SDK is installed, but the classifier is now complete and the agent is next; the measured M2 selection is linked above. Keep the provider choice separate from the pure twin and PayPal approval/execution boundary.

Google lists free input/output for `gemini-3.8-flash`, and its model page lists function calling and structured outputs. Active project quotas must be checked in AI Studio; there is no verified universal request allowance here. Singapore is a supported region. Free-tier content is used to improve Google's products; the current corpus is planned as synthetic, but real merchant feedback would require reviewing that choice.

- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Model capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Active quota guidance](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Supported regions](https://ai.google.dev/gemini-api/docs/available-regions)

## Alternatives

| Option | Published free access | Implication for Aurrery |
| --- | --- | --- |
| Groq | Free plan with model/account-specific request and token limits | GPT-OSS 120B supports tools and strict JSON-schema output. Strict structured outputs cannot currently be combined with streaming/tool use; use separate classification and agent calls. |
| Mistral Studio | Free API mode enabled by default, no credit card required; usage/rate limits apply | Function calling and custom structured outputs are documented. Verify model eligibility and workspace limits before choosing it. |
| Cloudflare Workers AI | 10,000 neurons daily on Workers Free; further operations fail when exhausted | A recurring free allowance; model cost determines useful token volume. Some larger models require paid billing. |
| OpenRouter | Free model variants: 20 requests/minute and 50/day without purchased credits | Too small a default budget for repeated multi-step demos. The 1,000/day allowance requires at least $10 in lifetime credit purchases, so it is not a zero-spend setup. |
| NVIDIA NIM | Developer-program members get hosted API access for prototyping | Useful for development evaluation; not evidence of a production hosting entitlement or guaranteed capacity. |
| Local Ollama | Run a suitable open-weight model on local hardware, with tools and structured outputs | Avoids per-call API billing but still uses hardware/electricity. A hosted demo would need access to an inference machine; performance must be measured. |

Sources:

- Groq: [limits](https://console.groq.com/docs/rate-limits), [tools](https://console.groq.com/docs/tool-use/overview), [structured-output restrictions](https://console.groq.com/docs/structured-outputs).
- Mistral: [free-mode setup](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key), [tools](https://docs.mistral.ai/studio/conversations/function-calling), [structured outputs](https://docs.mistral.ai/studio/conversations/structured-output/custom).
- Cloudflare: [pricing and paid-model exclusions](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- OpenRouter: [pricing and free limits](https://openrouter.ai/pricing).
- NVIDIA: [prototyping access versus production licensing](https://docs.api.nvidia.com/nim/docs/run-anywhere).
- Ollama: [tools](https://docs.ollama.com/capabilities/tool-calling), [local structured outputs](https://docs.ollama.com/capabilities/structured-outputs). Its cloud service currently lacks structured outputs.

## Stale recommendations to avoid

- [GitHub Models](https://docs.github.com/en/github-models) was retired on 2026-07-30; its former free inference API is unavailable.
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/pricing) currently lists no monthly inference credits for free users; purchasing credits is required. Older claims of free monthly credits do not match this page.
- [Cerebras pricing](https://www.cerebras.ai/pricing) currently advertises pay-as-you-go with $5 starter credit. Its older docs describe a free tier, so do not promise ongoing free access without account-level confirmation.

## Before committing to a provider

Use a small provider adapter, cache classification by content hash, batch the synthetic corpus, keep tool results compact, and handle quota errors explicitly. Measure classifier agreement and one complete agent run before claiming a provider can handle the demo. Do not silently substitute cached or scripted output for a live agent. No provider change, new credentials, or external model calls were made during this research.

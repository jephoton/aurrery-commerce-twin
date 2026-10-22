# M2 provider evaluation: Groq selected

<!-- Generated from the live evaluation of committed code e64696b. Corpus, labels, prompt and schema were frozen before calls and were not changed after results. -->

**Run completed:** 2026-10-22 15:16 UTC (23:16 SGT). Command: `npm run signals:evaluate`. Fresh Gemini followed by fresh Groq; no cache hits, no model fallback, default 30-second interbatch pacing. Both used the same 200 synthetic messages and hidden evaluation labels. This is agreement on this fixture, not a general accuracy claim.

## Observed results

| Measure | Gemini `gemini-3.8-flash` | Groq `openai/gpt-oss-120b` |
| --- | --- | --- |
| Availability | HTTP 503 on initial attempt and one retry | All 12 requests HTTP 200 |
| Accepted predictions | 0/200; inference unavailable | 200/200 |
| Schema-valid output | Not assessed | 100% |
| Intent agreement | Not assessed | 97.5% (195/200) |
| Reason agreement | Not assessed | 96.0% (192/200) |
| Joint intent + reason agreement | Not assessed | 93.5% (187/200) |
| Four pilot labels and eligibility | Not assessed | All correct; A/B eligible, C/D excluded |
| Read-only tool round trip | Skipped after terminal failure | Passed |
| Retry count | 1 | 0 |
| HTTP time, including retries | 17.458 seconds | 33.652 seconds |
| Wall time, including pacing and simulation | 17.490 seconds | 312.768 seconds |
| Reported input/output tokens | Not reported | 11,264 / 11,689 (22,953 total) |

Groq classification used 10 calls and reported 22,530 tokens; the separate two-call tool smoke reported 423 tokens. Accepted-only and whole-corpus agreement coincide because all 200 items were accepted. Gemini's report retains 200 unclassified items and zero coverage; those bookkeeping zeros are not evidence of poor model accuracy. Its tool smoke and simulation were skipped, and the cause of its HTTP 503 responses was not established.

Groq passed every predeclared threshold: schema validity >=95%, coverage >=90%, whole-corpus joint agreement >=90%, all four pilots correct, and tool smoke passed. It was the only qualifying provider in this run. Select **Groq GPT-OSS 120B** as the explicit M2/M3 default. This establishes classification and a small tool protocol, not the complete M3 agent loop or streaming suitability. Gemini remains available for a future explicit diagnostic; no automatic fallback is enabled.

## Limits and billing evidence

Groq's responses reported `x-ratelimit-limit-requests: 1000` and `x-ratelimit-limit-tokens: 8000`. The [official header definitions](https://console.groq.com/docs/rate-limits#rate-limit-headers) identify these as requests per day and tokens per minute, respectively. Remaining daily requests fell from 999 to 988 across the 12 successful calls. No HTTP 429 occurred. Gemini returned no quota headers or reported token usage.

These are observed API limits. Account billing tier, charges and other absolute quotas were not verified through this API run; missing usage is not proof of zero usage or charge. No billing settings were changed. The selected model has a [published free offering](https://console.groq.com/docs/rate-limits), but the observed successful requests alone do not establish account billing status. M3 must respect the 8,000-token-per-minute limit; classifier caching and compact tool results matter for repeated demos.

## Errors retained, not tuned away

Eight price labels were predicted as other: `feedback-007`, `018`, `091`, `094`, `103`, `105`, `151`, `164`. These include lost income and shipping-cost concerns. Five considering-cancel labels were predicted as stay: `feedback-104`, `107`, `114`, `121`, `135`. There were no other-to-price errors in this run.

`feedback-114` contains instruction-like text alongside indecision about renewal and was misclassified as stay. The instruction guard does not guarantee classification correctness. Model confidence on the disagreements ranged from 0.80 to 0.90, so the 0.70 filter does not identify these mistakes. Keep server validation, selective eligibility and merchant approval; confidence is not calibrated accuracy. Neither the labels nor the prompt were revised after these results.

## Evidence and simulated round trip

The accepted predictions produced these reason-share estimates on a copy of the twin:

| Known segment | Price / other counts | Beta posterior |
| --- | --- | --- |
| new | 17 / 23 | Beta(18, 24) |
| core | 16 / 24 | Beta(17, 25) |
| price_sensitive | 17 / 22 | Beta(18, 23) |
| at_risk | 16 / 23 | Beta(17, 24) |
| cancel_intent | 18 / 24 | Beta(19, 25) |

Only the affected reason-share provenance became estimated, explicitly from AI-classified synthetic feedback. Churn, transitions and discount-effect assumptions were preserved. These counts describe the synthetic feedback sample; they are not measured population cancellation rates or causal discount effects.

Both simulations used 1,000 runs, 12 months and seed `20261113`. Each reports paired differences against its own do-nothing baseline:

| Strategy | Canonical M1 median value difference | Classified-evidence median value difference | Classified-evidence chance worse |
| --- | ---: | ---: | ---: |
| Broad at-risk campaign | -$1,425 | -$1,327 | 75.8% |
| Price-driven cancel save | +$105 | +$88 | 41.4% |
| Annual prepay | +$10,357 | +$10,351 | 0/1,000 simulated runs |
| Cut list price to $22 | -$56,757 | -$56,906 | 100.0% |
| Raise list price to $27 | +$62,695 | +$62,381 | 0.1% |

All values in this table are simulated. The price-rise result remains assumption-driven; simulation frequencies are not guarantees. The canonical M1 twin and results remain unchanged. The CLI demonstrates the additional classified-evidence path explicitly; it does not silently update the dashboard merchant or pilot registry.

## Reproduction and handoff

Dimensions are SHA-256 over UTF-8 JSON serialization, except the instruction hash, which covers the instruction text directly:

| Dimension | Value |
| --- | --- |
| Corpus / prompt / schema version | `feedback-corpus-v1` / `feedback-v1` / `classification-v1` |
| Fixture | `375cfb7fc691177dcae43f693f7fb056079608fb7c431ac61b6dcef8d202fe56` |
| Projected input | `f15a668db47108d60c8bb37bd7596451111a93c4365a29b01352c9970df20df6` |
| Hidden truth | `1267bea9921e906caa6f2c84b5d6102e2a48ecf048486185d5ce0735ade43618` |
| Instruction | `da643eaf432d85f4a6861db43d4d6ff55dfc33d4917def29a227cc5789717525` |
| JSON schema | `26202f853343ea6737742325329d88472e8e23382e78e42c54a365e21852165c` |

The two ignored `data/signals-eval-2026-10-22T15-16-19.*.json` artifacts retain predictions, safe metrics, confusion counts, pilot mapping and simulation summaries. They do not transfer through Git. A new fresh run may differ due to provider variability or availability. The benchmark deliberately did not populate the SQLite cache; M3 must populate or explicitly validate/import cache entries rather than pretending a cached run is fresh.

Next is M3: implement and test the selected provider's full tool loop and streamed timeline, consume the classified twin explicitly, enforce classifier-derived pilot eligibility when creating a fresh proposal, and retain exact-payload merchant approval. M2 did not approve or execute any PayPal proposal.

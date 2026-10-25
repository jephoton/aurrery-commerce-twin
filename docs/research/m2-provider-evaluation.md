# AI provider evaluation and follow-up

**Current decision:** Gemini `gemini-3.5-flash-lite` passed the unchanged classification gates and a corrected, separately measured tool smoke on 2026-10-25. The user selected it for M3 if it passed; M3 integration and complete agent-flow acceptance remain pending. The original Groq selection and all unsuccessful attempts remain below. See [the follow-up decision](../decisions/0004-gemini-flash-lite-primary.md).

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

## Gemini reevaluation, 2026-10-25

The user requested another Gemini evaluation and authorized using it as M3's primary provider if it passed. The existing corpus, truth, prompt, schema, confidence filter and suitability thresholds were unchanged. Calls were fresh, with the existing 30-second interbatch pacing and no cache reuse. Model overrides were process-only during evaluation; runtime configuration was not changed by the evaluator.

`gemini-3.8-flash` first timed out at 60 seconds; its one permitted retry returned HTTP 503. Total wall time was 79.286 seconds, with no predictions or quota evidence. Accuracy remains unassessed for that model. This is an availability failure, not a measured HTTP 429 rate-limit failure.

Google lists [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) as stable with structured outputs and function calling, and its [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists free input/output tokens on the free tier. It was therefore evaluated separately with the same key and benchmark, without changing billing settings or the configured runtime provider.

| Measure | Fresh Flash-Lite classification | Corrected tool follow-up |
| --- | --- | --- |
| Model | `gemini-3.5-flash-lite` | same explicitly requested model |
| HTTP requests | 10, all 200; no retry | 2, both 200; no retry |
| Accepted / schema-valid | 200/200; 100% | exact read-only call/result passed |
| Intent agreement | 97.5% (195/200) | — |
| Reason agreement | 98.5% (197/200) | — |
| Joint agreement | 96.0% (192/200) | — |
| Pilot checks | all four correct; only A/B eligible | — |
| HTTP time | 48.591 seconds | 1.428 seconds |
| Reported tokens | 9,970 input + 9,024 output = 18,994 | 175 input + 31 output = 206 |

The original full evaluation took 324.522 seconds including pacing and simulations, but its tool smoke returned HTTP 400. A targeted diagnostic confirmed our declaration used JSON Schema's `additionalProperties` inside Gemini's narrower `parameters` field. This was a request-format bug, not evidence that the model could not call tools. The reviewed correction `e34c899` sends the identical strict schema through [`parametersJsonSchema`](https://ai.google.dev/api/generate-content#FunctionDeclaration), leaving Groq's declaration, both test prompts and all scoring criteria unchanged. Two regression assertions failed before the correction; all 22 tool-smoke tests then passed, along with the full 352-test suite, typecheck and lint. Independent spec and quality reviews passed.

After the correction, a fresh two-request live smoke passed with the expected synthetic merchant and exact price. The original 200 classifications were not regenerated or edited. The existing `scoreClassification` function rescored those unchanged predictions with the newly measured smoke success, after checking all current corpus/input/truth/prompt/schema fingerprints. Every predeclared gate then passed (`suitable=true`). This combines fresh classification evidence and a separate fresh corrected smoke; it is **not** a second end-to-end evaluation run. The original failed evaluation and targeted failed diagnostic remain intact.

Compared with the original Groq run, Flash-Lite's joint agreement is 2.5 percentage points higher on this fixture. The runs occurred at different times, and the sample does not establish general superiority. Its measured HTTP time was not lower. Neither provider returned HTTP 429 in these paced evaluations, so this is not a quota-headroom benchmark. Gemini returned no quota headers; [Google directs users to their project's active limits](https://ai.google.dev/gemini-api/docs/rate-limits), which depend on model and account status. Actual account tier, available capacity and charges remain unverified. No billing settings were changed.

Eight Flash-Lite disagreements remain: `feedback-018` price → other; `104`, `107`, `119`, `121`, `135` considering-cancel → stay; `179`, `197` other → price. The two other-to-price mistakes were both stay intent and did not expand pilot eligibility. Confidence filtering did not remove these errors. No prompt, truth or thresholds were tuned in response.

Classified reason counts were new 18/22 price/other, core 18/22, price-sensitive 19/20, at-risk 17/22 and cancel-intent 21/21. The same 1,000-run, 12-month, seed-20261113 round trip produced paired median Δ value of −$1,213.58 for broad at-risk, +$89.27 for selective price saves and +$10,475.35 for annual prepay, each against its own baseline. These remain simulated, and the canonical M1 twin is unchanged. Annual execution remains M7.

### Follow-up evidence

All artifacts are ignored local files, not part of Git; no raw requests, keys or private reasoning are included in the reports.

| Artifact | SHA-256 |
| --- | --- |
| `data/signals-eval-2026-10-25T08-02-57.018Z-6a9e9b83-f5a2-4e25-9c52-3f521de0c93e.json` (3.8 availability failure) | `7db6a9f3a9a9817d83348b1edde8974f939f72e9102f8f2601497f5efe30931c` |
| `data/signals-eval-2026-10-25T08-08-57.880Z-7affbe02-0a95-445f-949a-ab94e370c0ca.json` (200 fresh Flash-Lite predictions, original failed smoke) | `209664b071c5604a664ac9df11f003557dd814ace42336d36fdb188fbf1e4843` |
| `data/gemini-tool-2026-10-25T08-16-03-309Z-3f4a9e00-8752-4eee-9198-210a2898ec8b.json` (corrected live smoke) | `7182773d836bf9406f11b754ca1c492afda02de89cd85f397f3f22423935ea96` |

The follow-up record `data/gemini-validation-followup-2026-10-25T08-16-52-958Z-bbc5b9f7-62ad-43ea-b08c-cb6da8297d38.json` retains source hashes, fingerprint checks and the complete rescored gates. The targeted failed request-format diagnostic is retained separately as `data/gemini-tool-2026-10-25T08-09-57-112Z-2148289e-e77e-4929-9662-ff9091724eaa.json`.

Selection now follows the user's conditional instruction: implement explicit Gemini Flash-Lite as M3's primary provider, retain Groq for deliberate diagnostics, and keep automatic fallback disabled. Passing this benchmark plus one-tool round trip does not establish full M3 reliability. Complete the [Gemini integration plan](../superpowers/plans/2026-10-25-m3-gemini-provider.md) and actual dashboard acceptance before merging M3.

### Account quota follow-up

After the API evaluation, a read-only inspection of [AI Studio's active rate-limit page](https://aistudio.google.com/rate-limit) showed **Free tier**, with `gemini-3.5-flash-lite` limits of **250,000 input tokens/minute, 15 requests/minute and 500 requests/day**. The user explicitly confirmed that the configured Gemini key belongs to the displayed project. Listing keys was permission-denied, so the key-to-project association comes from that confirmation, not an automatic key lookup. A cropped local screenshot is retained as `data/m3-browser/gemini-quota.jpg`; no account email, project identifier or key is copied into this report.

This supplies account-specific evidence that was unavailable during the API-only measurements above. It is a quota snapshot, not a guarantee of capacity or future limits, and does not establish past charges. The Gemini token allowance is 31.25 times Groq's previously observed 8,000 TPM; its 500 daily requests are fewer than Groq's previously observed 1,000/day. Gemini still has both per-minute and daily request limits. The two token figures also differ in definition: Gemini's page labels input tokens, while the app conservatively accounts total input/output usage.

The initial M3 Gemini adapter deliberately retained conservative 8,000-TPM pacing while account limits were unknown. That application setting would preserve unnecessary waits despite the larger verified allowance. A separately reviewed, server-only opt-in profile may use **100,000 total tokens/minute and 12 requests/minute**, below the observed project limits, while retaining the 32,000-token total-run cap, ten-minute wall cap, ten-tool/eleven-turn bounds, cancellation and terminal HTTP 429 behavior. Defaults stay conservative for unknown projects, and Groq keeps its own pacing. This is application configuration based on verified evidence; it does not raise any provider quota or change billing.

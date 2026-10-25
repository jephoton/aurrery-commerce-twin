# 0004: Select Gemini Flash-Lite as M3 primary after reevaluation

**Status:** accepted (2026-10-25); integration and complete agent-flow acceptance pending.

## Context

The original Gemini-then-Groq evaluation selected Groq because Gemini 3.8 Flash was unavailable. The user requested another Gemini evaluation and explicitly authorized using Gemini as M3's primary provider if it passed. This updates [0003](0003-ai-provider-evaluation.md)'s selected model while preserving its evaluation and approval boundaries.

## Decision

Use explicit `AI_PROVIDER=gemini` with `GEMINI_MODEL=gemini-3.5-flash-lite` after its M3 adapter and configuration wiring pass review. Keep Groq available for deliberate diagnostics and historical replay. Do not implement automatic fallback or change billing settings.

Flash-Lite produced 200 valid accepted classifications, 96.0% joint agreement and all four pilot labels correct, excluding C/D. Its initial tool smoke exposed our invalid schema-field mapping; the reviewed fix preserves the strict schema through Gemini's JSON Schema declaration field. A fresh corrected two-request smoke passed. Rescoring the unchanged fresh classifications with that measured smoke passed all existing suitability gates. The original failed evaluation is retained; this is combined evidence from separate classification and smoke measurements, not a newly fabricated full-run success.

The [measured report](../research/m2-provider-evaluation.md) records metrics, hashes, retained errors and limits. Gemini 3.8 Flash still failed with timeout then HTTP 503. Flash-Lite's result does not establish larger account quotas, lower latency or general accuracy superiority; neither paced provider evaluation produced HTTP 429. Account tier and charges remain unverified.

## Consequences

Generalize the existing M3 provider boundary, truthful provenance, cache identity and token accounting. Retain seven strict tools, provider-isolated predictions, canonical twin, bounded calls/time/tokens, cancellation, exact hashed proposals and separate merchant approval. Preserve private Gemini content/signatures internally when required by its protocol; never include them in public transcripts or fixtures.

The [integration plan](../superpowers/plans/2026-10-25-m3-gemini-provider.md) requires tests, independent reviews and a real default-objective dashboard flow. M3 stays incomplete and unmerged until that flow and the unchecked A/B-only approval payload pass acceptance. A successful classifier and one-tool smoke do not establish full agent reliability.

Subsequent read-only AI Studio evidence, with the user confirming the key's project, verifies Free-tier Flash-Lite limits of 250,000 input TPM, 15 RPM and 500 RPD at inspection. This supersedes the earlier lack of account-tier/quota evidence, without establishing past charges. Use a separately reviewed server-only opt-in pacing profile of 100,000 total TPM and 12 RPM for this confirmed project; keep conservative defaults for unknown projects and preserve all per-run limits. The application must enforce request pacing as well as token pacing, and received HTTP 429 still stops rather than silently falling back.

The adapter passed independent spec and quality reviews at `12b9dd7`; runtime selection and the matching 200-record cache import followed. The rate-profile implementation at `2e19814` also passed both reviews (42 and 34 focused tests respectively), after which the parent activated the ignored 100,000-TPM/12-RPM settings while preserving all other configuration. A real CLI run completed under the original conservative pacing, with eight HTTP 200 responses and an unapproved A/B-only proposal. Its numeric prose contained two errors recorded in the [M3 validation report](../research/m3-agent-validation.md). Grounded narrative and the dashboard flow under the opt-in profile still require a subsequent genuine run; neither implementation review nor the original CLI establishes that acceptance.

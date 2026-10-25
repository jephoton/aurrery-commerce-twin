# M3 Gemini provider integration

> Execute with subagent-driven-development: failing tests, one implementer, independent spec review, then quality review. This supplements the existing M3 plan; its unfinished acceptance requirements remain in force.

## Authority and activation

The user requested a fresh Gemini evaluation and explicitly chose “Use Gemini if it passes.” Activate this integration only after Gemini passes the frozen benchmark's schema, coverage, joint agreement, all four pilot checks and read-only tool smoke. Preserve every attempted evaluation, including unavailable models and failed request formats. No automatic fallback or billing change is authorized by this plan.

The initial reevaluation of `gemini-3.8-flash` timed out and then returned HTTP 503. `gemini-3.5-flash-lite` classified all 200 inputs with 96.0% joint agreement and all pilots correct, but its tool smoke exposed an invalid declaration field. The reviewed correction at `e34c899` subsequently passed a separate fresh two-request smoke. Rescoring the unchanged fresh classification with that smoke passed every frozen suitability gate, so this plan is active. The original failed artifact is preserved; this is combined measured evidence, not a fresh full evaluation rerun. The prompt, corpus, hidden truth, thresholds and classifier transport remain frozen. See [decision 0004](../../decisions/0004-gemini-flash-lite-primary.md).

## Design

Use the existing transport/provider boundary and seven validated tools. Add a Gemini adapter behind the same public `AgentModel` interface, retaining the Groq adapter and its genuine replay. Selection is explicit through `AI_PROVIDER` and the selected provider's model/key settings. No model can approve, execute or send messages.

Gemini requests use `generateContent`, JSON Schema function declarations, required preparation mode, automatic analysis mode and no tools for final summaries. Preserve returned model content and opaque signatures privately inside the per-run adapter for correct subsequent requests. Project only public text and function calls into the existing transcript and UI. Tool results must match the actual function name and optional provider ID; stable local IDs may bridge calls lacking a provider ID. Never persist or display private provider content/signatures. Reject malformed envelopes, invalid calls, blocked/truncated completions and unmatched history safely.

Keep the strict tool schemas and current candidate-choice freedom. Do not replace missing strategy arguments, choose a winner or weaken prerequisites to make the provider pass. State-reading enforcement or a simpler model-facing strategy contract would be separate, evidence-driven workflow changes.

Generalize classification provenance, stream validation, cache import and CLI settings to the explicitly selected provider. Imported predictions must match provider/model plus all current fingerprints; validate all 200 accepted records before atomic insertion. Do not reuse Groq predictions under Gemini's identity. Preserve the manual path and canonical twin.

All HTTP attempts, classification calls and retries must remain inside the existing shared cancellation/accounting boundary. Recognize Gemini output bounds and reported usage metadata, including thinking tokens in total usage; keep unknown usage conservatively reserved. Preserve ten tools, eleven turns, 32,000 total tokens and ten minutes. Retain conservative 8,000-TPM pacing unless account-specific evidence justifies a separately reviewed setting; use accurate provider-neutral/selected-provider text. Do not claim this conservative setting is Gemini's actual account limit.

## Task 1: Adapter and complete provider wiring

- [x] Inspect existing Groq adapter and both M2 tool-smoke implementations. Check current official Gemini API documentation before writing wire code.
- [x] Add failing fake-HTTP tests for required/automatic/final modes, complete matching tool history, opaque signature preservation without public leakage, generated IDs when provider IDs are absent, multiple calls, malformed/truncated/blocked output and safe errors. Preserve existing Groq tests/replay.
- [x] Implement the Gemini adapter using the existing transport; generalize explicit provider selection, runner/classification configuration and accurate public status. Missing or unsupported settings fail clearly without fallback.
- [x] Add accounting regressions for Gemini request output bounds, usage metadata, unknown usage, fresh-classification attribution, retries, cancellation and limits. Preserve Groq behavior.
- [x] Generalize tools/contracts/decoder/cache importer/import CLI to provider/model identity. Test cross-provider cache rejection, valid Gemini import, terminal classifier failures, stream validation and eligible proposed-only targeting.
- [x] Run serial tests, typecheck, zero-warning lint and build (owned production server stopped). Update architecture/current state and commit atomically: 402 tests/31 files, typecheck, zero-warning lint, production build and diff check pass.
- [ ] Complete independent spec and quality reviews before runtime activation or any live acceptance claim.

Task 1 implementation uses the existing seven tools and shared HTTP transport. Fake Gemini HTTP completes seven tools/eight turns with ten cold classification batches, creating one unapproved A/B-only $18 proposal with no executions. Its returned private thoughts/signatures are absent from public transcripts and events. The genuine Groq replay remains unchanged. Independent spec and quality reviews and all Task 2 live acceptance remain pending.

## Task 2: Selected Gemini live acceptance

- [ ] Parent changes only the relevant ignored runtime settings after Task 1 review and explicitly imports the qualifying Gemini artifact. Keep credentials out of output and chat.
- [ ] Run the real default dashboard objective and observe progress before completion, computed comparison/stress/draft, a supported proposed action, exact A/B-only $18 payload and unchecked approval. Test Stop/error behavior and verify no automatic approval or execution. Preserve failed attempts and account for conservative pacing.
- [ ] Record measured results and a sanitized genuine Gemini replay through actual tools/ledger, with fictitious registration IDs and network forbidden. Keep the historical Groq replay and do not fabricate model responses.
- [ ] Complete independent replay/final review, final checks and tracked secret/personal-path scan. Update provider decision, roadmap and handoff honestly. Merge/push M3 only after all existing acceptance items pass; M4 follows and annual execution stays M7.

## Primary references

- [Gemini REST generateContent, declarations and content parts](https://ai.google.dev/api/generate-content)
- [Gemini 3.5 Flash-Lite capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini rate limits and account-specific limits](https://ai.google.dev/gemini-api/docs/rate-limits)

The shared transport is already responsible for authentication, bounded responses, safe failures and its one permitted network/timeout/5xx retry. Reuse it rather than adding another HTTP client or arbitrary HTTP 400 retries.

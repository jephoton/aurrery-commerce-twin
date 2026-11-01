# M6: CSV import, design

**Status:** approved in brainstorming on 2026-11-01. Parent design: `2026-10-22-aurrery-design.md` (§5 "CSV import"). Roadmap: M6, "works on your data".

## Goal

Let a merchant upload their own subscriber history (and optionally cancellation feedback) and get a twin estimated from it, with the same simulation, agent and evidence views as the demo merchant.

**Done when:** on the hosted demo, uploading the committed sample "second merchant" files produces a different, explained recommendation; a bad file produces per-row errors and leaves the current twin unchanged. Tests, CI, deploy and a browser check pass.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | **Simulate-only, per browser session.** An import builds a separate twin for that browser. PayPal actions stay tied to Ridgeline's pilots and are disabled for imported merchants. Ridgeline stays the default for every other visitor. |
| Storage | **Stateless rebuild (approach A).** The browser keeps the validated import in memory and sends it with each simulate or agent request; the server re-validates and rebuilds the twin per request. Nothing about the upload is stored server-side. Reloading the page returns to Ridgeline. |
| Feedback | **AI-classified, capped.** Optional `segment, text` CSV, at most 200 rows, classified by the existing classifier (cached, behind the hosted rate limit). Raw text is not stored. Without the file, reason targeting is unavailable and the agent says so. |
| Economics | **Short prefilled form:** merchant name, plan name, list price, unit cost, shipping cost, payment fee rate and fixed fee. Prefilled with Ridgeline's values; labelled merchant-entered assumptions. |

## Files

### History CSV (required)

One row per month × segment, with header:

`month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups`

- `month` is `YYYY-MM`; `segment` is one of `new, core, price_sensitive, at_risk, cancel_intent`.
- `new_signups` is the month's total signups (they enter `new`); it must be equal on every row of the same month.
- A `moved_to_<segment>` column equal to the row's own segment must be 0. Only the moves the twin models are used (new→core, new→price_sensitive, core→at_risk, price_sensitive→at_risk, at_risk→core, at_risk→cancel_intent, cancel_intent→at_risk); other non-zero moves are rejected with a per-row error naming the unsupported move.

### Feedback CSV (optional)

Header `segment, text`. At most 200 rows; text 1–1,000 characters after trimming; segment as above.

## Validation

Errors are reported per row and column, for example `row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start`. Any error rejects the whole import and leaves the current twin unchanged.

- Header present and exact (column order free, names exact, no extra columns).
- Non-negative integers; `active_start ≤ 10,000,000`.
- `voluntary_cancels + involuntary_cancels + sum(moved_to_*) ≤ active_start`.
- At least 6 consecutive months, at most 60; every month has exactly one row per segment (all five); no gaps or duplicates.
- File size at most 256 KiB for history, 256 KiB for feedback; at most 300 history rows.
- The last month becomes the twin's `asOfMonth`. Starting actives for simulation are each segment's last-month `active_start` minus its cancels and moves out, plus moves in, plus signups into `new`.

## Architecture

### `src/import/` (new, pure, no server-only imports)

- `history-csv.ts`: `parseHistoryCsv(text) → { ok: true, rows } | { ok: false, errors: RowError[] }`.
- `feedback-csv.ts`: `parseFeedbackCsv(text)`, same shape.
- `economics.ts`: Zod schema for the form, with bounds (list price 1–200 USD, costs ≥ 0 and below list price combined, fee rate 0–0.2, fixed fee 0–5).
- `import-payload.ts`: the strict, size-capped schema the browser sends with simulate and agent requests: `{ rows, economics, reasonCounts? }`, where `reasonCounts` is per-segment `{ price, other }` integers.
- A minimal CSV reader shared by both parsers (quoted fields, CRLF or LF, BOM stripped); no new dependency unless the existing toolchain already has one.

### Shared twin builder

- `src/twin/build-twin.ts` (or `src/merchant/build.ts`): `buildTwinFromHistory({ rows, economics, reasonCounts?, profile, asOfMonth })`, containing the estimation currently inside `buildDemoTwin`: voluntary churn per segment, pooled involuntary churn, acquisition, transitions, and reason shares as Beta posteriors from counts.
- `buildDemoTwin` becomes a thin call to it with Ridgeline's synthetic history. Ridgeline's twin must be unchanged (a test compares before and after).
- Provenance for an imported twin: estimates say "estimated from your CSV (N months)"; reason shares say "AI-classified from N feedback rows" or remain the prior assumption; price sensitivity, annual uptake, discount effects and unit economics stay assumptions.

### Routes

- `POST /api/import/validate`: bounded body; re-validates history and economics server-side; returns per-row errors or a summary (segments, months, starting actives, estimated churn per segment). Hosted admission: the existing `preparation` limit.
- `POST /api/import/classify`: bounded body; runs the existing classifier on feedback rows (cache first); returns per-segment `{ price, other }` counts and classifier notes. Hosted admission: the agent-class limit, since it can call the model.
- `POST /api/simulate` and `POST /api/agent` accept an optional `import` field (the payload schema). With it, the server builds the twin from the payload for that request and:
  - never reads the ledger's observed evidence (it belongs to Ridgeline's pilots);
  - never creates proposals; the agent's `recommend` returns a simulate-only result for imported merchants and its instructions say so.

### UI

- A "Use your own data" panel: template and sample downloads, history and feedback file inputs, the prefilled economics form, and a "Build twin" action that shows per-row errors or the import summary.
- While an import is active: a banner "Imported: <merchant> · simulate only" with "Back to Ridgeline"; the headline, grid and evidence use the imported twin; Approval, pilots, annual offers and recovery panels are hidden or show "PayPal actions are available for the demo merchant only".
- Evidence panel labels follow the provenance above.

### Sample "second merchant"

A committed synthetic history (and feedback) for a different business, for example a pet-food or meal-kit box with higher price sensitivity and different churn, generated once from fixed rates with a fixed seed, like Ridgeline. It must produce a visibly different headline from Ridgeline, explained by its estimates. The template file is the header plus one example month.

## Safety and privacy

- Uploaded data is never stored server-side, logged or exported. Feedback text passes through the classifier only; the classification cache stores what it already stores today (check and document whether that includes text, and if so keep imported text out of it).
- Imported merchants never reach PayPal or the ledger's proposal tables.
- All request bodies are size-capped and strictly validated on the server; the client's parse is for instant feedback only.

## Testing

- Parsers: good files, quoted fields, CRLF and BOM; each validation error with its row and column.
- Builder: Ridgeline unchanged after the refactor; the sample re-estimates churn close to its generating rates.
- Routes: oversized and invalid payloads rejected; imported requests never read observed evidence or create proposals; hosted admission applied.
- Recommendation: the sample produces a different headline from Ridgeline.
- Browser: upload sample → different recommendation; upload a broken file → per-row errors, twin unchanged; "Back to Ridgeline" restores the demo.

## Out of scope

- Syncing history directly from PayPal reporting.
- Saving or sharing imported merchants; persistence across reloads.
- PayPal actions for imported merchants.
- Estimating price sensitivity from the CSV (it stays an assumption until price tests exist).

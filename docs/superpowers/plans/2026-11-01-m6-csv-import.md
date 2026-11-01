# M6 CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant upload monthly subscriber history (and optional cancellation feedback) and get a separate, simulate-only twin for their browser tab, with the same simulation, agent and evidence views as Ridgeline, while Ridgeline's twin stays byte-for-byte unchanged.

**Architecture:** Approach A from the spec (stateless rebuild).
- **Pure import layer** (`src/import/`): a minimal CSV reader, history and feedback parsers with per-row errors, an economics schema and a strict, size-capped payload schema.
- **Shared twin builder** (`src/twin/build-twin.ts`): the estimation that used to live in `buildDemoTwin`. Ridgeline and imports both call it; a golden fixture proves Ridgeline is unchanged.
- **Routes:** `POST /api/import/validate` and `POST /api/import/classify` are new. `POST /api/simulate` and `POST /api/agent` accept an optional `import` payload, rebuild the twin per request, never read Ridgeline's observed ledger evidence and never create proposals.
- **UI:** the browser keeps the validated payload in memory. The workspace is remounted per merchant, and every PayPal panel (approval, annual offers, recovery, pilot cohort, administrator sign-in) is replaced by "PayPal actions are available for the demo merchant only." The headline and grid treat an imported twin as simulate-only: same pick rule, nothing labelled executable. Reloading returns to Ridgeline.

**Tech Stack:** TypeScript, Next.js 16.4 (App Router, Cache Components), React 19.3, Zod 4, Vitest 5, Node 24. No new dependency.

**Inputs (binding):**
- Spec: `docs/superpowers/specs/2026-11-01-m6-csv-import-design.md`.
- Parent design §5 "CSV import": `docs/superpowers/specs/2026-10-22-aurrery-design.md`.
- Roadmap M6: `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md`.
- **The current tree is the source of truth.** `feat/m6-csv-import` is already rebased onto `origin/main` (`01134fb docs: record M7 live acceptance`, M7 merged), and local `main` equals `origin/main`. Every reference to existing code below (file paths, line numbers, exported names, current text) was checked against that tree on 2026-11-01. Task 0 only confirms the base; it does not rebase.

---

## Conventions

- **Branch:** `feat/m6-csv-import`, local only. Nothing is pushed, merged or deployed before Task 24's explicit approval from Jethro.
- **Commits:** Conventional Commits, one logical change each. **Never** add `Co-Authored-By` or any AI trailer, and no "Generated with" lines.
- **Line endings:** preserve each file's existing line endings; new files use LF. Three files touched here are CRLF: `src/merchant/demo.ts`, `docs/current-state.md` and `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md` (Task 24 only). Every other file this plan edits is LF (checked with `git ls-files --eol`). After editing a CRLF file, normalize it with:

  ```bash
  node -e "const fs=require('fs');for(const f of process.argv.slice(1))fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" <file>
  ```

  Then check that `git diff --stat <file>` shows only the intended lines.
- **No external calls:** no task calls PayPal or an AI provider, except the human-gated steps of Task 23 (optional) and Task 24. Tests use fake providers and fake `fetch`. Never touch `data/` (private, git-ignored).
- **Privacy:** uploaded data is never stored server-side, logged or exported. Never add `console.*` calls that could print request bodies, CSV cells or feedback text.
- **Next.js 16:** this is not the Next.js in training data.
  - Before changing or adding a route, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `.../08-caching.md`.
  - `POST` handlers are never cached, so the new import routes need no caching config.
  - `cacheComponents` is on. Any new `GET` handler that touches storage must call `await connection()` first. This plan adds no `GET` handler.
  - A `route.ts` may export only HTTP methods and route config. Shared handler code lives in a private `_lib` folder.
- **Workers:** run `npm run build:workers` once at the start of each session. Targeted `npx vitest run <file>` commands assume the worker bundle exists.
- **After every task:**
  1. Run `npm test -- --maxWorkers=2`, `npm run typecheck` and `npm run lint`. All must pass. (Known flake from M7: the deadline and BUSY tests in `src/agent/run.test.ts` can time out under heavy parallel load; re-run that file alone before treating it as a failure.)
  2. Append a short entry under a `## M6` heading in `docs/current-state.md` (create the heading directly above `## M7 Phase 2` in Task 0). Say what changed, give the test count, and name the next task. No user-specific paths, secrets or links. Re-normalize to CRLF.
  3. Commit it on its own as `docs: record M6 Task N`.

  Task steps below show only the code commit; this handoff commit always follows it.

## Design decisions this plan locks in

Where the spec is silent or ambiguous, this plan decides as follows. Task 22 records these in decision 0009.

1. **Post-M7 base.** M7 made annual-plan offers executable, so the headline rule picks "Annual prepay at 15% off" for Ridgeline (`src/components/headline.test.ts`). The sample merchant is chosen so that its headline differs under these rules (decision 13).
2. **`active_start` excludes the month's signups.** `new_signups` join `new` at the start of their month and are exposed to that month's churn, exactly as Ridgeline's generator does. Consequences:
   - The spec's starting-actives formula holds literally: last-month `active_start` − cancels − moves out + moves in, plus signups into `new`.
   - For `new` rows only, the capacity rule is `voluntary + involuntary + moves ≤ active_start + new_signups`, because that month's signups can cancel or graduate in the same month. A strict reading would reject 3 of the sample's 60 rows. Other segments use the spec's rule unchanged.
   - Internally, a `new` row's exposure (`activeAtStart`) is `active_start + new_signups`.
3. **Row numbers.** On the client, a row is the physical line where its CSV record starts; the header is row 1. The server re-validates the compact payload and numbers rows as payload index + 2. The two agree for files without blank lines or multi-line quoted cells, and the client's errors are the ones users normally see.
4. **Compact payload and body caps.** History rows travel as 10-element tuples in header order. The largest legal payload (300 rows of 8-digit counts) is about 31 KiB, so simulate and validate keep the existing 64 KiB cap of `readBoundedJson`. The agent body cap rises from 16 KiB to 64 KiB. The classify body cap is 640 KiB: feedback text is at most 256 KiB as a file and at most doubles when JSON-escaped, because control characters other than tab and line breaks are rejected (decision 17).
5. **Count bounds.** `active_start ≤ 10,000,000` (spec). The other count columns get the same bound as a safety cap. The capacity rule already bounds cancels and moves, but `new_signups` needs an explicit one.
6. **Classification cache.** Checked in `src/signals/cache.ts`: the persistent `feedback_prediction_cache` stores a SHA-256 key of the model input and the label JSON (`id, intent, reason, confidence`), never text, and it is one of the tables `ledger:export` copies (`TABLES` in `src/ledger/import.ts`). Imports still never write it, because derived rows would persist facts about uploaded data and travel in ledger exports. Imports use a bounded process-memory cache instead (2,000 entries, the same hashed keys, labels only). It is read first, so re-uploading the same file in the same process makes no model call.
7. **Classification budget.** `/api/import/classify` holds the agent lease, which serializes it with agent runs, and uses the agent admission limit. It has its own run budget with the selected provider's rate profile and the shared process token window, and a deadline of 300 s. If the budget, deadline or provider stops it, it returns partial counts with `stopped: true` instead of failing. Hosted Gemini defaults to 8,000 TPM, about one batch of 20 per minute, so the sample feedback has 40 rows (2 batches).
8. **Reason targeting.** It is available only when at least one feedback row was accepted. Otherwise strategies with `reason: "price"` are rejected (`REASON_UNAVAILABLE` from the simulate route and the agent tool) and dropped from the starter list.
9. **Starter strategies scale with list price.** The list-price candidates are −1/12 and +1/8 of the list price, in whole dollars (Ridgeline's $24 gives exactly $22 and $27). They are dropped if they fall outside $5–$200 or fail to move the price.
10. **Imported headline: same pick, simulate-only.** `src/components/headline.ts` gains `isRecommendableIntervention` (retention discounts and annual plans: the kinds with a PayPal action for the demo merchant). List-price changes stay out of the pick for every merchant, because price response is an unobserved assumption, which is just as true for a CSV. `chooseHeadline(comparison, rules, { simulateOnly })` picks with that rule for both merchants, so the comparison stays like-for-like. With `simulateOnly: true`:
    - `isExecutableIntervention(intervention, { simulateOnly: true })` and `isExecutable` return false for every strategy, and the grid's "Executable" column says "Simulate only" (`comparisonRows` and `toRows` take the same option);
    - `alsoExecutable` is always empty and the headline carries `simulateOnly: true`;
    - `DecisionSummary` labels the pick "Best within your rules" with "· simulate only" instead of "Recommended now", drops the annual "Can be sent as an offer" sentence, and says "Simulate only: PayPal actions are available for the demo merchant only."
11. **Imported agent.** `classify_feedback` reports the counts the server classified before the run and makes no model call. `recommend` applies the same prerequisites, kind rule and decision rules, then records a simulate-only recommendation and emits a new `recommendation` event. It never reads the pilot registry, never calls `proposeStrategy` (so no retention proposal and no annual-plan offer), and never reaches PayPal. The run completes after `recommend` exactly as it does after a proposal.
12. **Workspace per merchant.** The workspace is remounted (React `key`) whenever the merchant changes, so no comparison, proposal or evidence crosses twins. In imported mode the approval, execution report, annual offers, recovery, pilot cohort and administrator sign-in sections are not mounted, so the page makes no `/api/paypal/status`, `/api/admin/session`, `/api/annual-offers/links` or recovery reads. One notice says "PayPal actions are available for the demo merchant only."
13. **Sample merchant.** It is "Hollowbrook Treat Box", a fictional $20/month dog-treat box. It has 12 months of history generated from fixed rates with seed 7311, and 40 feedback rows. Its at-risk subscribers churn fast but often recover, and they mostly cite price. Re-measured on the current tree on 2026-11-01 (a scratch script reproducing Tasks 6–10, default rules):
    - **Sample with its feedback classified as labelled:** "At-risk: 20% off for 3 months" is the pick. At 400 futures: median +$3,477, 3.7% chance worse, $886 mean discount cost; annual +$2,765. At 1,000: +$3,452, 3.2%, $887; annual +$2,808. "Raise list price to $23" (+$5,261) is the bigger simulate-only lever.
    - **Sample without feedback:** the annual plan narrowly leads (+$2,818 against +$2,712 for the at-risk discount at 400 futures; +$2,822 against +$2,805 at 1,000). So the different headline depends on the classified feedback. This is intended and explained (at-risk leavers mostly cite price), but it means the "different headline" acceptance needs classification: Task 24, or the optional AI step of Task 23.
    - **Ridgeline:** "Annual prepay at 15% off" at both sample sizes.
    - The at-risk discount cost ($886) is close to the default $1,000 budget. A model change that raises it would flip the pick, and the Task 10 test would catch it.
14. **Economics prefill.** The numbers are prefilled with Ridgeline's values. Name and plan are prefilled "Your merchant" and "Monthly plan", so an import never looks like Ridgeline. "Load sample merchant" fills Hollowbrook's files and values.
15. **`asOfMonth`.** For imports it is the last CSV month (spec). Ridgeline's is the month after its last history month. This only affects labels.
16. **Decision number.** The record is 0009, because 0008 is M7's (there are two 0007 files; do not renumber them).
17. **Feedback text rules.** Text is 1–1,000 characters after trimming (spec) and may not contain control characters other than tab, CR and LF. Each row is sent to the classifier as `{ id: "f<row number from 1>", text, source: "cancel_flow", segment }`: the CSV has no source column, and the twin uses only the reason label.
18. **No observed evidence for imports.** `observedMerchant()` (`src/merchant/observed.ts`) reads both discount outcomes (`readDiscountOutcomes`) and annual-offer evidence (`readAnnualOfferEvidence`). Imported simulate and agent requests never call it and never emit an `observed_snapshot`. The imported simulate response carries `imported: true` and no `observedSnapshot`. Tests spy on both ledger readers. `/api/paypal/status` (which returns `annualEvidence`) is untouched, because imported mode never calls it.
19. **Proposals refuse imports.** `POST /api/proposals` answers 422 `DEMO_ONLY` to any body that carries an `import` field, before parsing or simulating. A stale or hand-made request can never turn an import into a Ridgeline proposal or annual offer.

## File structure

| File | Responsibility |
| --- | --- |
| `src/merchant/fixtures/ridgeline-golden.json` (new) | Byte-for-byte record of `buildDemoTwin()` before the refactor |
| `src/import/row-error.ts` (new) | `RowError`, `ParseResult`, formatting and capping |
| `src/import/csv.ts` (new) | Minimal CSV reader (quotes, CRLF/LF, BOM) and exact-header check |
| `src/import/history-csv.ts` (new) | History columns, cell parsing, `validateHistoryRows` (shared with the server) |
| `src/import/feedback-csv.ts` (new) | Feedback parsing (≤200 rows, 1–1,000 characters, no control characters) |
| `src/import/economics.ts` (new) | Economics form schema, defaults, sample values, error mapping |
| `src/import/messages.ts` (new) | `DEMO_ONLY_MESSAGE`, `REASON_UNAVAILABLE_MESSAGE` |
| `src/import/import-payload.ts` (new) | Strict payload schema `{ rows, economics, reasonCounts? }`, tuple conversion, classify request schema, Zod issue → row error mapping |
| `src/import/csv-write.ts` (new) | `historyRowsFromTwin`, `toCsv`, `historyCsv` (sample generation and round trips) |
| `src/import/imported-twin.ts` (new) | `toTwinHistory`, `buildImportedTwin`, `usesReasonTargeting` |
| `src/import/sample-files.ts` (new) | Public paths of the template and sample files |
| `src/import/sample-merchant.ts` (new) | Hollowbrook's fixed rates, seed, feedback and CSV generation |
| `public/samples/*.csv` (new, generated) | Template, sample history, sample feedback |
| `scripts/generate-sample-merchant.ts` (new) | Writes the three CSVs; deterministic |
| `src/twin/history.ts` (new) | `HistoryRecord`, `TwinHistory`, `monthOffset` |
| `src/twin/synthetic-history.ts` (new) | Seeded history generator (Ridgeline and Hollowbrook) |
| `src/twin/build-twin.ts` (new) | `buildTwinFromHistory`, `startingActives`, `ReasonCounts` |
| `src/merchant/demo.ts` (modify, CRLF) | Thin Ridgeline wrapper over the generator and builder |
| `src/merchant/summary.ts` (new) | `MerchantSummary` (moved from `Lab.tsx`), `ImportedDetails`, `summarizeMerchant` |
| `src/merchant/candidates.ts` (modify) | `starterStrategiesFor(listPrice, { reasonTargeting })` |
| `src/app/page.tsx` (modify) | Uses `summarizeMerchant` |
| `src/app/api/_lib/http.ts` (modify) | `readBoundedJson` size option, `invalidImportResponse`, `reasonUnavailableResponse`, `demoOnlyResponse` |
| `src/app/api/import/validate/route.ts` (new) | Re-validate and summarize an import (preparation limit) |
| `src/app/api/simulate/route.ts` (modify) | Optional `import` field; no observed evidence for imports |
| `src/app/api/proposals/route.ts` (modify) | Refuses bodies that carry `import` |
| `src/signals/memory-cache.ts` (new) | Bounded process-memory prediction cache (hashed keys, labels only) |
| `src/signals/import-classify.ts` (new) | Classify imported feedback into per-segment counts and notes |
| `src/agent/budgeted-classifier.ts` (new) | Pacing wrapper extracted from `run.ts`, with an optional stop-instead-of-throw mode |
| `src/app/api/import/_lib/classify-handler.ts` (new) | Admission, lease, budget and response for classification |
| `src/app/api/import/classify/route.ts` (new) | Exports the handler |
| `src/agent/contracts.ts`, `src/agent/stream.ts` (modify) | `recommendation` event; `requestAgent` sends an optional import |
| `src/agent/tools.ts`, `src/agent/run.ts`, `src/agent/http.ts` (modify) | Imported, simulate-only agent runs |
| `src/components/agent-session.ts`, `src/components/AgentPanel.tsx` (modify) | Send the import; recommendation activity |
| `src/components/lab-state.ts` (modify) | Select the recommended strategy on a `recommendation` event |
| `src/components/import-flow.ts` (new) | Client parse → classify → validate → `ImportSession` |
| `src/components/ImportPanel.tsx` (new) | "Use your own data", imported banner, demo-only notice |
| `src/components/headline.ts`, `src/components/comparison-model.ts`, `src/components/ScenarioGrid.tsx` (modify) | Simulate-only headline and grid for imports |
| `src/components/DecisionSummary.tsx`, `src/components/EvidencePanel.tsx`, `src/components/MerchantOverview.tsx` (modify) | Imported labels and simulate-only text |
| `src/components/Lab.tsx` (modify) | `Lab` holds the import; `Workspace` renders one merchant |
| `src/hosting/routes.test.ts` (modify) | Hosted origin and limit checks for the two import routes |
| `src/test/import-fixture.ts` (new) | `samplePayload()` for tests |
| `docs/decisions/0009-csv-import.md` (new), `docs/architecture.md`, `README.md` (modify) | Handoff docs |

## Spec coverage

| Spec item | Task |
| --- | --- |
| Simulate-only, per browser session; reload returns to Ridgeline | 21, 23, 24 |
| Stateless rebuild per request; nothing stored server-side | 8, 11, 12, 14, 17, 19 |
| History CSV columns, segments, `YYYY-MM`, equal `new_signups` per month | 3 |
| Self-moves must be 0; unsupported moves rejected, naming the move | 3 |
| Header exact (order free, no extras); non-negative integers; `active_start ≤ 10,000,000` | 2, 3 |
| Capacity rule; 6–60 consecutive months; one row per segment; no gaps or duplicates | 3 |
| 256 KiB file caps; ≤300 history rows; per-row/column errors; any error leaves the twin unchanged | 3, 4, 19, 21 |
| Last month → `asOfMonth`; starting actives formula | 7, 8 |
| Feedback CSV: ≤200 rows, 1–1,000 characters, AI-classified, capped, behind hosted admission, raw text not stored | 4, 13, 14 |
| Without feedback, reason targeting unavailable and the agent says so | 8, 9, 12, 16, 17 |
| Economics form with bounds, prefilled, labelled merchant-entered assumptions | 5, 7, 19 |
| `src/import/` pure modules and payload schema | 2–5, 8 |
| Shared builder; Ridgeline unchanged (test) | 1, 6, 7 |
| Imported provenance wording | 7, 20 |
| `POST /api/import/validate` (preparation limit) | 11 |
| `POST /api/import/classify` (agent-class limit, cache first, classifier notes) | 13, 14 |
| Simulate and agent accept `import`; no observed evidence (discount and annual); no proposals or annual offers; `recommend` simulate-only; instructions say so | 12, 15, 16, 17 |
| UI panel: downloads, file inputs, form, Build twin, errors or summary | 19, 21 |
| Banner "Imported: <merchant> · simulate only" and "Back to Ridgeline"; Approval, pilots, annual offers and recovery replaced by the demo-only notice | 19, 21 |
| Headline never claims an imported action is executable | 20, 21 |
| Evidence labels follow provenance | 20 |
| Committed synthetic sample with a different headline; template; downloadable | 10, 20, 24 |
| Classification cache checked and documented | 13, 22 |
| Tests: parsers, builder, routes, recommendation; browser checks | 2–21, 23, 24 |

---

### Task 0: Confirm the post-M7 base and record the baseline

**Files:**
- Modify: `docs/current-state.md` (CRLF)

- [ ] **Step 1: Confirm a clean tree on the post-M7 base**

```bash
git status --short
git merge-base --is-ancestor origin/main HEAD && echo "based on origin/main"
git log --oneline -1 origin/main
git log --oneline origin/main..main
git log --oneline -4
```

Expected:
- no status output;
- `based on origin/main`;
- `origin/main` is `01134fb docs: record M7 live acceptance` (or later, if Jethro has merged since; then stop and ask whether to rebase first);
- the fourth command prints nothing, so local `main` has no commits of its own;
- the log shows `docs(m6): add implementation plan`, `docs(m6): add CSV import design`, `docs(roadmap): fold review tidy-ups into M8`, then `01134fb`.

The branch was rebased before this plan was written. Do not rebase again; nothing is pushed.

- [ ] **Step 2: Baseline checks**

```bash
npm run build:workers
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
```

Expected: all pass. The M7 record says 1155 tests; record the exact count as the M6 baseline.

- [ ] **Step 3: Handoff**

Add `## M6` directly above `## M7 Phase 2` in `docs/current-state.md`, with a first entry:
- "Plan: `docs/superpowers/plans/2026-11-01-m6-csv-import.md`. Local branch `feat/m6-csv-import` on post-M7 `main` (`01134fb`), not pushed.";
- "Task 0: baseline <count> tests, typecheck and lint pass";
- "next: Task 1".

Normalize to CRLF and commit:

```bash
git add docs/current-state.md
git commit -m "docs: record M6 Task 0"
```

---

### Task 1: Pin Ridgeline's twin and history byte-for-byte

**Files:**
- Create: `src/merchant/ridgeline-golden.test.ts`
- Create: `src/merchant/fixtures/ridgeline-golden.json` (generated from the unchanged code)

- [ ] **Step 1: Write the golden test**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildDemoTwin } from "./demo";

// Byte-for-byte guard for the shared twin builder (M6): Ridgeline's twin and history must not change.
// Regenerate only for an intentional model change:
//   UPDATE_RIDGELINE_GOLDEN=1 npx vitest run src/merchant/ridgeline-golden.test.ts
const fixture = join(process.cwd(), "src", "merchant", "fixtures", "ridgeline-golden.json");
const serialized = () => `${JSON.stringify(buildDemoTwin(), null, 2)}\n`;

it("builds exactly the recorded Ridgeline twin and history", () => {
  if (process.env.UPDATE_RIDGELINE_GOLDEN === "1") writeFileSync(fixture, serialized());
  expect(serialized()).toBe(readFileSync(fixture, "utf8"));
});
```

- [ ] **Step 2: Run it to see it fail (no fixture yet)**

Run: `npx vitest run src/merchant/ridgeline-golden.test.ts`

Expected: FAIL with `ENOENT` for `ridgeline-golden.json`.

- [ ] **Step 3: Record the fixture from the unchanged code**

```bash
mkdir -p src/merchant/fixtures
UPDATE_RIDGELINE_GOLDEN=1 npx vitest run src/merchant/ridgeline-golden.test.ts
git status --short
```

Expected:
- PASS;
- the status shows only the two new files, so no source changed before the record.

- [ ] **Step 4: Run it normally**

Run: `npx vitest run src/merchant/ridgeline-golden.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merchant/ridgeline-golden.test.ts src/merchant/fixtures/ridgeline-golden.json
git commit -m "test(merchant): pin Ridgeline twin and history byte-for-byte"
```

---

### Task 2: Minimal CSV reader and row errors

**Files:**
- Create: `src/import/row-error.ts`
- Create: `src/import/csv.ts`
- Test: `src/import/csv.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/import/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkHeader, readCsv } from "./csv";
import { capErrors, formatRowError, MAX_REPORTED_ERRORS } from "./row-error";

describe("readCsv", () => {
  it("reads LF and CRLF records with trimmed unquoted fields", () => {
    expect(readCsv("a, b\n1 ,2\n")).toEqual({ ok: true, records: [{ line: 1, fields: ["a", "b"] }, { line: 2, fields: ["1", "2"] }] });
    expect(readCsv("a,b\r\n1,2\r\n")).toEqual(readCsv("a,b\n1,2\n"));
  });
  it("strips a UTF-8 byte order mark", () => {
    expect(readCsv("\uFEFFa,b\n1,2")).toEqual({ ok: true, records: [{ line: 1, fields: ["a", "b"] }, { line: 2, fields: ["1", "2"] }] });
  });
  it("keeps commas, doubled quotes and newlines inside quoted fields", () => {
    expect(readCsv('segment,text\ncore,"Too pricey, honestly ""meh""\nsecond line"\nnew,ok\n')).toEqual({ ok: true, records: [
      { line: 1, fields: ["segment", "text"] },
      { line: 2, fields: ["core", 'Too pricey, honestly "meh"\nsecond line'] },
      { line: 4, fields: ["new", "ok"] },
    ] });
  });
  it("skips blank lines but keeps physical line numbers", () => {
    expect(readCsv("a\n\n  \nb\n")).toEqual({ ok: true, records: [{ line: 1, fields: ["a"] }, { line: 4, fields: ["b"] }] });
  });
  it("rejects an unterminated quote and stray quotes with the line number", () => {
    expect(readCsv('a,b\n1,"open\n')).toEqual({ ok: false, line: 2, message: "unterminated quoted field" });
    expect(readCsv('a,b\n1,x"y\n')).toEqual({ ok: false, line: 2, message: "a quote may only start a field" });
    expect(readCsv('a,b\n1,"x"y\n')).toEqual({ ok: false, line: 2, message: "unexpected text after a closing quote" });
  });
});

describe("checkHeader", () => {
  const expected = ["segment", "text"] as const;
  it("accepts the exact names in any order", () => {
    expect(checkHeader(["text", "segment"], expected, 1)).toEqual([]);
  });
  it("reports duplicate, unknown and missing columns", () => {
    expect(checkHeader(["segment", "segment", "notes"], expected, 1)).toEqual([
      { row: 1, column: "segment", message: "duplicate column" },
      { row: 1, column: "notes", message: "unknown column" },
      { row: 1, column: "text", message: "missing column" },
    ]);
  });
});

describe("row errors", () => {
  it("formats row, column and file-level errors", () => {
    expect(formatRowError({ row: 14, column: "voluntary_cancels", message: "too many" })).toBe("row 14, voluntary_cancels: too many");
    expect(formatRowError({ row: null, column: "month", message: "too few months" })).toBe("month: too few months");
    expect(formatRowError({ row: null, column: null, message: "file too large" })).toBe("file too large");
  });
  it("caps long error lists with a count of the rest", () => {
    const errors = Array.from({ length: MAX_REPORTED_ERRORS + 3 }, (_, i) => ({ row: i + 2, column: null, message: "bad" }));
    const capped = capErrors(errors);
    expect(capped).toHaveLength(MAX_REPORTED_ERRORS + 1);
    expect(capped.at(-1)).toEqual({ row: null, column: null, message: "3 more errors not shown" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/csv.test.ts`

Expected: FAIL, because `./csv` and `./row-error` do not exist.

- [ ] **Step 3: Implement**

`src/import/row-error.ts`:

```ts
/** A validation error located by CSV row (the physical line where the record starts; the header is row 1) and column. */
export interface RowError { row: number | null; column: string | null; message: string }

export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; errors: RowError[] };

export const MAX_REPORTED_ERRORS = 50;

export function formatRowError(error: RowError): string {
  const where = [error.row === null ? null : `row ${error.row}`, error.column].filter((part): part is string => !!part).join(", ");
  return where ? `${where}: ${error.message}` : error.message;
}

/** Keeps responses and the UI bounded; the last entry says how many were left out. */
export function capErrors(errors: RowError[]): RowError[] {
  if (errors.length <= MAX_REPORTED_ERRORS) return errors;
  return [...errors.slice(0, MAX_REPORTED_ERRORS), { row: null, column: null, message: `${errors.length - MAX_REPORTED_ERRORS} more errors not shown` }];
}
```

`src/import/csv.ts`:

```ts
import type { RowError } from "./row-error";

// Minimal CSV reader for merchant uploads: comma-separated, double-quoted fields with "" escapes,
// CRLF, LF or CR line endings, UTF-8 BOM stripped. Unquoted fields are trimmed; blank lines are
// skipped. No dependency: the toolchain has no CSV parser.

export interface CsvRecord { line: number; fields: string[] }
export type CsvResult = { ok: true; records: CsvRecord[] } | { ok: false; line: number; message: string };

export function readCsv(text: string): CsvResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let recordLine = 1;
  const endField = () => { fields.push(wasQuoted ? field : field.trim()); field = ""; wasQuoted = false; };
  const endRecord = () => {
    endField();
    if (!(fields.length === 1 && fields[0] === "")) records.push({ line: recordLine, fields });
    fields = [];
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (wasQuoted || field.trim() !== "") return { ok: false, line, message: "a quote may only start a field" };
      field = "";
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || (c === "\r" && input[i + 1] !== "\n")) {
      endRecord();
      line++;
      recordLine = line;
    } else if (c === "\r") {
      // The LF of this CRLF ends the record.
    } else if (wasQuoted) {
      if (c.trim() !== "") return { ok: false, line, message: "unexpected text after a closing quote" };
    } else {
      field += c;
    }
  }
  if (quoted) return { ok: false, line: recordLine, message: "unterminated quoted field" };
  if (field !== "" || fields.length > 0 || wasQuoted) endRecord();
  return { ok: true, records };
}

/** Column names must match exactly; order is free; no duplicates or extras. */
export function checkHeader(fields: string[], expected: readonly string[], line: number): RowError[] {
  const errors: RowError[] = [];
  const seen = new Set<string>();
  for (const name of fields) {
    if (!expected.includes(name)) errors.push({ row: line, column: name || "(blank)", message: "unknown column" });
    else if (seen.has(name)) errors.push({ row: line, column: name, message: "duplicate column" });
    seen.add(name);
  }
  for (const name of expected) if (!seen.has(name)) errors.push({ row: line, column: name, message: "missing column" });
  return errors;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/import/csv.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/import/row-error.ts src/import/csv.ts src/import/csv.test.ts
git commit -m "feat(import): add minimal CSV reader and row errors"
```

---

### Task 3: Parse and validate the history CSV

**Files:**
- Create: `src/import/history-csv.ts`
- Test: `src/import/history-csv.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/import/history-csv.test.ts`. The fixture writes 6 months × 5 segments. The month at index `m` and segment at index `s` sit on line `2 + 5m + s`, so line 14 is 2026-03 `price_sensitive`.

```ts
import { describe, expect, it } from "vitest";
import { SEGMENTS, type SegmentId } from "@/twin/types";
import { COUNT_COLUMNS, HISTORY_COLUMNS, parseHistoryCsv, validateHistoryRows, type CountColumn } from "./history-csv";
import { formatRowError } from "./row-error";

type Counts = Partial<Record<CountColumn, number>>;
const BASE: Record<SegmentId, Counts> = {
  new: { active_start: 100, voluntary_cancels: 10, involuntary_cancels: 1, moved_to_core: 20, moved_to_price_sensitive: 15 },
  core: { active_start: 500, voluntary_cancels: 10, involuntary_cancels: 5, moved_to_at_risk: 10 },
  price_sensitive: { active_start: 200, voluntary_cancels: 12, involuntary_cancels: 2, moved_to_at_risk: 8 },
  at_risk: { active_start: 80, voluntary_cancels: 12, involuntary_cancels: 1, moved_to_core: 8, moved_to_cancel_intent: 6 },
  cancel_intent: { active_start: 20, voluntary_cancels: 6, involuntary_cancels: 0, moved_to_at_risk: 3 },
};
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
function row(month: string, segment: SegmentId, overrides: Counts = {}): string {
  const counts: Record<CountColumn, number> = { active_start: 0, voluntary_cancels: 0, involuntary_cancels: 0, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 50, ...BASE[segment], ...overrides };
  return [month, segment, ...COUNT_COLUMNS.map((c) => counts[c])].join(",");
}
const rows = (months = MONTHS) => months.flatMap((m) => SEGMENTS.map((s) => row(m, s)));
const csv = (lines: string[] = rows(), header = HISTORY_COLUMNS.join(",")) => `${[header, ...lines].join("\n")}\n`;
const messages = (text: string) => {
  const result = parseHistoryCsv(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map(formatRowError);
};

describe("parseHistoryCsv", () => {
  it("parses a valid file into typed rows", () => {
    const result = parseHistoryCsv(csv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(30);
    expect(result.rows[0]).toEqual({ month: "2026-01", segment: "new", active_start: 100, voluntary_cancels: 10, involuntary_cancels: 1, moved_to_core: 20, moved_to_price_sensitive: 15, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 50 });
  });
  it("accepts any column order and a header with spaces after commas", () => {
    const swap = (line: string) => { const [a, b, ...rest] = line.split(","); return [b, a, ...rest].join(","); };
    const header = ["segment", "month", ...COUNT_COLUMNS].join(", ");
    const result = parseHistoryCsv(csv(rows().map(swap), header));
    expect(result.ok && result.rows[0].segment).toBe("new");
  });
  it("rejects unknown, missing and duplicate header columns", () => {
    expect(messages(csv(rows(), `${HISTORY_COLUMNS.join(",")},notes`))).toEqual(["row 1, notes: unknown column"]);
    expect(messages(csv(rows(), HISTORY_COLUMNS.slice(0, -1).join(",")))).toEqual(["row 1, new_signups: missing column"]);
  });
  it("reports each malformed cell with its row and column", () => {
    const lines = rows();
    lines[0] = lines[0].replace("2026-01,new,100", "2026-13,new,-1");
    lines[1] = lines[1].replace("2026-01,core", "2026-01,vip");
    lines[2] = row("2026-01", "price_sensitive", { voluntary_cancels: 1.5 as number });
    lines[3] = row("2026-01", "at_risk", { active_start: 10_000_001 });
    expect(messages(csv(lines))).toEqual([
      "row 2, month: must be YYYY-MM",
      "row 2, active_start: must be a non-negative integer",
      "row 3, segment: must be one of new, core, price_sensitive, at_risk, cancel_intent",
      "row 4, voluntary_cancels: must be a non-negative integer",
      "row 5, active_start: must be at most 10,000,000",
    ]);
  });
  it("rejects cancels plus moves beyond active_start, with the spec's wording", () => {
    const lines = rows();
    lines[12] = row("2026-03", "price_sensitive", { voluntary_cancels: 9999 });
    expect(messages(csv(lines))).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  });
  it("lets new rows use the month's signups as capacity", () => {
    const lines = rows();
    lines[0] = row("2026-01", "new", { active_start: 10, voluntary_cancels: 10, moved_to_core: 20, moved_to_price_sensitive: 15 });
    expect(parseHistoryCsv(csv(lines)).ok).toBe(true);
    lines[0] = row("2026-01", "new", { active_start: 10, voluntary_cancels: 30, moved_to_core: 20, moved_to_price_sensitive: 15 });
    expect(messages(csv(lines))).toEqual(["row 2, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start + new_signups"]);
  });
  it("rejects self-moves and unsupported moves, naming the move", () => {
    const lines = rows();
    lines[1] = row("2026-01", "core", { moved_to_core: 1, moved_to_price_sensitive: 2 });
    expect(messages(csv(lines))).toEqual([
      "row 3, moved_to_core: a segment cannot move to itself; must be 0",
      "row 3, moved_to_price_sensitive: unsupported move core → price_sensitive",
    ]);
  });
  it("requires one new_signups value per month", () => {
    const lines = rows();
    lines[1] = row("2026-01", "core", { new_signups: 51 });
    expect(messages(csv(lines))).toEqual(["row 3, new_signups: must equal row 2 (50) for 2026-01"]);
  });
  it("rejects duplicates, missing segments and gaps", () => {
    expect(messages(csv([...rows(), row("2026-01", "core")]))).toEqual(["row 32, segment: duplicate row for 2026-01 core (first at row 3)"]);
    const missing = rows().filter((line) => !line.startsWith("2026-02,at_risk"));
    expect(messages(csv(missing))).toEqual(["row 7, segment: 2026-02 is missing at_risk; every month needs one row per segment"]);
    const gap = rows(["2026-01", "2026-02", "2026-03", "2026-05", "2026-06", "2026-07"]);
    expect(messages(csv(gap))).toEqual(["row 17, month: gap: 2026-04 is missing before 2026-05"]);
  });
  it("requires at least 6 months and at most 300 rows", () => {
    expect(messages(csv(rows(MONTHS.slice(0, 5))))).toEqual(["month: at least 6 consecutive months are required (found 5)"]);
    expect(messages(csv(Array.from({ length: 301 }, () => row("2026-01", "new"))))).toEqual(["at most 300 history rows are allowed (found 301)"]);
  });
  it("rejects files over 256 KiB, empty files and short records", () => {
    expect(messages("x".repeat(256 * 1024 + 1))).toEqual(["history file is larger than 256 KiB"]);
    expect(messages("")).toEqual(["history file is empty"]);
    expect(messages(csv(["2026-01,new,1"]))).toEqual(["row 2: expected 10 columns, found 3"]);
  });
});

describe("validateHistoryRows", () => {
  it("numbers server-side rows by payload position when no line numbers exist", () => {
    const parsed = parseHistoryCsv(csv());
    if (!parsed.ok) throw new Error("fixture must parse");
    const broken = parsed.rows.map((r, i) => (i === 12 ? { ...r, voluntary_cancels: 9999 } : r));
    expect(validateHistoryRows(broken).map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/history-csv.test.ts`

Expected: FAIL, because `./history-csv` does not exist.

- [ ] **Step 3: Implement**

`src/import/history-csv.ts`:

```ts
import { SEGMENTS, type SegmentId } from "@/twin/types";
import { checkHeader, readCsv } from "./csv";
import { capErrors, type ParseResult, type RowError } from "./row-error";

// History CSV: one row per month × segment. `active_start` counts subscribers at the start of the
// month BEFORE that month's signups; `new_signups` join `new` at the start of their month and can
// cancel or graduate in the same month (as in Ridgeline's generator).

export const COUNT_COLUMNS = [
  "active_start", "voluntary_cancels", "involuntary_cancels",
  "moved_to_core", "moved_to_price_sensitive", "moved_to_at_risk", "moved_to_cancel_intent",
  "new_signups",
] as const;
export type CountColumn = (typeof COUNT_COLUMNS)[number];
export const HISTORY_COLUMNS = ["month", "segment", ...COUNT_COLUMNS] as const;
export type HistoryColumn = (typeof HISTORY_COLUMNS)[number];
export type HistoryRow = { month: string; segment: SegmentId } & Record<CountColumn, number>;

export const MAX_HISTORY_BYTES = 256 * 1024;
export const MAX_HISTORY_ROWS = 300;
export const MIN_HISTORY_MONTHS = 6;
export const MAX_HISTORY_MONTHS = 60;
/** The spec's bound on `active_start`; also the safety bound on every other count. */
export const MAX_COUNT = 10_000_000;

type MoveTarget = "core" | "price_sensitive" | "at_risk" | "cancel_intent";
export const MOVE_COLUMNS: Record<MoveTarget, CountColumn> = {
  core: "moved_to_core", price_sensitive: "moved_to_price_sensitive", at_risk: "moved_to_at_risk", cancel_intent: "moved_to_cancel_intent",
};
/** The segment moves the twin models; any other non-zero move is rejected. */
export const SUPPORTED_MOVES: Record<SegmentId, readonly MoveTarget[]> = {
  new: ["core", "price_sensitive"],
  core: ["at_risk"],
  price_sensitive: ["at_risk"],
  at_risk: ["core", "cancel_intent"],
  cancel_intent: ["at_risk"],
};
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const INTEGER = /^\d+$/;

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function parseHistoryCsv(text: string): ParseResult<HistoryRow> {
  const file = (message: string): ParseResult<HistoryRow> => ({ ok: false, errors: [{ row: null, column: null, message }] });
  if (new TextEncoder().encode(text).byteLength > MAX_HISTORY_BYTES) return file("history file is larger than 256 KiB");
  const csv = readCsv(text);
  if (!csv.ok) return { ok: false, errors: [{ row: csv.line, column: null, message: csv.message }] };
  const [header, ...records] = csv.records;
  if (!header) return file("history file is empty");
  const headerErrors = checkHeader(header.fields, HISTORY_COLUMNS, header.line);
  if (headerErrors.length) return { ok: false, errors: headerErrors };
  if (records.length > MAX_HISTORY_ROWS) return file(`at most ${MAX_HISTORY_ROWS} history rows are allowed (found ${records.length})`);
  const index = new Map(header.fields.map((name, i) => [name, i]));
  const errors: RowError[] = [];
  const rows: HistoryRow[] = [];
  const lines: number[] = [];
  for (const record of records) {
    if (record.fields.length !== HISTORY_COLUMNS.length) {
      errors.push({ row: record.line, column: null, message: `expected ${HISTORY_COLUMNS.length} columns, found ${record.fields.length}` });
      continue;
    }
    const cell = (column: HistoryColumn) => record.fields[index.get(column)!];
    let valid = true;
    const month = cell("month");
    if (!MONTH.test(month)) { errors.push({ row: record.line, column: "month", message: "must be YYYY-MM" }); valid = false; }
    const segment = cell("segment");
    if (!(SEGMENTS as readonly string[]).includes(segment)) { errors.push({ row: record.line, column: "segment", message: `must be one of ${SEGMENTS.join(", ")}` }); valid = false; }
    const counts = {} as Record<CountColumn, number>;
    for (const column of COUNT_COLUMNS) {
      const raw = cell(column);
      if (!INTEGER.test(raw)) { errors.push({ row: record.line, column, message: "must be a non-negative integer" }); valid = false; continue; }
      const value = Number(raw);
      if (value > MAX_COUNT) { errors.push({ row: record.line, column, message: `must be at most ${MAX_COUNT.toLocaleString("en-US")}` }); valid = false; continue; }
      counts[column] = value;
    }
    if (valid) { rows.push({ month, segment: segment as SegmentId, ...counts }); lines.push(record.line); }
  }
  if (errors.length) return { ok: false, errors: capErrors(errors) };
  const semantic = validateHistoryRows(rows, (i) => lines[i]);
  return semantic.length ? { ok: false, errors: capErrors(semantic) } : { ok: true, rows };
}

/**
 * Cross-row rules, shared by the client parse and the server's re-validation of the payload.
 * `rowNumber` maps a row index to its CSV row; the server's default is index + 2 (header = row 1).
 */
export function validateHistoryRows(rows: HistoryRow[], rowNumber: (index: number) => number = (i) => i + 2): RowError[] {
  if (rows.length > MAX_HISTORY_ROWS) return [{ row: null, column: null, message: `at most ${MAX_HISTORY_ROWS} history rows are allowed (found ${rows.length})` }];
  const errors: RowError[] = [];
  const firstOfKey = new Map<string, number>();
  const firstOfMonth = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = rowNumber(i);
    for (const [to, column] of Object.entries(MOVE_COLUMNS) as [MoveTarget, CountColumn][]) {
      if (r[column] === 0) continue;
      if (to === r.segment) errors.push({ row, column, message: "a segment cannot move to itself; must be 0" });
      else if (!SUPPORTED_MOVES[r.segment].includes(to)) errors.push({ row, column, message: `unsupported move ${r.segment} → ${to}` });
    }
    const out = r.voluntary_cancels + r.involuntary_cancels + Object.values(MOVE_COLUMNS).reduce((sum, column) => sum + r[column], 0);
    const isNew = r.segment === "new";
    if (out > r.active_start + (isNew ? r.new_signups : 0)) {
      errors.push({ row, column: "voluntary_cancels", message: `voluntary + involuntary cancels + moves exceed ${isNew ? "active_start + new_signups" : "active_start"}` });
    }
    const key = `${r.month}|${r.segment}`;
    const first = firstOfKey.get(key);
    if (first !== undefined) errors.push({ row, column: "segment", message: `duplicate row for ${r.month} ${r.segment} (first at row ${rowNumber(first)})` });
    else firstOfKey.set(key, i);
    const monthStart = firstOfMonth.get(r.month);
    if (monthStart === undefined) firstOfMonth.set(r.month, i);
    else if (rows[monthStart].new_signups !== r.new_signups) {
      errors.push({ row, column: "new_signups", message: `must equal row ${rowNumber(monthStart)} (${rows[monthStart].new_signups}) for ${r.month}` });
    }
  });
  const months = [...firstOfMonth.keys()].sort();
  for (const month of months) {
    const missing = SEGMENTS.filter((s) => !firstOfKey.has(`${month}|${s}`));
    if (missing.length) errors.push({ row: rowNumber(firstOfMonth.get(month)!), column: "segment", message: `${month} is missing ${missing.join(", ")}; every month needs one row per segment` });
  }
  for (let i = 1; i < months.length; i++) {
    const expected = nextMonth(months[i - 1]);
    if (months[i] !== expected) errors.push({ row: rowNumber(firstOfMonth.get(months[i])!), column: "month", message: `gap: ${expected} is missing before ${months[i]}` });
  }
  if (months.length < MIN_HISTORY_MONTHS) errors.push({ row: null, column: "month", message: `at least ${MIN_HISTORY_MONTHS} consecutive months are required (found ${months.length})` });
  if (months.length > MAX_HISTORY_MONTHS) errors.push({ row: null, column: "month", message: `at most ${MAX_HISTORY_MONTHS} months are allowed (found ${months.length})` });
  return errors;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/import/history-csv.test.ts`

Expected: PASS (12 tests). If the malformed-cell test fails only on its error order, keep the implementation and fix the expectation: errors are reported row by row, in column order within each row.

- [ ] **Step 5: Commit**

```bash
git add src/import/history-csv.ts src/import/history-csv.test.ts
git commit -m "feat(import): parse and validate history CSV"
```

---

### Task 4: Parse the feedback CSV

**Files:**
- Create: `src/import/feedback-csv.ts`
- Test: `src/import/feedback-csv.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { hasControlCharacters, parseFeedbackCsv } from "./feedback-csv";
import { formatRowError } from "./row-error";

const messages = (text: string) => {
  const result = parseFeedbackCsv(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map(formatRowError);
};

it("parses quoted text with commas and trims it", () => {
  expect(parseFeedbackCsv('text,segment\n"  Too pricey, sorry  ",at_risk\nMoving abroad,core\n')).toEqual({ ok: true, rows: [
    { segment: "at_risk", text: "Too pricey, sorry" },
    { segment: "core", text: "Moving abroad" },
  ] });
});
it("reports bad segments and empty or long text per row", () => {
  expect(messages(`segment,text\nvip,hello\ncore,\ncore,"${"x".repeat(1001)}"\n`)).toEqual([
    "row 2, segment: must be one of new, core, price_sensitive, at_risk, cancel_intent",
    "row 3, text: must be 1–1,000 characters after trimming (found 0)",
    "row 4, text: must be 1–1,000 characters after trimming (found 1001)",
  ]);
});
it("keeps tabs and line breaks but rejects other control characters", () => {
  expect(parseFeedbackCsv('segment,text\ncore,"line one\nline\ttwo"\n').ok).toBe(true);
  expect(messages("segment,text\ncore,bell\u0007here\n")).toEqual(["row 2, text: must not contain control characters other than tab and line breaks"]);
  expect(hasControlCharacters("a\u0085b")).toBe(true);
  expect(hasControlCharacters("tab\tCR\rLF\n")).toBe(false);
});
it("caps rows at 200 and files at 256 KiB, and needs the exact header", () => {
  expect(messages(`segment,text\n${"core,ok\n".repeat(201)}`)).toEqual(["at most 200 feedback rows are allowed (found 201)"]);
  expect(messages("x".repeat(256 * 1024 + 1))).toEqual(["feedback file is larger than 256 KiB"]);
  expect(messages("segment,comment\ncore,ok\n")).toEqual(["row 1, comment: unknown column", "row 1, text: missing column"]);
  expect(messages("segment,text\n")).toEqual(["feedback file has no rows"]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/feedback-csv.test.ts`

Expected: FAIL, because `./feedback-csv` does not exist.

- [ ] **Step 3: Implement**

`src/import/feedback-csv.ts`:

```ts
import { SEGMENTS, type SegmentId } from "@/twin/types";
import { checkHeader, readCsv } from "./csv";
import { capErrors, type ParseResult, type RowError } from "./row-error";

export const FEEDBACK_COLUMNS = ["segment", "text"] as const;
export const MAX_FEEDBACK_BYTES = 256 * 1024;
export const MAX_FEEDBACK_ROWS = 200;
export const MAX_FEEDBACK_TEXT = 1000;
export interface FeedbackRow { segment: SegmentId; text: string }
export const CONTROL_CHARACTER_MESSAGE = "must not contain control characters other than tab and line breaks";

/** C0 and C1 control characters, except tab, CR and LF (multi-line quoted cells are allowed). */
export function hasControlCharacters(text: string): boolean {
  for (const c of text) {
    const n = c.codePointAt(0)!;
    if ((n < 0x20 && c !== "\t" && c !== "\n" && c !== "\r") || (n >= 0x7f && n < 0xa0)) return true;
  }
  return false;
}

export function parseFeedbackCsv(text: string): ParseResult<FeedbackRow> {
  const file = (message: string): ParseResult<FeedbackRow> => ({ ok: false, errors: [{ row: null, column: null, message }] });
  if (new TextEncoder().encode(text).byteLength > MAX_FEEDBACK_BYTES) return file("feedback file is larger than 256 KiB");
  const csv = readCsv(text);
  if (!csv.ok) return { ok: false, errors: [{ row: csv.line, column: null, message: csv.message }] };
  const [header, ...records] = csv.records;
  if (!header) return file("feedback file is empty");
  const headerErrors = checkHeader(header.fields, FEEDBACK_COLUMNS, header.line);
  if (headerErrors.length) return { ok: false, errors: headerErrors };
  if (records.length === 0) return file("feedback file has no rows");
  if (records.length > MAX_FEEDBACK_ROWS) return file(`at most ${MAX_FEEDBACK_ROWS} feedback rows are allowed (found ${records.length})`);
  const index = new Map(header.fields.map((name, i) => [name, i]));
  const errors: RowError[] = [];
  const rows: FeedbackRow[] = [];
  for (const record of records) {
    if (record.fields.length !== FEEDBACK_COLUMNS.length) {
      errors.push({ row: record.line, column: null, message: `expected ${FEEDBACK_COLUMNS.length} columns, found ${record.fields.length}` });
      continue;
    }
    const segment = record.fields[index.get("segment")!];
    const body = record.fields[index.get("text")!].trim();
    let valid = true;
    if (!(SEGMENTS as readonly string[]).includes(segment)) { errors.push({ row: record.line, column: "segment", message: `must be one of ${SEGMENTS.join(", ")}` }); valid = false; }
    if (body.length < 1 || body.length > MAX_FEEDBACK_TEXT) {
      errors.push({ row: record.line, column: "text", message: `must be 1–${MAX_FEEDBACK_TEXT.toLocaleString("en-US")} characters after trimming (found ${body.length})` });
      valid = false;
    } else if (hasControlCharacters(body)) {
      errors.push({ row: record.line, column: "text", message: CONTROL_CHARACTER_MESSAGE });
      valid = false;
    }
    if (valid) rows.push({ segment: segment as SegmentId, text: body });
  }
  return errors.length ? { ok: false, errors: capErrors(errors) } : { ok: true, rows };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/import/feedback-csv.test.ts`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/import/feedback-csv.ts src/import/feedback-csv.test.ts
git commit -m "feat(import): parse feedback CSV"
```

---

### Task 5: Economics form schema

**Files:**
- Create: `src/import/economics.ts`
- Test: `src/import/economics.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { formatRowError } from "./row-error";
import { DEFAULT_ECONOMICS, EconomicsSchema, economicsErrors, SAMPLE_ECONOMICS } from "./economics";

const issues = (value: unknown) => {
  const parsed = EconomicsSchema.safeParse(value);
  if (parsed.success) throw new Error("expected errors");
  return economicsErrors(parsed.error).map(formatRowError);
};

it("prefills Ridgeline's numbers under a neutral name", () => {
  const { params } = buildDemoTwin().twin;
  expect(DEFAULT_ECONOMICS).toEqual({ merchantName: "Your merchant", planName: "Monthly plan", listPrice: params.listPrice, unitCost: params.unitCost, shippingCost: params.shippingCost, paymentFeeRate: params.paymentFeeRate, paymentFeeFixed: params.paymentFeeFixed });
  expect(EconomicsSchema.parse(DEFAULT_ECONOMICS)).toEqual(DEFAULT_ECONOMICS);
  expect(EconomicsSchema.parse(SAMPLE_ECONOMICS)).toEqual(SAMPLE_ECONOMICS);
});
it("enforces the spec's bounds", () => {
  // A field error may or may not also trigger the cross-field check, depending on Zod's refinement order; assert the field message.
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: 0.5 })).toContain("listPrice: must be at least 1 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: 201 })).toContain("listPrice: must be at most 200 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, unitCost: -1 })).toContain("unitCost: must not be negative");
  expect(issues({ ...DEFAULT_ECONOMICS, paymentFeeRate: 0.21 })).toContain("paymentFeeRate: must be at most 0.2");
  expect(issues({ ...DEFAULT_ECONOMICS, paymentFeeFixed: 5.01 })).toContain("paymentFeeFixed: must be at most 5 USD");
  expect(issues({ ...DEFAULT_ECONOMICS, unitCost: 15, shippingCost: 9 })).toEqual(["unitCost: unit cost plus shipping must be below the list price"]);
});
it("rejects empty names, control characters, blank numbers and extra fields", () => {
  expect(issues({ ...DEFAULT_ECONOMICS, merchantName: "  " })).toEqual(["merchantName: is required"]);
  expect(issues({ ...DEFAULT_ECONOMICS, planName: "a\u0007b" })).toEqual(["planName: must not contain control characters"]);
  expect(issues({ ...DEFAULT_ECONOMICS, listPrice: Number.NaN })[0]).toMatch(/^listPrice: /);
  expect(issues({ ...DEFAULT_ECONOMICS, extra: 1 })[0]).toMatch(/extra|Unrecognized/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/economics.test.ts`

Expected: FAIL, because `./economics` does not exist.

- [ ] **Step 3: Implement**

`src/import/economics.ts`:

```ts
import { z } from "zod";
import type { RowError } from "./row-error";

// Merchant-entered unit economics for an imported twin. Labelled as assumptions in provenance.

const label = z.string().trim()
  .min(1, "is required")
  .max(80, "must be at most 80 characters")
  // \p{Cc} (C0 and C1 controls) keeps ESLint's no-control-regex quiet, unlike a \u0000-\u001f range.
  .regex(/^\P{Cc}*$/u, "must not contain control characters");

export const EconomicsSchema = z.strictObject({
  merchantName: label,
  planName: label,
  listPrice: z.number().finite().min(1, "must be at least 1 USD").max(200, "must be at most 200 USD"),
  unitCost: z.number().finite().min(0, "must not be negative"),
  shippingCost: z.number().finite().min(0, "must not be negative"),
  paymentFeeRate: z.number().finite().min(0, "must not be negative").max(0.2, "must be at most 0.2"),
  paymentFeeFixed: z.number().finite().min(0, "must not be negative").max(5, "must be at most 5 USD"),
}).superRefine((e, ctx) => {
  if (e.unitCost + e.shippingCost >= e.listPrice) ctx.addIssue({ code: "custom", path: ["unitCost"], message: "unit cost plus shipping must be below the list price" });
});
export type Economics = z.infer<typeof EconomicsSchema>;

/** Ridgeline's numbers under a neutral name, so an import never looks like the demo merchant. */
export const DEFAULT_ECONOMICS: Economics = { merchantName: "Your merchant", planName: "Monthly plan", listPrice: 24, unitCost: 9.2, shippingCost: 4.1, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

/** The committed sample merchant (fictional). */
export const SAMPLE_ECONOMICS: Economics = { merchantName: "Hollowbrook Treat Box", planName: "Treat Box (monthly)", listPrice: 20, unitCost: 5, shippingCost: 3, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

export function economicsErrors(error: z.ZodError): RowError[] {
  return error.issues.map((issue) => ({ row: null, column: issue.path.map(String).join(".") || null, message: issue.message }));
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/import/economics.test.ts`

Expected: PASS (3 tests). If Zod's wording for `NaN` or the unknown key differs, the regex expectations still hold. Do not loosen the exact bound messages.

- [ ] **Step 5: Commit**

```bash
git add src/import/economics.ts src/import/economics.test.ts
git commit -m "feat(import): add economics form schema"
```

---

### Task 6: Extract the synthetic history generator

**Files:**
- Create: `src/twin/history.ts`
- Create: `src/twin/synthetic-history.ts`
- Modify: `src/merchant/demo.ts` (CRLF): lines 1–102, everything above `const WEAK_RATE_PRIOR` (line 103)
- Test: `src/twin/synthetic-history.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/twin/synthetic-history.test.ts`:

```ts
import { expect, it } from "vitest";
import { DEMO_TRUTH } from "@/merchant/demo";
import { generateSyntheticHistory, type SyntheticHistorySpec } from "./synthetic-history";
import { monthOffset } from "./history";
import { SEGMENTS } from "./types";

const spec: SyntheticHistorySpec = { truth: DEMO_TRUTH, startActive: { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 }, months: 6, seed: 99, asOfMonth: "2026-10" };

it("labels consecutive months ending the month before asOfMonth", () => {
  const { history } = generateSyntheticHistory(spec);
  expect(history.acquisition.map((a) => a.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  expect(history.segments).toHaveLength(6 * SEGMENTS.length);
  expect(monthOffset("2026-01", -1)).toBe("2025-12");
});
it("is reproducible for a seed and differs across seeds", () => {
  expect(generateSyntheticHistory(spec)).toEqual(generateSyntheticHistory(spec));
  expect(generateSyntheticHistory({ ...spec, seed: 100 })).not.toEqual(generateSyntheticHistory(spec));
});
it("conserves subscribers: each month starts where the last ended, with signups entering new", () => {
  const { history, endActive } = generateSyntheticHistory(spec);
  const months = history.acquisition.map((a) => a.month);
  const end = (month: string) => {
    const state = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<(typeof SEGMENTS)[number], number>;
    for (const r of history.segments.filter((x) => x.month === month)) {
      const out = Object.values(r.movedTo).reduce((s, n) => s + (n ?? 0), 0);
      state[r.segment] += r.activeAtStart - r.voluntaryChurn - r.involuntaryChurn - out;
      for (const [to, n] of Object.entries(r.movedTo)) state[to as keyof typeof state] += n ?? 0;
    }
    return state;
  };
  for (let i = 1; i < months.length; i++) {
    const previous = end(months[i - 1]);
    const signups = history.acquisition[i].newSubscribers;
    for (const r of history.segments.filter((x) => x.month === months[i])) {
      expect(r.activeAtStart).toBe(previous[r.segment] + (r.segment === "new" ? signups : 0));
    }
  }
  expect(endActive).toEqual(end(months.at(-1)!));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/twin/synthetic-history.test.ts`

Expected: FAIL, because `./synthetic-history` and `./history` do not exist.

- [ ] **Step 3: Implement the shared history types and the generator**

`src/twin/history.ts`:

```ts
import type { AcquisitionRecord, SegmentMonthRecord } from "./calibrate";
import type { SegmentId } from "./types";

/**
 * One segment-month of subscriber history with the moves out of the segment, by destination.
 * For `new`, `activeAtStart` includes that month's signups (they are exposed to its churn).
 */
export interface HistoryRecord extends SegmentMonthRecord {
  movedTo: Partial<Record<SegmentId, number>>;
}

export interface TwinHistory {
  segments: HistoryRecord[];
  acquisition: AcquisitionRecord[];
}

export function monthOffset(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
```

`src/twin/synthetic-history.ts`. The body is Ridgeline's `generateDemoHistory` with its constants turned into parameters; the random draws are in the same order.

```ts
import type { AcquisitionRecord } from "./calibrate";
import { monthOffset, type HistoryRecord, type TwinHistory } from "./history";
import { Rng } from "./rng";
import { SEGMENTS, type SegmentId } from "./types";

// Synthetic history: generated once from fixed "true" rates with a fixed seed. The twin then
// estimates its parameters from the history exactly as it would from real data.

export interface SyntheticTruth {
  churn: Record<SegmentId, number>;
  involuntary: number;
  newGraduation: number;
  newToPriceSensitive: number;
  coreToAtRisk: number;
  priceSensitiveToAtRisk: number;
  atRiskRecovery: number;
  atRiskToCancelIntent: number;
  cancelIntentToAtRisk: number;
  acquisitionMean: number;
  acquisitionSd: number;
}

export interface SyntheticHistorySpec {
  truth: SyntheticTruth;
  startActive: Record<SegmentId, number>;
  months: number;
  seed: number;
  /** The month after the last generated month. */
  asOfMonth: string;
}

/** Signups join `new` at the start of their month and are exposed to that month's churn. */
export function generateSyntheticHistory(spec: SyntheticHistorySpec): { history: TwinHistory; endActive: Record<SegmentId, number> } {
  const rng = new Rng(spec.seed);
  const t = spec.truth;
  const active = { ...spec.startActive };
  const segments: HistoryRecord[] = [];
  const acquisition: AcquisitionRecord[] = [];

  for (let i = 0; i < spec.months; i++) {
    const month = monthOffset(spec.asOfMonth, i - spec.months);
    const signups = Math.max(0, Math.round(rng.normal(t.acquisitionMean, t.acquisitionSd)));
    acquisition.push({ month, newSubscribers: signups });
    active.new += signups;

    const inflow = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<SegmentId, number>;
    for (const segment of SEGMENTS) {
      const start = active[segment];
      const voluntary = rng.binomial(start, t.churn[segment]);
      const involuntary = rng.binomial(start - voluntary, t.involuntary);
      const remaining = start - voluntary - involuntary;
      const movedTo: Partial<Record<SegmentId, number>> = {};
      if (segment === "new") {
        const graduated = rng.binomial(remaining, t.newGraduation);
        movedTo.price_sensitive = rng.binomial(graduated, t.newToPriceSensitive);
        movedTo.core = graduated - movedTo.price_sensitive;
      } else if (segment === "core") {
        movedTo.at_risk = rng.binomial(remaining, t.coreToAtRisk);
      } else if (segment === "price_sensitive") {
        movedTo.at_risk = rng.binomial(remaining, t.priceSensitiveToAtRisk);
      } else if (segment === "at_risk") {
        movedTo.core = rng.binomial(remaining, t.atRiskRecovery);
        movedTo.cancel_intent = rng.binomial(remaining - movedTo.core, t.atRiskToCancelIntent);
      } else if (segment === "cancel_intent") {
        movedTo.at_risk = rng.binomial(remaining, t.cancelIntentToAtRisk);
      } else {
        const unreachable: never = segment;
        throw new Error(`Unhandled segment: ${unreachable}`);
      }
      let out = 0;
      for (const [to, n] of Object.entries(movedTo) as [SegmentId, number][]) {
        inflow[to] += n;
        out += n;
      }
      segments.push({ month, segment, activeAtStart: start, voluntaryChurn: voluntary, involuntaryChurn: involuntary, movedTo });
      active[segment] = remaining - out;
    }
    for (const segment of SEGMENTS) active[segment] += inflow[segment];
  }
  return { history: { segments, acquisition }, endActive: active };
}
```

- [ ] **Step 4: Make Ridgeline use the generator**

In `src/merchant/demo.ts`, replace everything above `const WEAK_RATE_PRIOR` (lines 1–102) with the following, keeping one blank line before `const WEAK_RATE_PRIOR`. Leave `buildDemoTwin` and the priors unchanged. The old `DemoHistoryRow` interface and `DemoHistory` become aliases of the shared types; their only other user, `src/merchant/index.ts`, needs no change.

```ts
import {
  betaPosterior,
  estimateAcquisition,
  estimateChurn,
  estimatePooledInvoluntary,
} from "@/twin/calibrate";
import type { HistoryRecord, TwinHistory } from "@/twin/history";
import { generateSyntheticHistory, type SyntheticTruth } from "@/twin/synthetic-history";
import type { MerchantTwin, Provenance, SegmentId } from "@/twin/types";

// Ridgeline Roasters: a fictional specialty-coffee subscription used for the demo.
// Its history is SYNTHETIC: generated once from fixed "true" rates with a fixed seed, then the
// twin estimates its parameters from that history exactly as it would from real data.

export type DemoHistoryRow = HistoryRecord;
export type DemoHistory = TwinHistory;

const HISTORY_MONTHS = 18;
const HISTORY_SEED = 4242;
const AS_OF_MONTH = "2026-10";

/** Hidden generating rates. The twin never reads these directly; tests use them to check recovery. */
export const DEMO_TRUTH: SyntheticTruth = {
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16, cancel_intent: 0.35 },
  involuntary: 0.015,
  newGraduation: 0.33,
  newToPriceSensitive: 0.35,
  coreToAtRisk: 0.02,
  priceSensitiveToAtRisk: 0.035,
  atRiskRecovery: 0.12,
  atRiskToCancelIntent: 0.1,
  cancelIntentToAtRisk: 0.2,
  acquisitionMean: 190,
  acquisitionSd: 22,
};

const START_ACTIVE: Record<SegmentId, number> = { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 };

export function generateDemoHistory(): { history: DemoHistory; endActive: Record<SegmentId, number> } {
  return generateSyntheticHistory({ truth: DEMO_TRUTH, startActive: START_ACTIVE, months: HISTORY_MONTHS, seed: HISTORY_SEED, asOfMonth: AS_OF_MONTH });
}
```

Normalize to CRLF (see Conventions).

- [ ] **Step 5: Run the new tests and the golden test**

Run: `npx vitest run src/twin/synthetic-history.test.ts src/merchant/ridgeline-golden.test.ts src/twin/twin.test.ts`

Expected: PASS. The golden test proves the generator reproduces Ridgeline exactly.

- [ ] **Step 6: Commit**

```bash
git add src/twin/history.ts src/twin/synthetic-history.ts src/twin/synthetic-history.test.ts src/merchant/demo.ts
git commit -m "refactor(twin): extract synthetic history generator"
```

---

### Task 7: Shared twin builder

**Files:**
- Create: `src/twin/build-twin.ts`
- Modify: `src/merchant/demo.ts` (CRLF): whole file
- Test: `src/twin/build-twin.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/twin/build-twin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateDemoHistory, RIDGELINE_ECONOMICS, RIDGELINE_PROFILE } from "@/merchant/demo";
import { buildTwinFromHistory, startingActives, type ReasonCounts } from "./build-twin";
import { betaMean } from "./calibrate";

const { history, endActive } = generateDemoHistory();
const input = { history, economics: RIDGELINE_ECONOMICS, profile: RIDGELINE_PROFILE, asOfMonth: "2026-09" };
const zero = { price: 0, other: 0 };
const counts: ReasonCounts = { new: zero, core: { price: 2, other: 6 }, price_sensitive: zero, at_risk: { price: 16, other: 2 }, cancel_intent: zero };

describe("buildTwinFromHistory", () => {
  it("derives starting actives from the last month: start − cancels − moves out + moves in", () => {
    expect(startingActives(history.segments)).toEqual(endActive);
  });
  it("estimates the same parameters whatever the provenance wording", () => {
    const synthetic = buildTwinFromHistory({ ...input, source: "synthetic" });
    const csv = buildTwinFromHistory({ ...input, source: "csv" });
    expect(csv.params).toEqual(synthetic.params);
    expect(csv.initialActive).toEqual(endActive);
  });
  it("labels CSV estimates and keeps assumptions as assumptions", () => {
    const { provenance } = buildTwinFromHistory({ ...input, source: "csv" });
    for (const key of ["monthlyChurn", "involuntaryChurn", "monthlyAcquisition", "transitions"]) {
      expect(provenance[key]).toMatchObject({ source: "estimated", note: expect.stringContaining("estimated from your CSV (18 months)") });
    }
    for (const key of ["churnPriceElasticity", "acquisitionPriceElasticity", "annualUptake", "offerChurnRelativeRisk.price", "offerChurnRelativeRisk.other", "postOfferChurnMultiplier", "unitEconomics", "priceReasonShare"]) {
      expect(provenance[key].source).toBe("assumption");
    }
    expect(provenance.unitEconomics.note).toContain("Merchant-entered assumptions");
  });
  it("turns classified counts into reason-share posteriors and keeps the prior elsewhere", () => {
    const withCounts = buildTwinFromHistory({ ...input, source: "csv", reasonCounts: counts });
    const without = buildTwinFromHistory({ ...input, source: "csv" });
    expect(withCounts.params.segments.at_risk.priceReasonShare).toEqual({ alpha: 17, beta: 3 });
    expect(withCounts.params.segments.core.priceReasonShare).toEqual({ alpha: 3, beta: 7 });
    expect(withCounts.params.segments.cancel_intent.priceReasonShare).toEqual(without.params.segments.cancel_intent.priceReasonShare);
    expect(betaMean(without.params.segments.cancel_intent.priceReasonShare)).toBeCloseTo(0.6);
    expect(withCounts.provenance.priceReasonShare).toMatchObject({ source: "estimated", evidenceCount: 26, note: expect.stringContaining("AI-classified from 26 feedback rows") });
  });
  it("uses the entered list price as the reference price and copies the profile", () => {
    const twin = buildTwinFromHistory({ ...input, economics: { ...RIDGELINE_ECONOMICS, listPrice: 30 }, source: "csv" });
    expect(twin.params).toMatchObject({ listPrice: 30, referencePrice: 30 });
    twin.merchant.name = "changed";
    expect(RIDGELINE_PROFILE.name).toBe("Ridgeline Roasters");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/twin/build-twin.test.ts`

Expected: FAIL, because `./build-twin` does not exist and `RIDGELINE_ECONOMICS` is not exported.

- [ ] **Step 3: Implement the builder**

`src/twin/build-twin.ts` contains the estimation moved verbatim from `buildDemoTwin`. Object keys stay in the same order, because the golden test compares bytes and the UI lists provenance in key order.

```ts
import { betaPosterior, estimateAcquisition, estimateChurn, estimatePooledInvoluntary } from "./calibrate";
import type { HistoryRecord, TwinHistory } from "./history";
import { SEGMENTS, type MerchantProfile, type MerchantTwin, type Provenance, type SegmentId } from "./types";

// Shared estimation: builds a twin from segment-month history, merchant-entered economics and,
// optionally, classified feedback counts. Used by the synthetic demo merchant and by CSV imports.

export interface TwinEconomics {
  listPrice: number;
  unitCost: number;
  shippingCost: number;
  paymentFeeRate: number;
  paymentFeeFixed: number;
}

/** Accepted classifier labels per segment. Counts within each segment, not cancellation rates. */
export type ReasonCounts = Record<SegmentId, { price: number; other: number }>;

export interface BuildTwinInput {
  history: TwinHistory;
  economics: TwinEconomics;
  profile: MerchantProfile;
  asOfMonth: string;
  /** Selects the provenance wording: the demo's synthetic history or a merchant's CSV. */
  source: "synthetic" | "csv";
  reasonCounts?: ReasonCounts;
}

const WEAK_RATE_PRIOR = { alpha: 1, beta: 19 };
const FLAT_PRIOR = { alpha: 1, beta: 1 };
/** Prior share of price-driven leavers per segment, used until customer feedback is classified. */
const PRICE_REASON_PRIOR: Record<SegmentId, number> = { new: 0.3, core: 0.2, price_sensitive: 0.65, at_risk: 0.45, cancel_intent: 0.6 };
const reasonPrior = (segment: SegmentId) => ({ alpha: PRICE_REASON_PRIOR[segment] * 10, beta: (1 - PRICE_REASON_PRIOR[segment]) * 10 });

/** Each segment's state after the last history month: start − cancels − moves out + moves in. */
export function startingActives(rows: HistoryRecord[]): Record<SegmentId, number> {
  const last = rows.reduce((max, r) => (r.month > max ? r.month : max), rows[0]?.month ?? "");
  const active = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<SegmentId, number>;
  for (const r of rows.filter((x) => x.month === last)) {
    const out = Object.values(r.movedTo).reduce((s, n) => s + (n ?? 0), 0);
    active[r.segment] += r.activeAtStart - r.voluntaryChurn - r.involuntaryChurn - out;
    for (const [to, n] of Object.entries(r.movedTo) as [SegmentId, number][]) active[to] += n;
  }
  return active;
}

export function buildTwinFromHistory(input: BuildTwinInput): MerchantTwin {
  const { history, economics, profile, asOfMonth, source, reasonCounts } = input;
  const rows = history.segments;
  const voluntary = estimateChurn(rows, WEAK_RATE_PRIOR, "voluntary");
  const involuntary = estimatePooledInvoluntary(rows, WEAK_RATE_PRIOR);
  const acquisition = estimateAcquisition(history.acquisition);

  const segmentRows = (segment: SegmentId) => rows.filter((x) => x.segment === segment);
  const survivedChurn = (segment: SegmentId) =>
    segmentRows(segment).reduce((s, x) => s + x.activeAtStart - x.voluntaryChurn - x.involuntaryChurn, 0);
  const moved = (from: SegmentId, to: SegmentId) => segmentRows(from).reduce((s, x) => s + (x.movedTo[to] ?? 0), 0);
  const graduated = moved("new", "core") + moved("new", "price_sensitive");
  const recovered = moved("at_risk", "core");

  const months = acquisition.months;
  const csv = source === "csv";
  const fromCsv = `estimated from your CSV (${months} months)`;
  const feedbackRows = reasonCounts ? SEGMENTS.reduce((s, seg) => s + reasonCounts[seg].price + reasonCounts[seg].other, 0) : 0;
  const est = (note: string, evidenceCount: number): Provenance => ({ source: "estimated", note, evidenceCount });
  const assume = (note: string): Provenance => ({ source: "assumption", note });
  const provenance: Record<string, Provenance> = {
    monthlyChurn: est(csv ? `Beta posterior per segment, ${fromCsv}.` : `Beta posterior per segment from ${months} months of synthetic subscriber history.`, rows.reduce((s, r) => s + r.activeAtStart, 0)),
    involuntaryChurn: est(csv ? `Pooled Beta posterior of unrecovered failed payments, ${fromCsv}.` : "Pooled Beta posterior of unrecovered failed payments.", involuntary.exposure),
    monthlyAcquisition: est(csv ? `Mean and spread of monthly signups, ${fromCsv}.` : `Mean and spread of ${months} months of signups.`, months),
    transitions: est(csv ? `Beta posteriors of segment moves, ${fromCsv}.` : "Beta posteriors of observed segment moves.", rows.length),
    churnPriceElasticity: assume(csv ? "Your CSV has no price changes, so price sensitivity is a prior, not an estimate." : "No price changes in history, so price sensitivity is a prior, not an estimate."),
    acquisitionPriceElasticity: assume("Prior on how signups respond to list price."),
    annualUptake: assume(csv ? "Prior on annual-plan uptake when offered, per segment; no annual plan has been tried." : "Prior on annual-plan uptake when offered, per segment. Segments with resolved sandbox offers show their own observed row."),
    "offerChurnRelativeRisk.price": assume("Prior that a retention discount cuts churn to ~45% of normal for price-driven leavers (wide); updated from observed outcomes. The modelled effect does not scale with discount depth: deeper discounts cost more without retaining more."),
    "offerChurnRelativeRisk.other": assume("Prior that a retention discount cuts churn to ~85% of normal for other leavers (sd 0.10, allowing a small chance of no benefit); updated from observed outcomes. The modelled effect does not scale with discount depth: deeper discounts cost more without retaining more."),
    priceReasonShare: feedbackRows > 0
      ? est(`AI-classified from ${feedbackRows} feedback rows: reason counts within each segment, not cancellation rates or causal discount effects. Segments without feedback keep the prior.`, feedbackRows)
      : assume("Prior share of price-driven leavers per segment; replaced by classified customer feedback when available. Sets the initial split and acquisitions; only cancel intent is re-split on entry, so other segments drift."),
    postOfferChurnMultiplier: assume("Prior on extra churn in the month a discount expires."),
    unitEconomics: assume(csv ? "Merchant-entered assumptions from the import form (list price, unit and shipping cost, payment fees); verify them for your account." : "Merchant-entered costs. Payment fee approximates a standard PayPal rate; verify for your account."),
  };
  const priceReasonShare = (segment: SegmentId) => {
    const c = reasonCounts?.[segment];
    return c && c.price + c.other > 0 ? { alpha: 1 + c.price, beta: 1 + c.other } : reasonPrior(segment);
  };

  return {
    merchant: { ...profile },
    asOfMonth,
    initialActive: startingActives(rows),
    params: {
      currency: "USD",
      referencePrice: economics.listPrice,
      listPrice: economics.listPrice,
      unitCost: economics.unitCost,
      shippingCost: economics.shippingCost,
      paymentFeeRate: economics.paymentFeeRate,
      paymentFeeFixed: economics.paymentFeeFixed,
      monthlyAcquisition: { mean: acquisition.mean, sd: acquisition.sd },
      acquisitionPriceElasticity: { mean: 1.2, sd: 0.6 },
      involuntaryChurn: involuntary.posterior,
      transitions: {
        newGraduation: betaPosterior(FLAT_PRIOR, graduated, survivedChurn("new")),
        newToPriceSensitive: betaPosterior(FLAT_PRIOR, moved("new", "price_sensitive"), graduated),
        coreToAtRisk: betaPosterior(FLAT_PRIOR, moved("core", "at_risk"), survivedChurn("core")),
        priceSensitiveToAtRisk: betaPosterior(FLAT_PRIOR, moved("price_sensitive", "at_risk"), survivedChurn("price_sensitive")),
        atRiskRecovery: betaPosterior(FLAT_PRIOR, recovered, survivedChurn("at_risk")),
        atRiskToCancelIntent: betaPosterior(FLAT_PRIOR, moved("at_risk", "cancel_intent"), survivedChurn("at_risk") - recovered),
        cancelIntentToAtRisk: betaPosterior(FLAT_PRIOR, moved("cancel_intent", "at_risk"), survivedChurn("cancel_intent")),
      },
      offerChurnRelativeRisk: { price: { shape: 9, rate: 20 }, other: { shape: 72.25, rate: 85 } },
      postOfferChurnMultiplier: { mean: 1.25, sd: 0.15 },
      segments: {
        new: { label: "New (first 3 months)", monthlyChurn: voluntary.new.posterior, churnPriceElasticity: { mean: 1.5, sd: 0.7 }, annualUptake: { alpha: 2, beta: 38 }, priceReasonShare: priceReasonShare("new") },
        core: { label: "Core", monthlyChurn: voluntary.core.posterior, churnPriceElasticity: { mean: 1.0, sd: 0.5 }, annualUptake: { alpha: 3, beta: 22 }, priceReasonShare: priceReasonShare("core") },
        price_sensitive: { label: "Price sensitive", monthlyChurn: voluntary.price_sensitive.posterior, churnPriceElasticity: { mean: 2.5, sd: 1.0 }, annualUptake: { alpha: 2, beta: 23 }, priceReasonShare: priceReasonShare("price_sensitive") },
        at_risk: { label: "At risk (skipped or paused recently)", monthlyChurn: voluntary.at_risk.posterior, churnPriceElasticity: { mean: 1.8, sd: 0.8 }, annualUptake: { alpha: 1, beta: 39 }, priceReasonShare: priceReasonShare("at_risk") },
        cancel_intent: { label: "Cancel intent (opened cancel flow)", monthlyChurn: voluntary.cancel_intent.posterior, churnPriceElasticity: { mean: 2.0, sd: 0.8 }, annualUptake: { alpha: 1, beta: 49 }, priceReasonShare: priceReasonShare("cancel_intent") },
      },
    },
    provenance,
  };
}
```

Before continuing, diff the moved prior values and provenance strings against the current `buildDemoTwin` (`git show HEAD:src/merchant/demo.ts`). They must match exactly. The `annualUptake` synthetic note is the post-M7 text.

- [ ] **Step 4: Replace `src/merchant/demo.ts` with a thin wrapper**

Whole file:

```ts
import { buildTwinFromHistory, type TwinEconomics } from "@/twin/build-twin";
import type { HistoryRecord, TwinHistory } from "@/twin/history";
import { generateSyntheticHistory, type SyntheticTruth } from "@/twin/synthetic-history";
import type { MerchantProfile, MerchantTwin, SegmentId } from "@/twin/types";

// Ridgeline Roasters: a fictional specialty-coffee subscription used for the demo.
// Its history is SYNTHETIC: generated once from fixed "true" rates with a fixed seed, then the
// twin estimates its parameters from that history exactly as it would from real data
// (the same builder imported CSVs use).

export type DemoHistoryRow = HistoryRecord;
export type DemoHistory = TwinHistory;

const HISTORY_MONTHS = 18;
const HISTORY_SEED = 4242;
const AS_OF_MONTH = "2026-10";

/** Hidden generating rates. The twin never reads these directly; tests use them to check recovery. */
export const DEMO_TRUTH: SyntheticTruth = {
  churn: { new: 0.11, core: 0.028, price_sensitive: 0.062, at_risk: 0.16, cancel_intent: 0.35 },
  involuntary: 0.015,
  newGraduation: 0.33,
  newToPriceSensitive: 0.35,
  coreToAtRisk: 0.02,
  priceSensitiveToAtRisk: 0.035,
  atRiskRecovery: 0.12,
  atRiskToCancelIntent: 0.1,
  cancelIntentToAtRisk: 0.2,
  acquisitionMean: 190,
  acquisitionSd: 22,
};

const START_ACTIVE: Record<SegmentId, number> = { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 };

export const RIDGELINE_PROFILE: MerchantProfile = {
  id: "ridgeline-roasters",
  name: "Ridgeline Roasters",
  description: "Specialty coffee subscription: one 340g bag of single-origin coffee shipped monthly.",
  planName: "Roaster's Choice (monthly)",
};

export const RIDGELINE_ECONOMICS: TwinEconomics = { listPrice: 24, unitCost: 9.2, shippingCost: 4.1, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

export function generateDemoHistory(): { history: DemoHistory; endActive: Record<SegmentId, number> } {
  return generateSyntheticHistory({ truth: DEMO_TRUTH, startActive: START_ACTIVE, months: HISTORY_MONTHS, seed: HISTORY_SEED, asOfMonth: AS_OF_MONTH });
}

export function buildDemoTwin(): { twin: MerchantTwin; history: DemoHistory } {
  const { history } = generateDemoHistory();
  const twin = buildTwinFromHistory({ history, economics: RIDGELINE_ECONOMICS, profile: RIDGELINE_PROFILE, asOfMonth: AS_OF_MONTH, source: "synthetic" });
  return { twin, history };
}
```

Normalize to CRLF.

- [ ] **Step 5: Run the builder, golden and twin tests**

Run: `npx vitest run src/twin/build-twin.test.ts src/merchant/ridgeline-golden.test.ts src/twin/twin.test.ts src/twin/calibrate.test.ts`

Expected: PASS. If the golden test fails, the diff names the changed key or value. Fix the builder until the bytes match; never regenerate the fixture for this refactor.

- [ ] **Step 6: Commit**

```bash
git add src/twin/build-twin.ts src/twin/build-twin.test.ts src/merchant/demo.ts
git commit -m "refactor(twin): share the twin builder between demo and imports"
```

---

### Task 8: Import payload and imported twin

**Files:**
- Create: `src/import/messages.ts`
- Create: `src/import/import-payload.ts`
- Create: `src/import/csv-write.ts`
- Create: `src/import/imported-twin.ts`
- Test: `src/import/import-payload.test.ts`, `src/import/imported-twin.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/import/import-payload.test.ts`:

```ts
import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { historyRowsFromTwin } from "./csv-write";
import { DEFAULT_ECONOMICS } from "./economics";
import { fromTuple, ImportPayloadSchema, toTuple, type HistoryTuple } from "./import-payload";

const rows = historyRowsFromTwin(buildDemoTwin().history);
const payload = { rows: rows.map(toTuple), economics: DEFAULT_ECONOMICS };

it("round-trips rows through compact tuples", () => {
  expect(rows.map(toTuple).map(fromTuple)).toEqual(rows);
  expect(ImportPayloadSchema.parse(payload)).toEqual(payload);
});
it("is strict and bounded", () => {
  const bad = (change: (t: HistoryTuple[]) => unknown[]) => ImportPayloadSchema.safeParse({ ...payload, rows: change(structuredClone(payload.rows)) }).success;
  expect(ImportPayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  expect(bad((t) => { t[0][2] = -1; return t; })).toBe(false);
  expect(bad((t) => { t[0][2] = 1.5; return t; })).toBe(false);
  expect(bad((t) => { t[0][2] = 10_000_001; return t; })).toBe(false);
  expect(bad((t) => t.slice(0, 29))).toBe(false);
  expect(bad((t) => [...t, ...t, ...t, ...t].slice(0, 301))).toBe(false);
  const zero = { price: 0, other: 0 };
  expect(ImportPayloadSchema.safeParse({ ...payload, reasonCounts: { new: { price: 150, other: 51 }, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: zero } }).success).toBe(false);
});
it("keeps the largest legal payload well under the 64 KiB request cap", () => {
  const big: HistoryTuple = ["2026-09", "price_sensitive", 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999, 9_999_999];
  expect(new TextEncoder().encode(JSON.stringify({ rows: Array(300).fill(big), economics: DEFAULT_ECONOMICS })).byteLength).toBeLessThan(40 * 1024);
});
```

`src/import/imported-twin.test.ts`:

```ts
import { expect, it } from "vitest";
import { buildDemoTwin } from "@/merchant/demo";
import { historyCsv, historyRowsFromTwin } from "./csv-write";
import { DEFAULT_ECONOMICS } from "./economics";
import { parseHistoryCsv } from "./history-csv";
import { toTuple } from "./import-payload";
import { buildImportedTwin, IMPORTED_MERCHANT_ID, usesReasonTargeting } from "./imported-twin";
import { formatRowError } from "./row-error";

const demo = buildDemoTwin();
const rows = historyRowsFromTwin(demo.history);
const payload = () => ({ rows: rows.map(toTuple), economics: { ...DEFAULT_ECONOMICS } });
const zero = { price: 0, other: 0 };

it("re-estimates Ridgeline exactly from its own history exported as CSV rows", () => {
  const built = buildImportedTwin(payload());
  if (!built.ok) throw new Error(built.errors.map(formatRowError).join("; "));
  expect(built.twin.params).toEqual(demo.twin.params);
  expect(built.twin.initialActive).toEqual(demo.twin.initialActive);
  expect(built.twin.merchant).toMatchObject({ id: IMPORTED_MERCHANT_ID, name: "Your merchant", planName: "Monthly plan" });
  expect(built).toMatchObject({ months: 18, firstMonth: "2025-04", lastMonth: "2026-09", reasonTargeting: false, feedbackRows: 0 });
  expect(built.twin.asOfMonth).toBe("2026-09");
  expect(built.twin.provenance.monthlyChurn.note).toContain("estimated from your CSV (18 months)");
});
it("does not depend on row order", () => {
  const shuffled = { ...payload(), rows: [...payload().rows].reverse() };
  const a = buildImportedTwin(payload()), b = buildImportedTwin(shuffled);
  expect(a.ok && b.ok && b.twin).toEqual(a.ok && a.twin);
});
it("returns per-row errors and no twin for an invalid history", () => {
  const broken = payload();
  broken.rows[12][3] = 999_999;
  const built = buildImportedTwin(broken);
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
});
it("enables reason targeting only when classified feedback exists", () => {
  const none = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: zero } });
  expect(none.ok && none.reasonTargeting).toBe(false);
  const some = buildImportedTwin({ ...payload(), reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: { price: 4, other: 1 } } });
  expect(some.ok && [some.reasonTargeting, some.feedbackRows, some.twin.params.segments.cancel_intent.priceReasonShare]).toEqual([true, 5, { alpha: 5, beta: 2 }]);
});
it("writes CSV that parses back to the same rows", () => {
  const parsed = parseHistoryCsv(historyCsv(rows));
  expect(parsed.ok && parsed.rows).toEqual(rows);
});
it("recognises price-reason strategies", () => {
  expect(usesReasonTargeting({ id: "a", name: "a", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } })).toBe(true);
  expect(usesReasonTargeting({ id: "b", name: "b", intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 6 } })).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/import-payload.test.ts src/import/imported-twin.test.ts`

Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

`src/import/messages.ts`:

```ts
/** Shown wherever a PayPal action would appear for an imported merchant. */
export const DEMO_ONLY_MESSAGE = "PayPal actions are available for the demo merchant only.";

export const REASON_UNAVAILABLE_MESSAGE = "No feedback was imported, so leaving reasons are unknown and price-reason targeting is unavailable. Target reason \"any\" instead.";
```

`src/import/import-payload.ts`:

```ts
import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import { EconomicsSchema } from "./economics";
import { MAX_FEEDBACK_ROWS } from "./feedback-csv";
import { MAX_COUNT, MAX_HISTORY_ROWS, MIN_HISTORY_MONTHS, type HistoryRow } from "./history-csv";

// What the browser sends with validate, simulate and agent requests. The server re-validates it
// and rebuilds the twin for that request only; nothing is stored.

const count = z.number().int().min(0).max(MAX_COUNT);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** One history row in header order: month, segment, then the eight counts. */
export const HistoryTupleSchema = z.tuple([month, z.enum(SEGMENTS), count, count, count, count, count, count, count, count]);
export type HistoryTuple = z.infer<typeof HistoryTupleSchema>;

const reasonCount = z.number().int().min(0).max(MAX_FEEDBACK_ROWS);
const pair = z.strictObject({ price: reasonCount, other: reasonCount });
export const ReasonCountsSchema = z.strictObject({ new: pair, core: pair, price_sensitive: pair, at_risk: pair, cancel_intent: pair })
  .refine((c) => SEGMENTS.reduce((s, k) => s + c[k].price + c[k].other, 0) <= MAX_FEEDBACK_ROWS, { message: `at most ${MAX_FEEDBACK_ROWS} classified feedback rows` });

export const ImportPayloadSchema = z.strictObject({
  rows: z.array(HistoryTupleSchema).min(MIN_HISTORY_MONTHS * SEGMENTS.length).max(MAX_HISTORY_ROWS),
  economics: EconomicsSchema,
  reasonCounts: ReasonCountsSchema.optional(),
});
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

export function toTuple(r: HistoryRow): HistoryTuple {
  return [r.month, r.segment, r.active_start, r.voluntary_cancels, r.involuntary_cancels, r.moved_to_core, r.moved_to_price_sensitive, r.moved_to_at_risk, r.moved_to_cancel_intent, r.new_signups];
}

export function fromTuple([month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups]: HistoryTuple): HistoryRow {
  return { month, segment, active_start, voluntary_cancels, involuntary_cancels, moved_to_core, moved_to_price_sensitive, moved_to_at_risk, moved_to_cancel_intent, new_signups };
}
```

`src/import/csv-write.ts`:

```ts
import type { TwinHistory } from "@/twin/history";
import { HISTORY_COLUMNS, type HistoryRow } from "./history-csv";

/** Twin history → CSV rows. `active_start` excludes the month's signups (they are listed in `new_signups`). */
export function historyRowsFromTwin(history: TwinHistory): HistoryRow[] {
  const signups = new Map(history.acquisition.map((a) => [a.month, a.newSubscribers]));
  return history.segments.map((r) => {
    const joined = signups.get(r.month) ?? 0;
    return {
      month: r.month,
      segment: r.segment,
      active_start: r.activeAtStart - (r.segment === "new" ? joined : 0),
      voluntary_cancels: r.voluntaryChurn,
      involuntary_cancels: r.involuntaryChurn,
      moved_to_core: r.movedTo.core ?? 0,
      moved_to_price_sensitive: r.movedTo.price_sensitive ?? 0,
      moved_to_at_risk: r.movedTo.at_risk ?? 0,
      moved_to_cancel_intent: r.movedTo.cancel_intent ?? 0,
      new_signups: joined,
    };
  });
}

const field = (value: string | number) => {
  const s = String(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return `${[header.join(","), ...rows.map((r) => r.map(field).join(","))].join("\n")}\n`;
}

export function historyCsv(rows: HistoryRow[]): string {
  return toCsv(HISTORY_COLUMNS, rows.map((r) => HISTORY_COLUMNS.map((c) => r[c])));
}
```

`src/import/imported-twin.ts`:

```ts
import { buildTwinFromHistory } from "@/twin/build-twin";
import type { TwinHistory } from "@/twin/history";
import type { Strategy } from "@/twin/interventions";
import { SEGMENTS, type MerchantTwin } from "@/twin/types";
import { MOVE_COLUMNS, SUPPORTED_MOVES, validateHistoryRows, type HistoryRow } from "./history-csv";
import { fromTuple, type ImportPayload } from "./import-payload";
import { capErrors, type RowError } from "./row-error";

export const IMPORTED_MERCHANT_ID = "imported-csv";

export type ImportedTwin =
  | { ok: true; twin: MerchantTwin; history: TwinHistory; reasonTargeting: boolean; feedbackRows: number; months: number; firstMonth: string; lastMonth: string }
  | { ok: false; errors: RowError[] };

/** CSV rows → the builder's history. A `new` row's exposure includes that month's signups. */
export function toTwinHistory(rows: HistoryRow[]): TwinHistory {
  const order = (r: HistoryRow) => `${r.month}|${SEGMENTS.indexOf(r.segment)}`;
  const sorted = [...rows].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return {
    segments: sorted.map((r) => ({
      month: r.month,
      segment: r.segment,
      activeAtStart: r.active_start + (r.segment === "new" ? r.new_signups : 0),
      voluntaryChurn: r.voluntary_cancels,
      involuntaryChurn: r.involuntary_cancels,
      movedTo: Object.fromEntries(SUPPORTED_MOVES[r.segment].map((to) => [to, r[MOVE_COLUMNS[to]]])),
    })),
    acquisition: [...new Map(sorted.map((r) => [r.month, r.new_signups]))].map(([month, newSubscribers]) => ({ month, newSubscribers })),
  };
}

/** Re-validates a payload and builds the imported twin for one request. Nothing is stored. */
export function buildImportedTwin(payload: ImportPayload): ImportedTwin {
  const rows = payload.rows.map(fromTuple);
  const errors = validateHistoryRows(rows);
  if (errors.length) return { ok: false, errors: capErrors(errors) };
  const history = toTwinHistory(rows);
  const months = history.acquisition.map((a) => a.month);
  const counts = payload.reasonCounts;
  const feedbackRows = counts ? SEGMENTS.reduce((s, seg) => s + counts[seg].price + counts[seg].other, 0) : 0;
  const e = payload.economics;
  const twin = buildTwinFromHistory({
    history,
    economics: { listPrice: e.listPrice, unitCost: e.unitCost, shippingCost: e.shippingCost, paymentFeeRate: e.paymentFeeRate, paymentFeeFixed: e.paymentFeeFixed },
    profile: { id: IMPORTED_MERCHANT_ID, name: e.merchantName, description: "Imported from your CSV for simulation only.", planName: e.planName },
    asOfMonth: months.at(-1)!,
    source: "csv",
    ...(counts && feedbackRows > 0 ? { reasonCounts: counts } : {}),
  });
  return { ok: true, twin, history, reasonTargeting: feedbackRows > 0, feedbackRows, months: months.length, firstMonth: months[0], lastMonth: months.at(-1)! };
}

/** Leaving reasons are only known from classified feedback. */
export const usesReasonTargeting = (strategy: Strategy) =>
  strategy.intervention.kind === "targeted_discount" && strategy.intervention.reason === "price";
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/import/import-payload.test.ts src/import/imported-twin.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/import/messages.ts src/import/import-payload.ts src/import/csv-write.ts src/import/imported-twin.ts src/import/import-payload.test.ts src/import/imported-twin.test.ts
git commit -m "feat(import): add import payload and imported twin"
```

---

### Task 9: Shared merchant summary and price-scaled starters

**Files:**
- Create: `src/merchant/summary.ts`
- Modify: `src/components/Lab.tsx`: imports (lines 9–12) and the `MerchantSummary` interface (lines 29–43)
- Modify: `src/app/page.tsx`
- Modify: `src/merchant/candidates.ts`
- Test: `src/merchant/summary.test.ts`, `src/merchant/candidates.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

`src/merchant/summary.test.ts`:

```ts
import { expect, it } from "vitest";
import { betaMean } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";
import { buildDemoTwin } from "./demo";
import { summarizeMerchant } from "./summary";

it("builds exactly the summary the page built before (Ridgeline)", () => {
  const { twin, history } = buildDemoTwin();
  const lastMonth = history.segments.at(-1)!.month;
  const recent = history.segments.filter((r) => r.month === lastMonth);
  const active = SEGMENTS.reduce((s, seg) => s + twin.initialActive[seg], 0);
  const observed = { observedEvidence: undefined, parameterChanges: [], annualEvidence: undefined };
  expect(summarizeMerchant(twin, history, observed)).toEqual({
    name: twin.merchant.name, description: twin.merchant.description, planName: twin.merchant.planName, asOfMonth: twin.asOfMonth,
    listPrice: twin.params.listPrice, active, mrr: active * twin.params.listPrice,
    lastMonthChurnRate: recent.reduce((s, r) => s + r.voluntaryChurn + r.involuntaryChurn, 0) / recent.reduce((s, r) => s + r.activeAtStart, 0),
    segments: SEGMENTS.map((s) => ({ id: s, label: twin.params.segments[s].label, active: twin.initialActive[s], churn: betaMean(twin.params.segments[s].monthlyChurn) })),
    provenance: twin.provenance, ...observed,
  });
});
it("carries imported details", () => {
  const { twin, history } = buildDemoTwin();
  const imported = { months: 18, firstMonth: "2025-04", lastMonth: "2026-09", feedbackRows: 0 };
  expect(summarizeMerchant(twin, history, { imported }).imported).toEqual(imported);
});
```

In `src/merchant/candidates.test.ts`, change the import to `import { STARTER_STRATEGIES, starterStrategiesFor } from "./candidates";` and append:

```ts
it("scales list-price candidates with the list price and keeps Ridgeline's set exactly", () => {
  expect(starterStrategiesFor(24)).toEqual(STARTER_STRATEGIES);
  expect(starterStrategiesFor(20).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-18", "list-23"]);
  expect(starterStrategiesFor(20).find((s) => s.id === "list-23")?.name).toBe("Raise list price to $23");
  expect(starterStrategiesFor(4).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-5"]);
  expect(starterStrategiesFor(1).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15"]);
  expect(starterStrategiesFor(20, { reasonTargeting: false }).map((s) => s.id)).not.toContain("cancel-price-25-3m");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/merchant/summary.test.ts src/merchant/candidates.test.ts`

Expected: FAIL, because `./summary` and `starterStrategiesFor` do not exist.

- [ ] **Step 3: Implement `src/merchant/summary.ts`**

```ts
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { AnnualEvidence } from "@/merchant/observed-snapshot";
import type { ReasonCounts } from "@/twin/build-twin";
import { betaMean, type ParameterChange } from "@/twin/calibrate";
import type { TwinHistory } from "@/twin/history";
import { SEGMENTS, type MerchantTwin, type Provenance, type SegmentId } from "@/twin/types";

/** Present only for a merchant imported from CSV in this browser tab. */
export interface ImportedDetails {
  months: number;
  firstMonth: string;
  lastMonth: string;
  feedbackRows: number;
  reasonCounts?: ReasonCounts;
}

export interface MerchantSummary {
  name: string;
  description: string;
  planName: string;
  asOfMonth: string;
  listPrice: number;
  active: number;
  mrr: number;
  lastMonthChurnRate: number;
  segments: { id: SegmentId; label: string; active: number; churn: number }[];
  provenance: Record<string, Provenance>;
  observedEvidence?: DiscountEvidence;
  parameterChanges?: ParameterChange[];
  annualEvidence?: AnnualEvidence;
  imported?: ImportedDetails;
}

/** The overview the page (Ridgeline) and the import validation route (imports) both show. */
export function summarizeMerchant(
  twin: MerchantTwin,
  history: TwinHistory,
  extra: Pick<MerchantSummary, "observedEvidence" | "parameterChanges" | "annualEvidence" | "imported"> = {},
): MerchantSummary {
  const lastMonth = history.segments.at(-1)!.month;
  const recent = history.segments.filter((r) => r.month === lastMonth);
  const startActive = recent.reduce((s, r) => s + r.activeAtStart, 0);
  const churned = recent.reduce((s, r) => s + r.voluntaryChurn + r.involuntaryChurn, 0);
  const active = SEGMENTS.reduce((s, seg) => s + twin.initialActive[seg], 0);
  return {
    name: twin.merchant.name,
    description: twin.merchant.description,
    planName: twin.merchant.planName,
    asOfMonth: twin.asOfMonth,
    listPrice: twin.params.listPrice,
    active,
    mrr: active * twin.params.listPrice,
    lastMonthChurnRate: churned / startActive,
    segments: SEGMENTS.map((s) => ({ id: s, label: twin.params.segments[s].label, active: twin.initialActive[s], churn: betaMean(twin.params.segments[s].monthlyChurn) })),
    provenance: twin.provenance,
    ...extra,
  };
}
```

- [ ] **Step 4: Move the interface out of `Lab.tsx` and use the helper in the page**

In `src/components/Lab.tsx`, replace:

```tsx
import { ObservedSnapshotSchema, type AnnualEvidence, type ObservedComparison } from "@/merchant/observed-snapshot";
import type { Provenance, SegmentId } from "@/twin/types";
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { ParameterChange } from "@/twin/calibrate";
```

with:

```tsx
import { ObservedSnapshotSchema, type ObservedComparison } from "@/merchant/observed-snapshot";
import type { MerchantSummary } from "@/merchant/summary";
```

Then replace the whole `export interface MerchantSummary { … }` block (from `export interface MerchantSummary {` to its closing `}`, which includes `annualEvidence?: AnnualEvidence;`) with:

```tsx
export type { MerchantSummary } from "@/merchant/summary";
```

Replace `src/app/page.tsx` with:

```tsx
import { Lab } from "@/components/Lab";
import { observedMerchant } from "@/merchant/observed";
import { connection } from "next/server";
import { Suspense } from "react";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { summarizeMerchant } from "@/merchant/summary";
import { simulationRuns } from "@/hosting/simulation-budget";

export default function Home() {
  return <Suspense fallback={<main className="p-6" aria-busy="true">Loading merchant evidence…</main>}><ObservedHome /></Suspense>;
}

async function ObservedHome() {
  await connection();
  const { twin, history, evidence, changes, annual } = await observedMerchant();
  const summary = summarizeMerchant(twin, history, { observedEvidence: evidence, parameterChanges: changes, annualEvidence: annual });
  return <Lab summary={summary} starterStrategies={STARTER_STRATEGIES} simulationRuns={simulationRuns()} />;
}
```

- [ ] **Step 5: Add `starterStrategiesFor` to `src/merchant/candidates.ts`**

Append:

```ts
const listPriceStrategy = (verb: "Cut" | "Raise", price: number): Strategy => ({
  id: `list-${price}`,
  name: `${verb} list price to $${price}`,
  intervention: { kind: "list_price_change", newPrice: price },
});

/**
 * The starter set for a merchant's list price. List-price candidates scale with it (−1/12 and +1/8,
 * whole dollars, within the $5–$200 guardrail), so Ridgeline's $24 gives exactly STARTER_STRATEGIES.
 * Without classified feedback, price-reason targeting is dropped.
 */
export function starterStrategiesFor(listPrice: number, options: { reasonTargeting?: boolean } = {}): Strategy[] {
  const down = Math.max(5, Math.round((listPrice * 11) / 12));
  const up = Math.min(200, Math.round((listPrice * 9) / 8));
  return STARTER_STRATEGIES.flatMap((s): Strategy[] => {
    const iv = s.intervention;
    if (iv.kind === "targeted_discount" && iv.reason === "price" && options.reasonTargeting === false) return [];
    if (iv.kind !== "list_price_change") return [s];
    // STARTER_STRATEGIES holds one cut ($22) and one rise ($27) from Ridgeline's $24.
    if (iv.newPrice < 24) return down < listPrice ? [listPriceStrategy("Cut", down)] : [];
    return up > listPrice ? [listPriceStrategy("Raise", up)] : [];
  });
}
```

- [ ] **Step 6: Run the focused tests and typecheck**

Run: `npx vitest run src/merchant/summary.test.ts src/merchant/candidates.test.ts src/components/EvidencePanel.test.ts src/components/MerchantOverview.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/merchant/summary.ts src/merchant/summary.test.ts src/merchant/candidates.ts src/merchant/candidates.test.ts src/components/Lab.tsx src/app/page.tsx
git commit -m "refactor(merchant): share merchant summary and price-scaled starters"
```

---

### Task 10: Hollowbrook sample merchant and template

**Files:**
- Create: `src/import/sample-files.ts`
- Create: `src/import/sample-merchant.ts`
- Create: `scripts/generate-sample-merchant.ts`
- Create (generated): `public/samples/aurrery-history-template.csv`, `public/samples/hollowbrook-history.csv`, `public/samples/hollowbrook-feedback.csv`
- Create: `src/test/import-fixture.ts`
- Modify: `package.json` (script `samples:generate`)
- Test: `src/import/sample-merchant.test.ts`, `src/import/sample-headline.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/import/sample-merchant.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { betaMean, betaSd } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";
import { samplePayload } from "@/test/import-fixture";
import { parseFeedbackCsv } from "./feedback-csv";
import { parseHistoryCsv } from "./history-csv";
import { buildImportedTwin } from "./imported-twin";
import { formatRowError } from "./row-error";
import { SAMPLE_FILES } from "./sample-files";
import { SAMPLE_FEEDBACK, SAMPLE_REASON_COUNTS, SAMPLE_TRUTH, sampleMerchantFiles } from "./sample-merchant";

const files = sampleMerchantFiles();

it("commits exactly what the generator produces", () => {
  for (const key of Object.keys(SAMPLE_FILES) as (keyof typeof SAMPLE_FILES)[]) {
    expect(readFileSync(join(process.cwd(), "public", SAMPLE_FILES[key]), "utf8")).toBe(files[key]);
  }
});
it("is a valid 12-month history and a valid 40-row feedback file", () => {
  const history = parseHistoryCsv(files.history);
  expect(history.ok && history.rows.length).toBe(60);
  const feedback = parseFeedbackCsv(files.feedback);
  expect(feedback.ok && feedback.rows.length).toBe(40);
});
it("labels its feedback with the intended counts per segment", () => {
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, { price: 0, other: 0 }]));
  for (const f of SAMPLE_FEEDBACK) counts[f.segment][f.reason]++;
  expect(counts).toEqual(SAMPLE_REASON_COUNTS);
});
it("re-estimates churn close to its generating rates", () => {
  const built = buildImportedTwin(samplePayload());
  if (!built.ok) throw new Error("sample must build");
  for (const s of SEGMENTS) {
    const d = built.twin.params.segments[s].monthlyChurn;
    expect(Math.abs(betaMean(d) - SAMPLE_TRUTH.churn[s])).toBeLessThan(4 * betaSd(d) + 0.002);
  }
});
it("ships a template of the header plus one example month", () => {
  const lines = files.template.trim().split("\n");
  expect(lines).toHaveLength(6);
  const result = parseHistoryCsv(files.template);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.map(formatRowError)).toEqual(["month: at least 6 consecutive months are required (found 1)"]);
});
```

`src/import/sample-headline.test.ts`:

```ts
import { expect, it } from "vitest";
import { chooseHeadline } from "@/components/headline";
import { HOSTED_SIMULATION_RUNS } from "@/hosting/simulation-budget";
import { STARTER_STRATEGIES, starterStrategiesFor } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { samplePayload } from "@/test/import-fixture";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies } from "@/twin/simulate";
import { buildImportedTwin } from "./imported-twin";

it("gives the sample merchant a different headline from Ridgeline, explained by its estimates", () => {
  const options = { runs: HOSTED_SIMULATION_RUNS };
  const ridgeline = buildDemoTwin().twin;
  const built = buildImportedTwin(samplePayload());
  if (!built.ok) throw new Error("sample must build");
  const demoHeadline = chooseHeadline(compareStrategies(ridgeline, STARTER_STRATEGIES, options));
  const sampleHeadline = chooseHeadline(compareStrategies(built.twin, starterStrategiesFor(built.twin.params.listPrice), options));
  expect(demoHeadline).toMatchObject({ selectedId: "annual-15", recommended: true });
  expect(sampleHeadline).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true });
  // Why: Hollowbrook's at-risk subscribers churn several times faster than Ridgeline's and mostly cite price.
  expect(betaMean(built.twin.params.segments.at_risk.monthlyChurn)).toBeGreaterThan(0.4);
  expect(betaMean(ridgeline.params.segments.at_risk.monthlyChurn)).toBeLessThan(0.2);
  expect(betaMean(built.twin.params.segments.at_risk.priceReasonShare)).toBeGreaterThan(0.8);
}, 120_000);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/import/sample-merchant.test.ts src/import/sample-headline.test.ts`

Expected: FAIL, because the sample modules and fixture do not exist.

- [ ] **Step 3: Implement the sample**

`src/import/sample-files.ts`:

```ts
/** Public paths (under /public) of the downloadable import files. */
export const SAMPLE_FILES = {
  template: "samples/aurrery-history-template.csv",
  history: "samples/hollowbrook-history.csv",
  feedback: "samples/hollowbrook-feedback.csv",
} as const;
```

`src/import/sample-merchant.ts`:

```ts
import { generateSyntheticHistory, type SyntheticTruth } from "@/twin/synthetic-history";
import type { ReasonCounts } from "@/twin/build-twin";
import type { ReasonId, SegmentId } from "@/twin/types";
import { historyCsv, historyRowsFromTwin, toCsv } from "./csv-write";
import { FEEDBACK_COLUMNS } from "./feedback-csv";
import type { HistoryRow } from "./history-csv";
import type { SAMPLE_FILES } from "./sample-files";

// Hollowbrook Treat Box: a fictional $20/month dog-treat box, the sample "second merchant".
// SYNTHETIC, like Ridgeline: generated once from these fixed rates and seed. Its at-risk
// subscribers churn fast but often recover, and they mostly cite price, so a broad at-risk
// discount is the move here: the opposite of Ridgeline's lesson.

export const SAMPLE_TRUTH: SyntheticTruth = {
  churn: { new: 0.12, core: 0.012, price_sensitive: 0.04, at_risk: 0.6, cancel_intent: 0.4 },
  involuntary: 0.004,
  newGraduation: 0.4,
  newToPriceSensitive: 0.5,
  coreToAtRisk: 0.03,
  priceSensitiveToAtRisk: 0.05,
  atRiskRecovery: 0.5,
  atRiskToCancelIntent: 0.12,
  cancelIntentToAtRisk: 0.1,
  acquisitionMean: 40,
  acquisitionSd: 8,
};
const SAMPLE_START: Record<SegmentId, number> = { new: 70, core: 150, price_sensitive: 140, at_risk: 40, cancel_intent: 10 };
const SAMPLE_MONTHS = 12;
const SAMPLE_SEED = 7311;
const SAMPLE_AS_OF = "2026-10";

const PRICE = [
  "The box is too expensive for us now. Twenty dollars a month adds up.",
  "Money is tight this month, so the treat box is the first thing to go.",
  "I love the treats but I can't justify the price anymore.",
  "Found similar treats at the pet store for half the cost.",
  "Please lower the price or I'll have to cancel.",
  "We're cutting back on subscriptions to save money.",
  "It was good value at first, but lately it feels overpriced.",
  "Once I added up a year of boxes, it felt far too expensive.",
  "My budget changed after a job loss, so I need something cheaper.",
  "A discount would keep me around; otherwise it's too pricey.",
  "The treats are great. The cost is the problem.",
  "Paying for this every month is hard on a pension.",
  "Too much money for a handful of biscuits.",
  "I'm skipping boxes because I can't afford them right now.",
  "Cheaper options exist and my dog doesn't notice the difference.",
  "If it were fifteen dollars I'd stay without thinking.",
  "Rent went up, so small luxuries like this have to go.",
  "I'd keep it if there were a smaller, cheaper box.",
  "Honestly, it's just not worth twenty dollars to me.",
  "We need to trim expenses and this is an easy cut.",
  "The value isn't there for the price.",
  "I paused because money is tight, and I may cancel.",
  "Love it, but I'm switching to a budget brand to save money.",
  "Cost is the only reason I'm leaving.",
];
const OTHER = [
  "My dog developed a chicken allergy and most of the treats contain chicken.",
  "We're moving overseas and you don't ship there.",
  "The last two boxes arrived crushed.",
  "Our dog passed away last month. Thank you for the treats.",
  "My vet put her on a strict diet, so no more treats for now.",
  "Deliveries keep arriving late and sit outside in the rain.",
  "He just doesn't like the flavours lately.",
  "We already have too many treats piling up in the cupboard.",
  "The box is lovely, but my puppy is teething and can't chew these.",
  "Boxes keep going to my old flat after I moved.",
  "Too much packaging for my taste; I'm trying to reduce waste.",
  "My sister gives us treats from her shop now.",
  "The treats are too hard for my senior dog's teeth.",
  "Support never answered my email about a missing box.",
  "We're travelling for three months and won't need deliveries.",
  "I prefer to pick treats in person with my dog.",
];
/** How many price- and other-reason rows each segment gets, in order from PRICE and OTHER. */
export const SAMPLE_REASON_COUNTS: ReasonCounts = {
  new: { price: 1, other: 4 },
  core: { price: 1, other: 4 },
  price_sensitive: { price: 5, other: 1 },
  at_risk: { price: 16, other: 2 },
  cancel_intent: { price: 1, other: 5 },
};

/** Intended labels are for tests only; the CSV carries only segment and text. */
export const SAMPLE_FEEDBACK: { segment: SegmentId; text: string; reason: ReasonId }[] = (() => {
  let p = 0, o = 0;
  return (Object.keys(SAMPLE_REASON_COUNTS) as SegmentId[]).flatMap((segment) => [
    ...Array.from({ length: SAMPLE_REASON_COUNTS[segment].price }, () => ({ segment, text: PRICE[p++], reason: "price" as const })),
    ...Array.from({ length: SAMPLE_REASON_COUNTS[segment].other }, () => ({ segment, text: OTHER[o++], reason: "other" as const })),
  ]);
})();

/** Header plus one example month that satisfies every rule. */
const TEMPLATE_ROWS: HistoryRow[] = [
  { month: "2026-09", segment: "new", active_start: 120, voluntary_cancels: 14, involuntary_cancels: 2, moved_to_core: 25, moved_to_price_sensitive: 20, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "core", active_start: 900, voluntary_cancels: 25, involuntary_cancels: 9, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 30, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "price_sensitive", active_start: 400, voluntary_cancels: 24, involuntary_cancels: 4, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 18, moved_to_cancel_intent: 0, new_signups: 60 },
  { month: "2026-09", segment: "at_risk", active_start: 150, voluntary_cancels: 30, involuntary_cancels: 2, moved_to_core: 20, moved_to_price_sensitive: 0, moved_to_at_risk: 0, moved_to_cancel_intent: 15, new_signups: 60 },
  { month: "2026-09", segment: "cancel_intent", active_start: 40, voluntary_cancels: 14, involuntary_cancels: 1, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 8, moved_to_cancel_intent: 0, new_signups: 60 },
];

export function sampleHistory() {
  return generateSyntheticHistory({ truth: SAMPLE_TRUTH, startActive: SAMPLE_START, months: SAMPLE_MONTHS, seed: SAMPLE_SEED, asOfMonth: SAMPLE_AS_OF }).history;
}

export function sampleMerchantFiles(): Record<keyof typeof SAMPLE_FILES, string> {
  return {
    template: historyCsv(TEMPLATE_ROWS),
    history: historyCsv(historyRowsFromTwin(sampleHistory())),
    feedback: toCsv(FEEDBACK_COLUMNS, SAMPLE_FEEDBACK.map((f) => [f.segment, f.text])),
  };
}
```

`src/test/import-fixture.ts`:

```ts
import { SAMPLE_ECONOMICS } from "@/import/economics";
import { parseHistoryCsv } from "@/import/history-csv";
import { toTuple, type ImportPayload } from "@/import/import-payload";
import { SAMPLE_REASON_COUNTS, sampleMerchantFiles } from "@/import/sample-merchant";

/** The committed sample merchant as the browser would send it, with or without classified feedback. */
export function samplePayload(options: { feedback?: boolean } = {}): ImportPayload {
  const parsed = parseHistoryCsv(sampleMerchantFiles().history);
  if (!parsed.ok) throw new Error("The sample history must parse.");
  return {
    rows: parsed.rows.map(toTuple),
    economics: { ...SAMPLE_ECONOMICS },
    ...(options.feedback === false ? {} : { reasonCounts: structuredClone(SAMPLE_REASON_COUNTS) }),
  };
}
```

`scripts/generate-sample-merchant.ts`:

```ts
// Writes the committed import template and sample merchant CSVs. Deterministic: rerunning must not
// change them (src/import/sample-merchant.test.ts compares the committed files with the generator).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAMPLE_FILES } from "../src/import/sample-files";
import { sampleMerchantFiles } from "../src/import/sample-merchant";

const files = sampleMerchantFiles();
for (const key of Object.keys(SAMPLE_FILES) as (keyof typeof SAMPLE_FILES)[]) {
  const path = join(process.cwd(), "public", SAMPLE_FILES[key]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, files[key]);
}
console.log(`Wrote ${Object.keys(files).length} sample files.`);
```

In `package.json`, `"paypal:annual-check"` is the last entry of `"scripts"` and has no trailing comma. Add a comma after it and this entry below it:

```json
    "samples:generate": "tsx scripts/generate-sample-merchant.ts"
```

The file must stay valid JSON (`node -e "require('./package.json')"` prints nothing). `tsx` resolves the `@/` paths through `tsconfig.json`, as `scripts/inspect-twin.ts` already relies on.

- [ ] **Step 4: Generate the files and run the tests**

```bash
npm run samples:generate
npx vitest run src/import/sample-merchant.test.ts src/import/sample-headline.test.ts
npm run samples:generate && git status --short public/samples
```

Expected:
- the generator prints `Wrote 3 sample files.`;
- both tests PASS;
- the second generation leaves `git status` showing the three files as new but unchanged in content (rerunning is deterministic).

If the headline test picks a different strategy, stop and report the comparison numbers. Do not tune rates silently: decision 13 records the measured expectation (at 400 futures, at-risk +$3,477 and $886 discount cost against annual +$2,765).

- [ ] **Step 5: Commit**

```bash
git add src/import/sample-files.ts src/import/sample-merchant.ts src/import/sample-merchant.test.ts src/import/sample-headline.test.ts src/test/import-fixture.ts scripts/generate-sample-merchant.ts public/samples package.json
git commit -m "feat(import): add Hollowbrook sample merchant and template"
```

---

### Task 11: Bounded JSON option and `POST /api/import/validate`

**Files:**
- Modify: `src/app/api/_lib/http.ts`
- Modify: `src/import/import-payload.ts`
- Create: `src/app/api/import/validate/route.ts`
- Test: `src/app/api/_lib/http.test.ts` (extend), `src/import/import-payload.test.ts` (extend), `src/app/api/import/validate/route.test.ts`, `src/hosting/routes.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

In `src/app/api/_lib/http.test.ts`, change the import to `import { errorResponse, invalidImportResponse, readBoundedJson } from "./http";` and append:

```ts
it("reads up to a caller-chosen size and rejects anything larger", async () => {
  const post = (value: string) => new Request("http://localhost/api", { method: "POST", body: value });
  const body = JSON.stringify({ text: "x".repeat(70_000) });
  await expect(readBoundedJson(post(body))).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  expect(await readBoundedJson(post(body), { maxBytes: 128 * 1024 })).toEqual({ text: "x".repeat(70_000) });
  await expect(readBoundedJson(post("[1,2,3]"), { maxBytes: 4 })).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
});

it("returns capped per-row import errors", async () => {
  const errors = Array.from({ length: 60 }, (_, i) => ({ row: i + 2, column: "month", message: "must be YYYY-MM" }));
  const response = invalidImportResponse(errors);
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: "INVALID_IMPORT", message: "The import has errors. Nothing was changed." });
  expect(body.errors).toHaveLength(51);
});
```

In `src/import/import-payload.test.ts`, change the last import to `import { fromTuple, ImportPayloadSchema, payloadIssues, toTuple, type HistoryTuple } from "./import-payload";` and append:

```ts
it("maps schema issues to CSV rows and columns", () => {
  const rows = structuredClone(payload.rows);
  rows[12][3] = -1;
  const parsed = ImportPayloadSchema.safeParse({ ...payload, rows, economics: { ...DEFAULT_ECONOMICS, merchantName: "" } });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(payloadIssues(parsed.error).map(({ row, column }) => ({ row, column }))).toEqual([
    { row: 14, column: "voluntary_cancels" },
    { row: null, column: "economics.merchantName" },
  ]);
});
```

`src/app/api/import/validate/route.test.ts`:

```ts
import { expect, it } from "vitest";
import { formatRowError } from "@/import/row-error";
import { samplePayload } from "@/test/import-fixture";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/import/validate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

it("re-validates an import and summarizes the twin it builds", async () => {
  const response = await post(samplePayload());
  expect(response.status).toBe(200);
  const { summary, reasonTargeting } = await response.json();
  expect(reasonTargeting).toBe(true);
  expect(summary).toMatchObject({
    name: "Hollowbrook Treat Box", planName: "Treat Box (monthly)", listPrice: 20, asOfMonth: "2026-09",
    imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 40 },
  });
  expect(summary.segments).toHaveLength(5);
  expect(summary.imported.reasonCounts.at_risk).toEqual({ price: 16, other: 2 });
  expect(summary.provenance.monthlyChurn.note).toContain("estimated from your CSV (12 months)");
  expect(summary).not.toHaveProperty("observedEvidence");
  expect(summary).not.toHaveProperty("annualEvidence");
});

it("reports a history without feedback as having no reason targeting", async () => {
  const response = await post(samplePayload({ feedback: false }));
  expect(response.status).toBe(200);
  const { summary, reasonTargeting } = await response.json();
  expect(reasonTargeting).toBe(false);
  expect(summary.imported).toEqual({ months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 0 });
});

it("returns per-row errors for invalid rows and schema-breaking payloads", async () => {
  const broken = samplePayload();
  broken.rows[12][3] = 999_999;
  const invalid = await post(broken);
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  const negative = samplePayload();
  negative.rows[0][2] = -1;
  const schema = await post(negative);
  expect(schema.status).toBe(400);
  expect((await schema.json()).errors[0]).toMatchObject({ row: 2, column: "active_start" });
  expect((await post({ ...samplePayload(), extra: true })).status).toBe(400);
});

it("rejects oversized and malformed bodies before parsing the import", async () => {
  expect((await post(JSON.stringify({ ...samplePayload(), padding: "x".repeat(70_000) }))).status).toBe(413);
  expect((await post("{")).status).toBe(400);
});
```

In `src/hosting/routes.test.ts`, add `import { POST as validateImport } from "@/app/api/import/validate/route";` after the `poll` import. Inside "requires configured origin for every public mutation before parsing", add:

```ts
    expect((await validateImport(request("/api/import/validate"))).status).toBe(403);
```

Append this test at the end of the `describe` block:

```ts
  it("admits import validation under the preparation limit", async () => {
    const store = createHostingStore(createLocalConnection(ledger()), "s".repeat(48));
    for (let i = 0; i < 30; i++) await store.admit("preparation", "unverified-proxy-client");
    const response = await validateImport(request("/api/import/validate", origin));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });
```

No earlier test in that file is admitted under `preparation` (they all stop at the origin or admin check), so the bucket starts empty.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/api/_lib/http.test.ts src/import/import-payload.test.ts src/app/api/import/validate/route.test.ts src/hosting/routes.test.ts`

Expected: FAIL: `invalidImportResponse`, `payloadIssues` and the validate route do not exist.

- [ ] **Step 3: Add the size option and the import error response to `src/app/api/_lib/http.ts`**

Add after the existing imports:

```ts
import { capErrors, type RowError } from "@/import/row-error";
```

Replace the head of `readBoundedJson`:

```ts
/** Read at most the admitted bytes, including when Content-Length is absent or false. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new RequestBodyError("BODY_TOO_LARGE");
```

with:

```ts
/** Read at most `maxBytes` (default 64 KiB), including when Content-Length is absent or false. */
export async function readBoundedJson(request: Request, options: { maxBytes?: number } = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyError("BODY_TOO_LARGE");
```

and, inside the read loop, replace `if (size > MAX_JSON_BYTES) throw new RequestBodyError("BODY_TOO_LARGE");` with `if (size > maxBytes) throw new RequestBodyError("BODY_TOO_LARGE");`.

Append at the end of the file:

```ts
/** Per-row import errors (M6). Nothing was stored, so the browser's current twin stays as it was. */
export function invalidImportResponse(errors: RowError[]): Response {
  return Response.json({ error: "INVALID_IMPORT", message: "The import has errors. Nothing was changed.", errors: capErrors(errors) }, { status: 400 });
}
```

- [ ] **Step 4: Add `payloadIssues` to `src/import/import-payload.ts`**

Change `import { MAX_COUNT, MAX_HISTORY_ROWS, MIN_HISTORY_MONTHS, type HistoryRow } from "./history-csv";` to:

```ts
import { HISTORY_COLUMNS, MAX_COUNT, MAX_HISTORY_ROWS, MIN_HISTORY_MONTHS, type HistoryRow } from "./history-csv";
import { capErrors, type RowError } from "./row-error";
```

Append:

```ts
/** Schema issues as row errors: `rows[i][j]` is CSV row i + 2 and column j; other paths are named as dotted paths. */
export function payloadIssues(error: z.ZodError): RowError[] {
  return capErrors(error.issues.map((issue): RowError => {
    const [head, index, field] = issue.path;
    if (head === "rows" && typeof index === "number") {
      const column = typeof field === "number" ? HISTORY_COLUMNS[field] ?? null : typeof field === "string" ? field : null;
      return { row: index + 2, column, message: issue.message };
    }
    return { row: null, column: issue.path.map(String).join(".") || null, message: issue.message };
  }));
}
```

- [ ] **Step 5: Create `src/app/api/import/validate/route.ts`**

```ts
import { ImportPayloadSchema, payloadIssues } from "@/import/import-payload";
import { buildImportedTwin } from "@/import/imported-twin";
import { summarizeMerchant } from "@/merchant/summary";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, invalidImportResponse, readBoundedJson } from "../../_lib/http";

/**
 * Re-validates an import (history, economics and classified counts) and summarizes the twin it builds.
 * Stateless: nothing about the upload is stored, logged or exported. POST handlers are never cached.
 */
export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const parsed = ImportPayloadSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) return invalidImportResponse(payloadIssues(parsed.error));
    const built = buildImportedTwin(parsed.data);
    if (!built.ok) return invalidImportResponse(built.errors);
    const counts = built.reasonTargeting ? parsed.data.reasonCounts : undefined;
    const summary = summarizeMerchant(built.twin, built.history, {
      imported: { months: built.months, firstMonth: built.firstMonth, lastMonth: built.lastMonth, feedbackRows: built.feedbackRows, ...(counts ? { reasonCounts: counts } : {}) },
    });
    return Response.json({ summary, reasonTargeting: built.reasonTargeting });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/app/api/_lib/http.test.ts src/import/import-payload.test.ts src/app/api/import/validate/route.test.ts src/hosting/routes.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/_lib/http.ts src/app/api/_lib/http.test.ts src/import/import-payload.ts src/import/import-payload.test.ts src/app/api/import/validate src/hosting/routes.test.ts
git commit -m "feat(api): validate and summarize CSV imports"
```

---

### Task 12: Imported simulation, no observed evidence, no proposals

**Files:**
- Modify: `src/app/api/_lib/http.ts`
- Modify: `src/app/api/simulate/route.ts` (whole file)
- Modify: `src/app/api/proposals/route.ts` (the `POST` body parse)
- Test: `src/app/api/simulate/route.test.ts` (extend), `src/app/api/proposals/route.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

In `src/app/api/simulate/route.test.ts`, add these imports below the existing ones:

```ts
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildImportedTwin } from "@/import/imported-twin";
import { formatRowError } from "@/import/row-error";
import { samplePayload } from "@/test/import-fixture";
```

and, below the imports, spies on both observed-evidence readers that `observedMerchant()` uses:

```ts
// Imported merchants must never read Ridgeline's observed ledger evidence: discount outcomes or annual offers.
const reads = vi.hoisted(() => ({ discount: 0, annual: 0 }));
vi.mock("@/ledger/discount-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/discount-outcomes")>();
  return { ...actual, readDiscountOutcomes: vi.fn(async (...args: Parameters<typeof actual.readDiscountOutcomes>) => { reads.discount++; return actual.readDiscountOutcomes(...args); }) };
});
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return { ...actual, readAnnualOfferEvidence: vi.fn(async (...args: Parameters<typeof actual.readAnnualOfferEvidence>) => { reads.annual++; return actual.readAnnualOfferEvidence(...args); }) };
});
```

Append:

```ts
describe("imported merchant simulation", () => {
  const options = { runs: 100, horizonMonths: 2, seed: 42 };
  const post = (value: unknown) => POST(request(JSON.stringify(value)));
  const reset = () => { reads.discount = 0; reads.annual = 0; };

  it("rebuilds the imported twin per request and never reads Ridgeline's observed evidence", async () => {
    reset();
    expect((await post(body)).status).toBe(200);
    expect(reads).toEqual({ discount: 1, annual: 1 }); // control: Ridgeline reads both
    reset();
    const strategies = [STARTER_STRATEGIES[0], STARTER_STRATEGIES[2]];
    const response = await post({ strategies, options, import: samplePayload() });
    expect(response.status).toBe(200);
    const { imported, observedSnapshot, ...comparison } = await response.json();
    expect(imported).toBe(true);
    expect(observedSnapshot).toBeUndefined();
    const built = buildImportedTwin(samplePayload());
    if (!built.ok) throw new Error("The sample must build.");
    expect(comparison).toEqual(compareStrategies(built.twin, strategies, options));
    expect(comparison.merchantId).toBe("imported-csv");
    expect(reads).toEqual({ discount: 0, annual: 0 });
  });

  it("returns per-row errors and refuses price-reason targeting without feedback", async () => {
    const broken = samplePayload();
    broken.rows[12][3] = 999_999;
    const invalid = await post({ strategies: [STARTER_STRATEGIES[0]], options, import: broken });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
    const noFeedback = await post({ strategies: [STARTER_STRATEGIES[1]], options, import: samplePayload({ feedback: false }) });
    expect(noFeedback.status).toBe(422);
    expect(await noFeedback.json()).toMatchObject({ error: "REASON_UNAVAILABLE" });
  });

  it("rejects an import that breaks the schema", async () => {
    expect((await post({ strategies: [STARTER_STRATEGIES[0]], options, import: { ...samplePayload(), extra: true } })).status).toBe(400);
  });
});
```

In `src/app/api/proposals/route.test.ts`, add `import { STARTER_STRATEGIES } from "@/merchant/candidates";` and `import { samplePayload } from "@/test/import-fixture";`, then append:

```ts
describe("imported merchants", () => {
  it("never turn an import into a proposal or an annual offer", async () => {
    ledger().exec("DELETE FROM proposals;");
    for (const candidate of [STARTER_STRATEGIES[0], STARTER_STRATEGIES[2]]) {
      const response = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy: candidate, import: samplePayload() }) }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "DEMO_ONLY", message: "PayPal actions are available for the demo merchant only." });
    }
    expect(await listProposals()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/api/simulate/route.test.ts src/app/api/proposals/route.test.ts`

Expected: FAIL: the simulate route ignores `import` (it returns Ridgeline's comparison, reads evidence and has an `observedSnapshot`), and the proposals route creates or refuses for other reasons.

- [ ] **Step 3: Add the two refusal responses to `src/app/api/_lib/http.ts`**

Add `import { DEMO_ONLY_MESSAGE, REASON_UNAVAILABLE_MESSAGE } from "@/import/messages";` to the imports and append:

```ts
/** A price-reason strategy for an import without classified feedback (decision 8). */
export function reasonUnavailableResponse(): Response {
  return Response.json({ error: "REASON_UNAVAILABLE", message: REASON_UNAVAILABLE_MESSAGE }, { status: 422 });
}

/** Any PayPal-bound request that carries an import (decision 19). */
export function demoOnlyResponse(): Response {
  return Response.json({ error: "DEMO_ONLY", message: DEMO_ONLY_MESSAGE }, { status: 422 });
}
```

- [ ] **Step 4: Replace `src/app/api/simulate/route.ts`**

```ts
import { z } from "zod";
import { observedMerchant } from "@/merchant/observed";
import { toObservedSnapshot } from "@/merchant/observed-snapshot";
import { ImportPayloadSchema } from "@/import/import-payload";
import { buildImportedTwin, usesReasonTargeting } from "@/import/imported-twin";
import { StrategySchema } from "@/twin/interventions";
import { runComparison } from "@/twin/worker-client";
import { errorResponse, invalidImportResponse, readBoundedJson, reasonUnavailableResponse } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";
import { cappedSimulationRuns } from "@/hosting/simulation-budget";

const BodySchema = z.object({
  strategies: z.array(StrategySchema).min(1).max(8),
  options: z
    .object({
      runs: z.number().int().min(100).max(5000).optional(),
      horizonMonths: z.number().int().min(1).max(36).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  /** An imported merchant (M6): the twin is rebuilt from this payload for this request only. */
  import: ImportPayloadSchema.optional(),
});

export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const body = BodySchema.parse(await readBoundedJson(request));
    const options = { ...body.options, runs: cappedSimulationRuns(body.options?.runs) };
    if (body.import) {
      // Simulate only: never reads Ridgeline's observed ledger evidence (discount outcomes or annual offers).
      const built = buildImportedTwin(body.import);
      if (!built.ok) return invalidImportResponse(built.errors);
      if (!built.reasonTargeting && body.strategies.some(usesReasonTargeting)) return reasonUnavailableResponse();
      const comparison = await runComparison(built.twin, body.strategies, options, { signal: request.signal });
      return Response.json({ ...comparison, imported: true });
    }
    const merchant = await observedMerchant();
    const observedSnapshot = toObservedSnapshot(merchant);
    const comparison = await runComparison(merchant.twin, body.strategies, options, { signal: request.signal });
    return Response.json({ ...comparison, observedSnapshot });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 5: Refuse imports in `src/app/api/proposals/route.ts`**

Change the `errorResponse, readBoundedJson` import to `import { demoOnlyResponse, errorResponse, readBoundedJson } from "../_lib/http";`. In `POST`, replace:

```ts
    const body = BodySchema.parse(await readBoundedJson(request));
```

with:

```ts
    const raw = await readBoundedJson(request);
    // Imported merchants are simulate only (M6): an import never becomes a proposal or an annual offer.
    if (typeof raw === "object" && raw !== null && "import" in raw) return demoOnlyResponse();
    const body = BodySchema.parse(raw);
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/app/api/simulate/route.test.ts src/app/api/proposals/route.test.ts src/hosting/routes.test.ts`

Expected: PASS, including every existing test in those files.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/_lib/http.ts src/app/api/simulate/route.ts src/app/api/simulate/route.test.ts src/app/api/proposals/route.ts src/app/api/proposals/route.test.ts
git commit -m "feat(api): simulate imported merchants without observed evidence"
```

---

### Task 13: Imported feedback classification core

**Files:**
- Create: `src/signals/memory-cache.ts`
- Create: `src/signals/import-classify.ts`
- Create: `src/agent/budgeted-classifier.ts`
- Modify: `src/agent/run.ts`: imports (lines 7 and 9) and the classifier block (lines 82–91)
- Test: `src/signals/memory-cache.test.ts`, `src/signals/import-classify.test.ts`, `src/agent/budgeted-classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/signals/memory-cache.test.ts`:

```ts
import { expect, it } from "vitest";
import { createMemoryPredictionCache } from "./memory-cache";

const context = { provider: "groq" as const, model: "test-model" };
const input = (id: string, text: string) => ({ id, text, source: "cancel_flow" as const, segment: "at_risk" as const });

it("returns the label for the same input and misses for other text or another model", () => {
  const cache = createMemoryPredictionCache(2);
  cache.set(input("f1", "Too expensive"), context, { id: "f1", intent: "cancel", reason: "price", confidence: 0.9 });
  expect(cache.get(input("f1", "Too expensive"), context)).toEqual({ id: "f1", intent: "cancel", reason: "price", confidence: 0.9 });
  expect(cache.get(input("f1", "Moving abroad"), context)).toBeUndefined();
  expect(cache.get(input("f1", "Too expensive"), { ...context, model: "other-model" })).toBeUndefined();
});

it("stores hashed keys and labels only, and drops the oldest entry beyond its limit", () => {
  const cache = createMemoryPredictionCache(2);
  for (const [i, text] of ["alpha secret", "beta secret", "gamma secret"].entries()) {
    cache.set(input(`f${i}`, text), context, { id: `f${i}`, intent: "stay", reason: "other", confidence: 0.8 });
  }
  expect(cache.size).toBe(2);
  expect(cache.get(input("f0", "alpha secret"), context)).toBeUndefined();
  expect(JSON.stringify(cache.entries())).not.toContain("secret");
  expect(cache.entries().every(([key]) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
});
```

`src/signals/import-classify.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { FeedbackRow } from "@/import/feedback-csv";
import type { ModelInput } from "./contracts";
import { createMemoryPredictionCache } from "./memory-cache";
import { classifyImportedFeedback } from "./import-classify";
import { emptyMetrics, type ClassificationProvider, type ProviderResult } from "./providers";

function fakeProvider(stopAfter = Infinity) {
  let calls = 0;
  const classify = vi.fn(async (inputs: ModelInput[]): Promise<ProviderResult> => {
    if (++calls > stopAfter) return { metrics: emptyMetrics(), error: { provider: "groq", model: "test-model", category: "timeout", retryCount: 0, quota: {} }, terminal: true };
    return { payload: { items: inputs.map((m) => ({ id: m.id, intent: "cancel", reason: /pric|expensive/i.test(m.text) ? "price" : "other", confidence: m.text === "hmm" ? 0.4 : 0.9 })) }, metrics: emptyMetrics(), terminal: false };
  });
  const provider: ClassificationProvider = { provider: "groq", model: "test-model", classify };
  return { provider, classify };
}
const rows: FeedbackRow[] = [
  { segment: "at_risk", text: "Too expensive now" },
  { segment: "at_risk", text: "Moving abroad" },
  { segment: "core", text: "The price went up" },
  { segment: "new", text: "hmm" },
];

it("counts accepted reasons per segment and leaves low-confidence rows out", async () => {
  const { provider, classify } = fakeProvider();
  const result = await classifyImportedFeedback(rows, { provider, cache: createMemoryPredictionCache() });
  const zero = { price: 0, other: 0 };
  expect(result.reasonCounts).toEqual({ new: zero, core: { price: 1, other: 0 }, price_sensitive: zero, at_risk: { price: 1, other: 1 }, cancel_intent: zero });
  expect(result).toMatchObject({ total: 4, accepted: 3, unclassified: 1, cacheHits: 0, stopped: false });
  expect(result.notes).toContain("3 of 4 rows classified with confidence of at least 0.70; 1 left unclassified and not counted.");
  expect(classify.mock.calls[0][0][0]).toEqual({ id: "f1", text: "Too expensive now", source: "cancel_flow", segment: "at_risk" });
});

it("reads the cache first, so the same rows make no second model call", async () => {
  const { provider, classify } = fakeProvider();
  const cache = createMemoryPredictionCache();
  await classifyImportedFeedback(rows.slice(0, 3), { provider, cache });
  const again = await classifyImportedFeedback(rows.slice(0, 3), { provider, cache });
  expect(classify).toHaveBeenCalledTimes(1);
  expect(again).toMatchObject({ accepted: 3, cacheHits: 3 });
  expect(again.notes).toContain("3 reused from this server's in-memory cache (labels only).");
});

it("returns partial counts when classification stops early", async () => {
  const { provider } = fakeProvider(1);
  const many: FeedbackRow[] = Array.from({ length: 25 }, (_, i) => ({ segment: "core", text: `Too expensive ${i}` }));
  const result = await classifyImportedFeedback(many, { provider, cache: createMemoryPredictionCache() });
  expect(result).toMatchObject({ total: 25, accepted: 20, unclassified: 5, stopped: true });
  expect(result.reasonCounts.core).toEqual({ price: 20, other: 0 });
  expect(result.notes).toContain("Classification stopped before every row was classified (time, token or provider limit), so these counts are partial.");
});
```

`src/agent/budgeted-classifier.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import { createBudgetedClassifier } from "./budgeted-classifier";
import { RunLimitError } from "./limits";

const config = { provider: "groq" as const, model: "test-model", env: { GROQ_API_KEY: "fake-key" } };
const inputs = [{ id: "f1", text: "Too expensive", source: "cancel_flow" as const, segment: "at_risk" as const }];
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ id: "f1", intent: "cancel", reason: "price", confidence: 0.9 }] }) }, finish_reason: "stop" }], usage: { total_tokens: 150 } }));

it("paces each request with the frozen classification body before sending it", async () => {
  const order: string[] = [];
  const prepare = vi.fn(async (_body: unknown) => { order.push("prepare"); });
  const fetch = vi.fn(async () => { order.push("fetch"); return reply(); });
  const result = await createBudgetedClassifier({ ...config, fetch }, { prepare }).classify(inputs);
  expect(result.error).toBeUndefined();
  expect(order).toEqual(["prepare", "fetch"]);
  expect(prepare.mock.calls[0][0]).toMatchObject({ model: "test-model", max_completion_tokens: 4096, response_format: { type: "json_schema" } });
});

it("rethrows budget limits by default and turns them into a terminal stop when asked", async () => {
  const prepare = vi.fn(async (_body: unknown) => { throw new RunLimitError("DEADLINE"); });
  const fetch = vi.fn(async () => reply());
  await expect(createBudgetedClassifier({ ...config, fetch }, { prepare }).classify(inputs)).rejects.toBeInstanceOf(RunLimitError);
  const stopped = await createBudgetedClassifier({ ...config, fetch }, { prepare }, { onLimit: "stop" }).classify(inputs);
  expect(stopped).toMatchObject({ terminal: true, error: { category: "timeout", provider: "groq", model: "test-model" } });
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/signals/memory-cache.test.ts src/signals/import-classify.test.ts src/agent/budgeted-classifier.test.ts`

Expected: FAIL: the three modules do not exist.

- [ ] **Step 3: Implement the memory cache**

`src/signals/memory-cache.ts`:

```ts
import "server-only";
import { predictionCacheKey, type PredictionCache } from "./cache";
import type { Prediction } from "./contracts";

type Label = Omit<Prediction, "id">;
export interface MemoryPredictionCache extends PredictionCache {
  readonly size: number;
  /** For tests: what is held (hashed keys and labels, never text). */
  entries(): [string, Label][];
}

/**
 * Process-memory classifier cache for imported feedback (M6): the persistent cache's SHA-256 keys and the labels only,
 * never text. Bounded; the oldest entry leaves first. Never written to the ledger, so it never travels in an export.
 */
export function createMemoryPredictionCache(limit = 2000): MemoryPredictionCache {
  const store = new Map<string, Label>();
  return {
    get size() { return store.size; },
    entries: () => [...store.entries()].map(([key, label]): [string, Label] => [key, { ...label }]),
    get(input, context) {
      const label = store.get(predictionCacheKey(input, context));
      return label ? { id: input.id, ...label } : undefined;
    },
    set(input, context, prediction) {
      const key = predictionCacheKey(input, context);
      store.delete(key);
      store.set(key, { intent: prediction.intent, reason: prediction.reason, confidence: prediction.confidence });
      while (store.size > limit) store.delete(store.keys().next().value as string);
    },
  };
}

/** Shared by the import classification route for the life of this server process. */
export const importPredictionCache = createMemoryPredictionCache();
```

- [ ] **Step 4: Implement imported classification**

`src/signals/import-classify.ts`:

```ts
import "server-only";
import type { FeedbackRow } from "@/import/feedback-csv";
import type { ReasonCounts } from "@/twin/build-twin";
import type { PredictionCache } from "./cache";
import { classifyFeedback } from "./classify";
import type { FeedbackMessage } from "./contracts";
import { summarizeEvidence } from "./evidence";
import type { ClassificationProvider } from "./providers";

export interface ImportedClassification {
  reasonCounts: ReasonCounts;
  total: number;
  accepted: number;
  unclassified: number;
  cacheHits: number;
  stopped: boolean;
  notes: string[];
}

/**
 * Classifies uploaded feedback rows into per-segment reason counts. Text goes to the classifier only; the cache keeps
 * hashed keys and labels. The CSV has no source column, so every row is a cancellation-flow message (decision 17).
 */
export async function classifyImportedFeedback(rows: FeedbackRow[], options: { provider: ClassificationProvider; cache: PredictionCache }): Promise<ImportedClassification> {
  const messages: FeedbackMessage[] = rows.map((row, i) => ({ id: `f${i + 1}`, text: row.text, source: "cancel_flow", segment: row.segment }));
  const result = await classifyFeedback(messages, { provider: options.provider, cache: options.cache });
  const evidence = summarizeEvidence(messages, result.accepted);
  const accepted = evidence.accepted.length;
  const unclassified = result.unclassified.length;
  const notes = [`${accepted} of ${result.total} rows classified with confidence of at least 0.70; ${unclassified} left unclassified and not counted.`];
  if (result.cacheHits) notes.push(`${result.cacheHits} reused from this server's in-memory cache (labels only).`);
  if (result.stopped) notes.push("Classification stopped before every row was classified (time, token or provider limit), so these counts are partial.");
  notes.push("Counts are leaving reasons within each segment, not cancellation rates or causal discount effects.");
  return { reasonCounts: evidence.segments, total: result.total, accepted, unclassified, cacheHits: result.cacheHits, stopped: result.stopped, notes };
}
```

- [ ] **Step 5: Extract the budgeted classifier**

`src/agent/budgeted-classifier.ts` (the request shapes are copied verbatim from `src/agent/run.ts` lines 85–89):

```ts
import "server-only";
import { createProvider, emptyMetrics, type ClassificationProvider, type ProviderConfig } from "@/signals/providers";
import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA, modelInputJSON } from "@/signals/prompt";
import { RunLimitError, type createRunBudget } from "./limits";

type Budget = Pick<ReturnType<typeof createRunBudget>, "prepare">;

/**
 * A classifier whose every request is paced against a run budget before the provider's attempt timer starts,
 * mirroring only the frozen provider's request shape. With `onLimit: "stop"`, a budget limit (deadline, tokens,
 * cancellation) becomes a terminal provider result, so `classifyFeedback` returns partial results instead of throwing.
 */
export function createBudgetedClassifier(config: ProviderConfig & { model: string }, budget: Budget, options: { onLimit?: "throw" | "stop" } = {}): ClassificationProvider {
  const classifier = createProvider(config);
  return { ...classifier, async classify(inputs) {
    try {
      await budget.prepare(config.provider === "gemini" ? {
        systemInstruction: { parts: [{ text: CLASSIFICATION_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: modelInputJSON(inputs) }] }],
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "LOW" }, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: CLASSIFICATION_JSON_SCHEMA } } },
      } : { messages: [{ role: "system", content: CLASSIFICATION_INSTRUCTION }, { role: "user", content: modelInputJSON(inputs) }], stream: false, max_completion_tokens: 4096, reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: CLASSIFICATION_JSON_SCHEMA } }, model: config.model });
      return await classifier.classify(inputs);
    } catch (error) {
      if (options.onLimit !== "stop" || !(error instanceof RunLimitError)) throw error;
      return { metrics: emptyMetrics(), error: { provider: classifier.provider, model: classifier.model, category: "timeout", retryCount: 0, quota: {} }, terminal: true };
    }
  } };
}
```

In `src/agent/run.ts`:
- delete line 7, `import { createProvider } from "@/signals/providers";`;
- delete line 9, `import { CLASSIFICATION_INSTRUCTION, CLASSIFICATION_JSON_SCHEMA, modelInputJSON } from "@/signals/prompt";`;
- add `import { createBudgetedClassifier } from "./budgeted-classifier";` after the `./limits` import;
- replace lines 82–91, from `    const classifier = createProvider(config);` through the closing `    } };`, with:

```ts
    const provider = createBudgetedClassifier(config, budget);
```

The agent keeps the default `onLimit: "throw"`, so its behaviour is unchanged.

- [ ] **Step 6: Run the new and the existing agent tests**

Run: `npx vitest run src/signals/memory-cache.test.ts src/signals/import-classify.test.ts src/agent/budgeted-classifier.test.ts src/agent/http.test.ts src/agent/run.test.ts src/agent/rate-profile.test.ts src/agent/run-workflow.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/signals/memory-cache.ts src/signals/memory-cache.test.ts src/signals/import-classify.ts src/signals/import-classify.test.ts src/agent/budgeted-classifier.ts src/agent/budgeted-classifier.test.ts src/agent/run.ts
git commit -m "feat(signals): classify imported feedback with a memory-only cache"
```

---

### Task 14: `POST /api/import/classify`

**Files:**
- Modify: `src/import/import-payload.ts`
- Create: `src/app/api/import/_lib/classify-handler.ts`
- Create: `src/app/api/import/classify/route.ts`
- Test: `src/app/api/import/_lib/classify-handler.test.ts`, `src/hosting/routes.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

`src/app/api/import/_lib/classify-handler.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import { acquireAgentLease, createTokenWindow } from "@/agent/limits";
import { createMemoryPredictionCache } from "@/signals/memory-cache";
import { createClassifyHandler } from "./classify-handler";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "test-model", GROQ_API_KEY: "fake-key" };
const post = (handler: ReturnType<typeof createClassifyHandler>, body: unknown) =>
  handler(new Request("http://localhost/api/import/classify", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
/** A Groq-shaped reply that labels price words "price" and everything else "other". */
function groq(init?: RequestInit) {
  const request = JSON.parse(String(init?.body));
  const inputs: { id: string; text: string }[] = JSON.parse(request.messages[1].content);
  const items = inputs.map((m) => ({ id: m.id, intent: "cancel", reason: /price|expensive/i.test(m.text) ? "price" : "other", confidence: 0.9 }));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: "stop" }], usage: { total_tokens: 150 } }));
}
const rows = [{ segment: "at_risk", text: "Too expensive" }, { segment: "at_risk", text: "Moving abroad" }, { segment: "core", text: "The price rose" }];

it("classifies rows into per-segment counts, then answers the same rows from the cache", async () => {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const first = await post(handler, { rows });
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ provider: "groq", model: "test-model", total: 3, accepted: 3, cacheHits: 0, stopped: false });
  expect(body.reasonCounts.at_risk).toEqual({ price: 1, other: 1 });
  expect(body.reasonCounts.core).toEqual({ price: 1, other: 0 });
  const second = await (await post(handler, { rows })).json();
  expect(second).toMatchObject({ accepted: 3, cacheHits: 3 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const lease = acquireAgentLease(); lease.release(); // released after each request
});

it("returns partial counts when the deadline passes mid-classification", async () => {
  let now = 0;
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => { now += 200_000; return groq(init); });
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; } });
  const many = Array.from({ length: 45 }, (_, i) => ({ segment: "core", text: `Too expensive ${i}` }));
  const response = await post(handler, { rows: many });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ total: 45, accepted: 20, unclassified: 25, stopped: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects invalid, control-character and oversized bodies before any model call", async () => {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const badSegment = await post(handler, { rows: [{ segment: "vip", text: "hi" }] });
  expect(badSegment.status).toBe(400);
  expect((await badSegment.json()).errors[0]).toMatchObject({ row: 2, column: "segment" });
  const control = await post(handler, { rows: [{ segment: "core", text: "bell\u0007" }] });
  expect((await control.json()).errors[0]).toMatchObject({ row: 2, column: "text", message: "must not contain control characters other than tab and line breaks" });
  expect((await post(handler, { rows: [], extra: 1 })).status).toBe(400);
  expect((await post(handler, "x".repeat(700_000))).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

it("is unavailable without a configured classifier and busy while an agent run holds the lease", async () => {
  const unconfigured = await post(createClassifyHandler({ env: {} }), { rows });
  expect(unconfigured.status).toBe(503);
  expect(await unconfigured.json()).toMatchObject({ error: "CLASSIFIER_UNAVAILABLE" });
  const lease = acquireAgentLease();
  try {
    const busy = await post(createClassifyHandler({ env }), { rows });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "BUSY" });
  } finally { lease.release(); }
});
```

In `src/hosting/routes.test.ts`, add `import { createClassifyHandler } from "@/app/api/import/_lib/classify-handler";`. Inside "requires configured origin for every public mutation before parsing", add:

```ts
    expect((await createClassifyHandler()(request("/api/import/classify"))).status).toBe(403);
```

and append to the `describe` block:

```ts
  it("admits feedback classification under the agent limit", async () => {
    const store = createHostingStore(createLocalConnection(ledger()), "s".repeat(48));
    for (let i = 0; i < 3; i++) await store.admit("agent", "unverified-proxy-client");
    expect((await createClassifyHandler()(request("/api/import/classify", origin))).status).toBe(429);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/api/import/_lib/classify-handler.test.ts src/hosting/routes.test.ts`

Expected: FAIL: `./classify-handler` does not exist.

- [ ] **Step 3: Add the request schema to `src/import/import-payload.ts`**

Change `import { MAX_FEEDBACK_ROWS } from "./feedback-csv";` to:

```ts
import { CONTROL_CHARACTER_MESSAGE, hasControlCharacters, MAX_FEEDBACK_ROWS, MAX_FEEDBACK_TEXT } from "./feedback-csv";
```

Append:

```ts
/** One parsed feedback row as the browser sends it for classification. */
export const FeedbackRowSchema = z.strictObject({
  segment: z.enum(SEGMENTS),
  text: z.string().trim().min(1).max(MAX_FEEDBACK_TEXT).refine((text) => !hasControlCharacters(text), CONTROL_CHARACTER_MESSAGE),
});

/** Body of `POST /api/import/classify`. The rows are classified and dropped; nothing is stored. */
export const ClassifyRequestSchema = z.strictObject({ rows: z.array(FeedbackRowSchema).min(1).max(MAX_FEEDBACK_ROWS) });
```

- [ ] **Step 4: Implement the handler and the route**

`src/app/api/import/_lib/classify-handler.ts`:

```ts
import "server-only";
import { createBudgetedClassifier } from "@/agent/budgeted-classifier";
import { acquireAgentLease, budgetedFetch, createRunBudget, selectedAgentRateProfile, type TokenWindow } from "@/agent/limits";
import { selectedProvider } from "@/agent/model";
import { admitHostedRequest } from "@/hosting/guard";
import { ClassifyRequestSchema, payloadIssues } from "@/import/import-payload";
import type { PredictionCache } from "@/signals/cache";
import { classifyImportedFeedback } from "@/signals/import-classify";
import { importPredictionCache } from "@/signals/memory-cache";
import { errorResponse, invalidImportResponse, readBoundedJson } from "../../_lib/http";

/** 200 rows of at most 1,000 characters, JSON-escaped (decision 4). */
export const MAX_CLASSIFY_BYTES = 640 * 1024;
export const CLASSIFY_DEADLINE_MS = 300_000;

interface Deps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  acquire?: typeof acquireAgentLease;
  cache?: PredictionCache;
  window?: TokenWindow;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Classifies uploaded feedback (M6). Agent-class admission, the shared agent lease (serialized with agent runs), the
 * selected provider's rate profile and a 300 s deadline; a stop returns partial counts. Text is never stored or logged.
 * Injection belongs to server tests, never request JSON.
 */
export function createClassifyHandler(deps: Deps = {}) {
  return async function POST(request: Request): Promise<Response> {
    const admission = await admitHostedRequest(request, { limit: "agent" });
    if (admission) return admission;
    let raw: unknown;
    try { raw = await readBoundedJson(request, { maxBytes: MAX_CLASSIFY_BYTES }); }
    catch (e) { return errorResponse(e); }
    const parsed = ClassifyRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidImportResponse(payloadIssues(parsed.error));
    const env = deps.env ?? process.env;
    let selected: ReturnType<typeof selectedProvider>;
    let rateProfile: ReturnType<typeof selectedAgentRateProfile>;
    try { selected = selectedProvider(env); rateProfile = selectedAgentRateProfile(selected.provider, env); }
    catch { return Response.json({ error: "CLASSIFIER_UNAVAILABLE", message: "Feedback classification is not configured on this server. Import without feedback, or try again later." }, { status: 503 }); }
    let lease: ReturnType<typeof acquireAgentLease>;
    try { lease = (deps.acquire ?? acquireAgentLease)(); }
    catch { return Response.json({ error: "BUSY", message: "An agent run or another classification is active. Try again after it finishes." }, { status: 409 }); }
    const budget = createRunBudget({ signal: request.signal, rateProfile, maxDurationMs: CLASSIFY_DEADLINE_MS, window: deps.window, now: deps.now, sleep: deps.sleep });
    try {
      const fetcher = budgetedFetch(deps.fetch ?? globalThis.fetch, budget);
      const provider = createBudgetedClassifier({ ...selected, env, fetch: fetcher, sleep: budget.retrySleep }, budget, { onLimit: "stop" });
      const result = await classifyImportedFeedback(parsed.data.rows, { provider, cache: deps.cache ?? importPredictionCache });
      return Response.json({ ...result, provider: selected.provider, model: selected.model });
    } catch {
      return Response.json({ error: "CLASSIFICATION_FAILED", message: "Feedback classification failed. Import without feedback, or try again later." }, { status: 502 });
    } finally {
      budget.close();
      lease.release();
    }
  };
}
```

`src/app/api/import/classify/route.ts` (a route file exports only HTTP methods and route config, so the handler lives in the private `_lib` folder):

```ts
import { createClassifyHandler } from "../_lib/classify-handler";

export const POST = createClassifyHandler();
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/app/api/import/_lib/classify-handler.test.ts src/hosting/routes.test.ts src/import/import-payload.test.ts`

Expected: PASS. In the deadline test, the first batch (20 rows) is accepted; the second fetch moves the clock past 300 s, the budget's check throws inside the fetch, the transport's retry sleep throws again, and the budgeted classifier turns that into a terminal stop.

- [ ] **Step 6: Commit**

```bash
git add src/import/import-payload.ts src/app/api/import/_lib src/app/api/import/classify src/hosting/routes.test.ts
git commit -m "feat(api): classify imported feedback behind the agent limit"
```

---

### Task 15: `recommendation` agent event

**Files:**
- Modify: `src/agent/contracts.ts`
- Modify: `src/agent/stream.ts`: `eventSchema`
- Modify: `src/components/AgentPanel.tsx`: `AgentActivity`
- Test: `src/agent/stream.test.ts` (extend), `src/components/AgentPanel.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `src/agent/stream.test.ts`:

```ts
it("decodes a simulate-only recommendation and rejects one that claims an action", async () => {
  const recommendation: AgentEvent = { type: "recommendation", strategy: STARTER_STRATEGIES[0], rationale: "Fast-churning at-risk subscribers mostly cite price.", tradeoffs: "About $890 of discounts.", simulateOnly: true };
  const events: AgentEvent[] = [];
  await readAgentStream(response(frame(1, recommendation) + frame(2, { type: "done", status: "complete" })), { onEvent: (e) => events.push(e) });
  expect(events[0]).toEqual(recommendation);
  const claimed = { ...recommendation, simulateOnly: false } as unknown as AgentEvent;
  await expect(readAgentStream(response(frame(1, claimed) + frame(2, { type: "done", status: "complete" })), { onEvent() {} })).rejects.toThrow();
});
```

Append to `src/components/AgentPanel.test.ts`:

```ts
it("shows a simulate-only recommendation with the demo-only notice", () => {
  const html = renderToStaticMarkup(createElement(AgentActivity, { event: { type: "recommendation", strategy: { id: "at-risk-20-3m", name: "At-risk: 20% off", intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 6 } }, rationale: "Price-driven leavers", tradeoffs: "Discount cost", simulateOnly: true } }));
  expect(html).toContain("Recommended (simulate only): At-risk: 20% off");
  expect(html).toContain("PayPal actions are available for the demo merchant only.");
  expect(html).not.toContain("Approval below");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/agent/stream.test.ts src/components/AgentPanel.test.ts`

Expected: FAIL: TypeScript-level `recommendation` is not an `AgentEvent`, and the decoder rejects the frame.

- [ ] **Step 3: Add the event**

In `src/agent/contracts.ts`, add `import type { Strategy } from "@/twin/interventions";` and add this member to the `AgentEvent` union, after the `proposal` member:

```ts
  /** Imported merchants (M6): the agent's pick, simulate only. Never a proposal, offer or PayPal action. */
  | { type: "recommendation"; strategy: Strategy; rationale: string; tradeoffs: string; simulateOnly: true }
```

In `src/agent/stream.ts`, add this member to `eventSchema`'s `z.discriminatedUnion` list, after the `proposal` entry:

```ts
  z.strictObject({ type: z.literal("recommendation"), strategy: StrategySchema, rationale: text, tradeoffs: text, simulateOnly: z.literal(true) }),
```

In `src/components/AgentPanel.tsx`, add `import { DEMO_ONLY_MESSAGE } from "@/import/messages";` and this case in `AgentActivity`, after the `proposal` case:

```tsx
    case "recommendation": return (
      <div>
        <p className="font-medium">Recommended (simulate only): {event.strategy.name}</p>
        <p>{event.rationale}</p>
        <p className="text-muted">Tradeoffs: {event.tradeoffs}</p>
        <p>{DEMO_ONLY_MESSAGE}</p>
      </div>
    );
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/agent/stream.test.ts src/components/AgentPanel.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/contracts.ts src/agent/stream.ts src/agent/stream.test.ts src/components/AgentPanel.tsx src/components/AgentPanel.test.ts
git commit -m "feat(agent): add a simulate-only recommendation event"
```

---

### Task 16: Imported agent tools

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `src/agent/tools-imported.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/agent/tools-imported.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./contracts";
import { createToolContext, type ImportedContext } from "./tools";
import { buildImportedTwin } from "@/import/imported-twin";
import { DEMO_ONLY_MESSAGE } from "@/import/messages";
import { SAMPLE_REASON_COUNTS } from "@/import/sample-merchant";
import { ledger } from "@/ledger/db";
import { listProposals } from "@/ledger/proposals";
import { STARTER_STRATEGIES, starterStrategiesFor } from "@/merchant/candidates";
import { samplePayload } from "@/test/import-fixture";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";

const built = buildImportedTwin(samplePayload());
if (!built.ok) throw new Error("The sample must build.");
const twin = built.twin;
const withFeedback: ImportedContext = { reasonCounts: SAMPLE_REASON_COUNTS, feedbackRows: 40, reasonTargeting: true };
const rules = { discountBudget: 100000, maxProbWorse: 1, horizonMonths: 1 };

function setup(imported: ImportedContext = withFeedback) {
  ledger().exec("DELETE FROM proposals;");
  const events: AgentEvent[] = [];
  const propose = vi.fn();
  const registry = vi.fn(async () => []);
  const classify = vi.fn();
  const ctx = createToolContext({
    objective: "Reduce churn", twin, imported, propose, registry, classify,
    provider: { provider: "groq", model: "test-model", classify: vi.fn() },
    emit: (event) => events.push(event),
    simulate: (t, candidates, options) => compareStrategies(t, candidates, { ...options, runs: 20 }),
    stress: (t, strategy, options) => stressTest(t, strategy, { ...options, runs: 20 }),
  });
  return { ctx, events, propose, registry, classify };
}

describe("imported merchant tools", () => {
  it("lists price-scaled starters and reports the pre-classified counts without a model call", async () => {
    const { ctx, classify, registry } = setup();
    const state = await ctx.dispatch("get_merchant_state", {});
    if (!state.ok) throw new Error("expected state");
    expect(state.data).toMatchObject({ simulateOnly: true, metrics: { listPrice: 20 } });
    expect((state.data as { starterStrategies: { id: string }[] }).starterStrategies.map((s) => s.id)).toEqual(starterStrategiesFor(20).map((s) => s.id));
    const classified = await ctx.dispatch("classify_feedback", {});
    expect(classified).toMatchObject({ ok: true, data: { feedbackRows: 40, segments: SAMPLE_REASON_COUNTS, reasonTargeting: true } });
    expect(classify).not.toHaveBeenCalled();
    expect(registry).not.toHaveBeenCalled();
  });

  it("records a simulate-only recommendation for discounts and annual plans, never a proposal or offer", async () => {
    for (const candidate of [STARTER_STRATEGIES[0], STARTER_STRATEGIES[2]]) {
      const { ctx, events, propose, registry } = setup();
      await ctx.dispatch("classify_feedback", {});
      await ctx.dispatch("set_decision_rules", rules);
      await ctx.dispatch("simulate_strategies", { strategies: [candidate] });
      await ctx.dispatch("stress_test", { strategyId: candidate.id });
      const result = await ctx.dispatch("recommend", { strategyId: candidate.id, rationale: "Supported by the comparison", tradeoffs: "Discount cost and assumption risk" });
      expect(result).toMatchObject({ ok: true, data: { strategyId: candidate.id, simulateOnly: true, message: DEMO_ONLY_MESSAGE } });
      expect(events).toContainEqual({ type: "recommendation", strategy: candidate, rationale: "Supported by the comparison", tradeoffs: "Discount cost and assumption risk", simulateOnly: true });
      expect(events.some((e) => e.type === "proposal")).toBe(false);
      expect(propose).not.toHaveBeenCalled();
      expect(registry).not.toHaveBeenCalled();
      expect(ctx.state.proposal).toBeUndefined();
      expect(ctx.state.recommendation?.strategyId).toBe(candidate.id);
      expect(await listProposals()).toHaveLength(0);
      expect(await ctx.dispatch("simulate_strategies", { strategies: [candidate] })).toMatchObject({ ok: false, code: "RECOMMENDATION_EXISTS" });
    }
  });

  it("refuses price-reason strategies when no feedback was imported", async () => {
    const { ctx } = setup({ feedbackRows: 0, reasonTargeting: false });
    const state = await ctx.dispatch("get_merchant_state", {});
    if (!state.ok) throw new Error("expected state");
    expect((state.data as { starterStrategies: { id: string }[] }).starterStrategies.map((s) => s.id)).not.toContain("cancel-price-25-3m");
    expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: true, data: { reasonTargeting: false, segments: null } });
    await ctx.dispatch("set_decision_rules", rules);
    expect(await ctx.dispatch("simulate_strategies", { strategies: [STARTER_STRATEGIES[1]] })).toMatchObject({ ok: false, code: "REASON_UNAVAILABLE" });
  });

  it("still refuses list-price changes as recommendations", async () => {
    const { ctx } = setup();
    const rise = { id: "list-23", name: "Raise list price to $23", intervention: { kind: "list_price_change" as const, newPrice: 23 } };
    await ctx.dispatch("classify_feedback", {});
    await ctx.dispatch("set_decision_rules", rules);
    await ctx.dispatch("simulate_strategies", { strategies: [rise] });
    await ctx.dispatch("stress_test", { strategyId: "list-23" });
    expect(await ctx.dispatch("recommend", { strategyId: "list-23", rationale: "Highest median", tradeoffs: "Price response is assumed" })).toMatchObject({ ok: false, code: "NOT_EXECUTABLE" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/agent/tools-imported.test.ts`

Expected: FAIL: `ImportedContext` is not exported and the tools ignore `imported`.

- [ ] **Step 3: Implement imported mode in `src/agent/tools.ts`**

Imports: change line 5 to `import { STARTER_STRATEGIES, starterStrategiesFor } from "@/merchant/candidates";`, change line 17 to `import { SEGMENTS, type MerchantTwin, type SegmentId } from "@/twin/types";`, and add:

```ts
import { usesReasonTargeting } from "@/import/imported-twin";
import { DEMO_ONLY_MESSAGE, REASON_UNAVAILABLE_MESSAGE } from "@/import/messages";
import type { ReasonCounts } from "@/twin/build-twin";
```

Above `export interface ToolContextOptions`, add:

```ts
/** What the server knows about an imported merchant's feedback (M6). The twin itself arrives as `twin`. */
export interface ImportedContext { reasonCounts?: ReasonCounts; feedbackRows: number; reasonTargeting: boolean }
const IMPORTED_EVIDENCE_NOTE = "Your CSV history estimates churn, signups and segment moves; uploaded feedback classified before this run (if any) estimates leaving reasons. Price sensitivity, annual uptake and discount effects are assumptions. Simulate only: no PayPal action, offer or proposal exists for this merchant.";
```

In `ToolContextOptions`, after the `sleep?` member, add:

```ts
  /** Imported merchant (M6): simulate only. Reads no pilot registry and creates no proposal or offer. */
  imported?: ImportedContext;
```

In `ToolState`, change `stresses: Record<string, StressResult>; proposal?: Proposal;` to:

```ts
  stresses: Record<string, StressResult>; proposal?: Proposal;
  /** Imported merchants only: the simulate-only pick. */
  recommendation?: { strategyId: string; rationale: string; tradeoffs: string };
```

In `createToolContext`, after `const emit = options.emit ?? (() => {});`, add `const imported = options.imported;`.

In `invoke`, after the `PROPOSAL_EXISTS` line, add:

```ts
    if (state.recommendation && name !== "get_merchant_state") throw new ToolFailure("RECOMMENDATION_EXISTS", "This run already recorded its simulate-only recommendation. Start a new run to explore further.");
```

Replace the whole `case "get_merchant_state": { … }` block with:

```ts
      case "get_merchant_state": {
        const active = Object.values(state.twin.initialActive).reduce((sum, count) => sum + count, 0);
        const feedbackIn = (segment: SegmentId) => (imported?.reasonCounts?.[segment].price ?? 0) + (imported?.reasonCounts?.[segment].other ?? 0);
        return {
          merchant: state.twin.merchant, asOfMonth: state.twin.asOfMonth,
          metrics: { currency: state.twin.params.currency, listPrice: state.twin.params.listPrice, active, monthlyListRevenue: active * state.twin.params.listPrice, unitFulfilmentCost: state.twin.params.unitCost + state.twin.params.shippingCost },
          segments: SEGMENTS.map((segment) => {
            const p = state.twin.params.segments[segment];
            const reasonShareSource = imported ? (feedbackIn(segment) > 0 ? "estimated" : "assumption") : state.twin.provenance[`segments.${segment}.priceReasonShare`]?.source ?? "assumption";
            return { segment, active: state.twin.initialActive[segment], monthlyChurnMean: p.monthlyChurn.alpha / (p.monthlyChurn.alpha + p.monthlyChurn.beta), priceReasonShareMean: p.priceReasonShare.alpha / (p.priceReasonShare.alpha + p.priceReasonShare.beta), reasonShareSource };
          }),
          assumptions: assumptions(), evidenceNote: imported ? IMPORTED_EVIDENCE_NOTE : "Synthetic history estimates churn; classified feedback estimates leaving reasons. Intervention effects are uncertain and stress tested.",
          starterStrategies: imported ? starterStrategiesFor(state.twin.params.listPrice, { reasonTargeting: imported.reasonTargeting }) : STARTER_STRATEGIES,
          baseline: { strategy: BASELINE, automaticallyIncluded: true },
          rules: state.rules, rulesExplicit: state.rulesExplicit, classified: state.classified, classification: state.classification, terminalFailure: state.terminalFailure, revision: state.revision, comparedStrategyIds: [...strategies.keys()], proposalId: state.proposal?.id,
          ...(imported ? { simulateOnly: true, recommendedStrategyId: state.recommendation?.strategyId } : {}),
        };
      }
```

In `case "classify_feedback"`, directly after `state.classified = false; state.classification = undefined; invalidate();`, add:

```ts
        if (imported) {
          // Classified by POST /api/import/classify before this run; no model call here.
          state.classified = true;
          return {
            source: "AI-classified uploaded feedback, classified before this run (no model call now)",
            feedbackRows: imported.feedbackRows, segments: imported.reasonCounts ?? null, reasonTargeting: imported.reasonTargeting,
            note: imported.reasonTargeting ? "Reason counts within each segment, not cancellation rates or causal discount effects." : REASON_UNAVAILABLE_MESSAGE,
          };
        }
```

In `case "simulate_strategies"`, directly after `const candidate = StrategySchema.parse(raw);`, add:

```ts
          if (imported && !imported.reasonTargeting && usesReasonTargeting(candidate)) throw new ToolFailure("REASON_UNAVAILABLE", REASON_UNAVAILABLE_MESSAGE);
```

In `case "recommend"`, replace the kind check:

```ts
        if (kind !== "targeted_discount" && kind !== "annual_plan") throw new ToolFailure("NOT_EXECUTABLE", "Only retention discounts and annual-plan offers are executable in this build.");
```

with:

```ts
        if (kind !== "targeted_discount" && kind !== "annual_plan") throw new ToolFailure("NOT_EXECUTABLE", imported ? "Only retention discounts and annual-plan strategies can be recommended; a list-price change rests on an unobserved price-response assumption." : "Only retention discounts and annual-plan offers are executable in this build.");
```

and directly after the `RULE_VIOLATION` throw (before the `eligibleTargetIds` line), add:

```ts
        if (imported) {
          // Simulate only: no registry read, no proposal, no annual offer, no PayPal.
          state.recommendation = { strategyId, rationale, tradeoffs };
          emit({ type: "recommendation", strategy: result.strategy, rationale, tradeoffs, simulateOnly: true });
          return { strategyId, simulateOnly: true, message: DEMO_ONLY_MESSAGE, rationale, tradeoffs };
        }
```

- [ ] **Step 4: Run the new and the existing tool tests**

Run: `npx vitest run src/agent/tools-imported.test.ts src/agent/tools.test.ts`

Expected: PASS. Ridgeline's tool behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools-imported.test.ts
git commit -m "feat(agent): simulate-only tools for imported merchants"
```

---

### Task 17: Imported agent runs and endpoint

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `src/agent/http.ts`
- Test: `src/agent/run-imported.test.ts`, `src/agent/route-handler.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

`src/agent/run-imported.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "./contracts";
import { createTokenWindow } from "./limits";
import type { AgentModel, AssistantMessage } from "./model";
import { runAgent } from "./run";
import { buildImportedTwin } from "@/import/imported-twin";
import { SAMPLE_REASON_COUNTS } from "@/import/sample-merchant";
import { ledger } from "@/ledger/db";
import { listProposals } from "@/ledger/proposals";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { emptyMetrics } from "@/signals/providers";
import { samplePayload } from "@/test/import-fixture";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";

const reads = vi.hoisted(() => ({ discount: 0, annual: 0 }));
vi.mock("@/ledger/discount-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/discount-outcomes")>();
  return { ...actual, readDiscountOutcomes: vi.fn(async (...args: Parameters<typeof actual.readDiscountOutcomes>) => { reads.discount++; return actual.readDiscountOutcomes(...args); }) };
});
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return { ...actual, readAnnualOfferEvidence: vi.fn(async (...args: Parameters<typeof actual.readAnnualOfferEvidence>) => { reads.annual++; return actual.readAnnualOfferEvidence(...args); }) };
});

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
const call = (id: string, name: string, args: unknown = {}): AssistantMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const pick = STARTER_STRATEGIES[0];

it("runs an imported merchant simulate-only: no observed evidence, no proposal, complete after recommend", async () => {
  ledger().exec("DELETE FROM proposals;");
  reads.discount = 0; reads.annual = 0;
  const built = buildImportedTwin(samplePayload());
  if (!built.ok) throw new Error("The sample must build.");
  const sequence = [
    call("state", "get_merchant_state"), call("classify", "classify_feedback"),
    call("rules", "set_decision_rules", { discountBudget: 1000, maxProbWorse: 1, horizonMonths: 1 }),
    call("compare", "simulate_strategies", { strategies: [pick] }), call("stress", "stress_test", { strategyId: pick.id }),
    call("recommend", "recommend", { strategyId: pick.id, rationale: "At-risk leavers mostly cite price", tradeoffs: "Discount cost" }),
    say("Simulate-only recommendation recorded."),
  ];
  let turn = 0;
  const model = { respond: vi.fn<AgentModel["respond"]>(async () => ({ message: sequence[turn++] ?? say("Done"), metrics: emptyMetrics() })) };
  const propose = vi.fn();
  const events: AgentEvent[] = [];
  const result = await runAgent({
    objective: "Find the most valuable way to keep at-risk subscribers", env, window: createTokenWindow(), model, emit: (e) => events.push(e),
    imported: { twin: built.twin, reasonCounts: SAMPLE_REASON_COUNTS, feedbackRows: 40, reasonTargeting: true },
    toolOptions: {
      propose,
      simulate: (t, candidates, options) => compareStrategies(t, candidates, { ...options, runs: 20 }),
      stress: (t, strategy, options) => stressTest(t, strategy, { ...options, runs: 20 }),
    },
  });
  expect(result).toMatchObject({ status: "complete", reason: "COMPLETE" });
  expect(result.proposalId).toBeUndefined();
  expect(reads).toEqual({ discount: 0, annual: 0 });
  expect(propose).not.toHaveBeenCalled();
  expect(events.some((e) => e.type === "observed_snapshot" || e.type === "proposal")).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "recommendation", simulateOnly: true }));
  expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("Imported merchant: simulate only") }));
  expect(await listProposals()).toHaveLength(0);
  expect(JSON.stringify(model.respond.mock.calls[0][0][0])).toContain("Imported merchant (simulate only)");
});
```

In `src/agent/route-handler.test.ts`, add `import { samplePayload } from "@/test/import-fixture";` and append:

```ts
it("passes a valid import to the runner as a rebuilt twin and refuses an invalid one before the lease", async () => {
  let seen: RunOptions["imported"];
  const run = vi.fn(async (o: RunOptions) => { seen = o.imported; return runner(o); });
  const response = await createAgentHandler({ run })(request({ objective: "Explore", import: samplePayload() }));
  await readAgentStream(response, { onEvent() {} });
  expect(seen?.twin.merchant).toMatchObject({ id: "imported-csv", name: "Hollowbrook Treat Box" });
  expect(seen).toMatchObject({ feedbackRows: 40, reasonTargeting: true });
  const broken = samplePayload();
  broken.rows[12][3] = 999_999;
  const refused = vi.fn(runner), acquire = vi.fn(acquireAgentLease);
  const invalid = await createAgentHandler({ run: refused, acquire })(request({ objective: "Explore", import: broken }));
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).errors[0]).toMatchObject({ row: 14, column: "voluntary_cancels" });
  expect(refused).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  const huge = await createAgentHandler({ run: refused })(request({ objective: "Explore", padding: "y".repeat(70_000) }));
  expect(huge.status).toBe(413);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/agent/run-imported.test.ts src/agent/route-handler.test.ts`

Expected: FAIL: `imported` is not a run option and the endpoint's strict schema rejects `import`.

- [ ] **Step 3: Implement imported runs in `src/agent/run.ts`**

Change the `./tools` import to `import { createToolContext, type ImportedContext, type ToolContextOptions, type TOOL_DEFINITIONS } from "./tools";`.

Directly after `AGENT_INSTRUCTION`, add:

```ts
/** Appended for imported merchants (M6). It overrides anything above about proposals, offers or PayPal. */
export const IMPORTED_AGENT_INSTRUCTION = "Imported merchant (simulate only): this twin was estimated from the merchant's uploaded CSV in this browser session. PayPal actions, annual-plan offers and proposals are not available for it, and it has no pilot cohort; ignore any statement above that a recommendation becomes a proposal or an offer. classify_feedback reports the uploaded feedback that the server classified before this run and makes no model call. If no feedback was imported, leaving reasons are unknown: do not submit price-reason strategies. recommend records a simulate-only recommendation with your rationale and tradeoffs. Say plainly that the recommendation is simulate only.";
export type ImportedRun = ImportedContext & { twin: MerchantTwin };
```

In `ToolBoundary.state`, change `proposal?: Pick<Proposal, "id"> };` to `proposal?: Pick<Proposal, "id">; recommendation?: { strategyId: string } };`.

In `RunOptions`, after `readMerchant?: …;`, add:

```ts
  /** Imported merchant (M6): simulate only; the twin comes from the request, never from observedMerchant. */
  imported?: ImportedRun;
```

Replace the `const view = …` line with:

```ts
    const view = options.imported ? { twin: options.imported.twin, evidence: undefined, changes: undefined, annual: undefined }
      : options.toolOptions?.twin ? { twin: options.toolOptions.twin, evidence: undefined, changes: undefined, annual: undefined }
      : await (options.readMerchant ?? observedMerchant)();
```

In the `tools = (options.createTools ?? createToolContext)({ ...options.toolOptions, twin: view.twin, objective, …` call, insert after `...options.toolOptions,`:

```ts
...(options.imported ? { imported: { reasonCounts: options.imported.reasonCounts, feedbackRows: options.imported.feedbackRows, reasonTargeting: options.imported.reasonTargeting } } : {}),
```

Replace `transcript.push({ role: "system", content: AGENT_INSTRUCTION }, { role: "user", content: objective });` with:

```ts
    transcript.push({ role: "system", content: options.imported ? `${AGENT_INSTRUCTION}\n\n${IMPORTED_AGENT_INSTRUCTION}` : AGENT_INSTRUCTION }, { role: "user", content: objective });
```

Replace the status emit with:

```ts
    emit({ type: "status", message: `Investigating with ${selected.provider === "gemini" ? "Gemini" : "Groq"} ${modelName}. ${options.imported ? "Imported merchant: simulate only; no PayPal action will be prepared." : "Proposed actions require merchant approval."}` });
```

Replace `const final = !!state.proposal;` with `const final = !!state.proposal || !!state.recommendation;`, and `if (tools.state.proposal) return finish("PROTOCOL");` with `if (tools.state.proposal || tools.state.recommendation) return finish("PROTOCOL");`.

- [ ] **Step 4: Accept the import in `src/agent/http.ts`**

Add imports:

```ts
import { ImportPayloadSchema } from "@/import/import-payload";
import { buildImportedTwin } from "@/import/imported-twin";
import { capErrors } from "@/import/row-error";
import { runAgent, type ImportedRun } from "./run";
```

(replacing `import { runAgent } from "./run";`). Replace the body schema and cap:

```ts
const bodySchema = z.strictObject({ objective: z.string().trim().min(1).max(2000), import: ImportPayloadSchema.optional() });
/** Room for the largest legal import payload (about 31 KiB, decision 4) beside the objective. */
const MAX_BODY_BYTES = 64 * 1024;
```

Change the invalid-body message to `"Provide an objective of 1–2000 characters and, optionally, a valid import."`. After the `catch (error) { return Response.json(… ) }` that follows `readBody`, add:

```ts
    let imported: ImportedRun | undefined;
    if (body.import) {
      // Rebuilt per request from the payload; never stored. Invalid rows are refused before the lease.
      const built = buildImportedTwin(body.import);
      if (!built.ok) return Response.json({ message: "The imported history is invalid. Nothing was run.", errors: capErrors(built.errors) }, { status: 400 });
      imported = { twin: built.twin, feedbackRows: built.feedbackRows, reasonTargeting: built.reasonTargeting, ...(built.reasonTargeting ? { reasonCounts: body.import.reasonCounts } : {}) };
    }
```

and change the runner call to:

```ts
            try { await (deps.run ?? runAgent)({ objective: body.objective, signal: controller.signal, emit, lease, ...(imported ? { imported } : {}) }); if (!terminal) fail(); }
```

- [ ] **Step 5: Run the agent tests**

Run: `npx vitest run src/agent`

Expected: PASS (re-run `src/agent/run.test.ts` alone if only its deadline or BUSY test times out under load).

- [ ] **Step 6: Commit**

```bash
git add src/agent/run.ts src/agent/http.ts src/agent/run-imported.test.ts src/agent/route-handler.test.ts
git commit -m "feat(agent): run imported merchants simulate-only"
```

---

### Task 18: Client agent session sends the import

**Files:**
- Modify: `src/agent/stream.ts`: `requestAgent`
- Modify: `src/components/agent-session.ts`
- Modify: `src/components/AgentPanel.tsx`: `AgentPanel`
- Modify: `src/components/lab-state.ts`
- Test: `src/components/agent-session.test.ts`, `src/components/AgentPanel.test.ts`, `src/components/lab-state.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `src/components/agent-session.test.ts` (add `import { samplePayload } from "@/test/import-fixture";`):

```ts
it("sends the import with the objective only when one is active", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response("ok"));
  const callbacks = { fetch: fetcher, onEvent: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
  await new AgentSession().run("Explore", callbacks);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ objective: "Explore" });
  const payload = samplePayload();
  await new AgentSession().run("Explore", { ...callbacks, import: payload });
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ objective: "Explore", import: payload });
});
```

Append to `src/components/AgentPanel.test.ts` (add `import { samplePayload } from "@/test/import-fixture";`):

```ts
it("tells the user an imported investigation is simulate only", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, { objective: "Explore", disabled: false, importPayload: samplePayload(), onStart() {}, onEvent() {}, onFinish() {} }));
  expect(html).toContain("Ready to investigate. Imported merchant: simulate only, no PayPal action.");
});
```

Append to `src/components/lab-state.test.ts`:

```ts
it("selects a simulate-only recommendation from the current comparison without creating a proposal", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, comparisonSource: "agent", selectedId: "list-27" }, { type: "event", event: { type: "recommendation", strategy: STARTER_STRATEGIES[0], rationale: "r", tradeoffs: "t", simulateOnly: true } });
  expect(state).toMatchObject({ selectedId: STARTER_STRATEGIES[0].id, proposal: null, proposalSource: null });
  const unknown = { ...STARTER_STRATEGIES[0], id: "not-compared" };
  expect(dashboardReducer(state, { type: "event", event: { type: "recommendation", strategy: unknown, rationale: "r", tradeoffs: "t", simulateOnly: true } })).toBe(state);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/agent-session.test.ts src/components/AgentPanel.test.ts src/components/lab-state.test.ts`

Expected: FAIL: `import` and `importPayload` are unknown, and the reducer ignores `recommendation`.

- [ ] **Step 3: Implement**

In `src/agent/stream.ts`, add `import type { ImportPayload } from "@/import/import-payload";` and replace `requestAgent`'s signature and body line:

```ts
export async function requestAgent(objective: string, options: StreamOptions & { fetch?: typeof fetch; import?: ImportPayload }): Promise<Done> {
  let response: Response;
  try { response = await (options.fetch ?? fetch)("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.import ? { objective, import: options.import } : { objective }), signal: options.signal }); }
```

(the rest of the function is unchanged).

In `src/components/agent-session.ts`, add `import type { ImportPayload } from "@/import/import-payload";`, add `import?: ImportPayload;` to `SessionCallbacks` (after `fetch?`), and change the `requestAgent` call to:

```ts
      const result = await requestAgent(objective, { fetch: callbacks.fetch, ...(callbacks.import ? { import: callbacks.import } : {}), signal: controller.signal, onEvent: event => {
```

In `src/components/AgentPanel.tsx`, add `import type { ImportPayload } from "@/import/import-payload";` and replace the component's signature, initial status and `run` call:

```tsx
export function AgentPanel({ objective, disabled, importPayload = null, onStart, onEvent, onFinish }: {
  objective: string; disabled: boolean;
  /** Imported merchant (M6): sent with each run; the run is simulate only. */
  importPayload?: ImportPayload | null;
  onStart(): void; onEvent(event: AgentEvent): void; onFinish(): void;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState(importPayload ? "Ready to investigate. Imported merchant: simulate only, no PayPal action." : "Ready to investigate. Proposals require separate merchant approval.");
```

```tsx
    await session.current.run(objective, {
      ...(importPayload ? { import: importPayload } : {}),
      onEvent(event) {
        setEvents(previous => [...previous, event].slice(-120));
        onEvent(event);
      },
      onResult: done => setStatus(done.status === "complete" ? (importPayload ? "Investigation complete. Simulate only: no PayPal action was prepared." : "Investigation complete. Review the proposal and uncertainty before approving.") : `Run ${done.status}: ${done.reason ?? "no completed recommendation"}.`),
```

`onError` and `onFinish` stay as they are. The workspace is remounted per merchant (Task 21), so the initial status always matches the merchant.

In `src/components/lab-state.ts`, after the `event.type === "proposal"` line, add:

```ts
      if (event.type === "recommendation" && state.comparison?.strategies.some(s => s.strategy.id === event.strategy.id && s.strategy.id !== state.comparison?.baselineId)) return { ...state, ...clearReview, selectedId: event.strategy.id };
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/components/agent-session.test.ts src/components/AgentPanel.test.ts src/components/lab-state.test.ts src/agent/stream.test.ts`

Expected: PASS (the existing `requestAgent` test still sees exactly `{ objective: "Explore" }`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/stream.ts src/components/agent-session.ts src/components/agent-session.test.ts src/components/AgentPanel.tsx src/components/AgentPanel.test.ts src/components/lab-state.ts src/components/lab-state.test.ts
git commit -m "feat(ui): send the active import with agent runs"
```

---

### Task 19: Import flow and the "Use your own data" panel

**Files:**
- Create: `src/components/import-flow.ts`
- Create: `src/components/ImportPanel.tsx`
- Test: `src/components/import-flow.test.ts`, `src/components/ImportPanel.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/components/import-flow.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS } from "@/import/economics";
import { SAMPLE_REASON_COUNTS, sampleMerchantFiles } from "@/import/sample-merchant";
import { buildImport, formatImportError } from "./import-flow";

const files = sampleMerchantFiles();
const summary = { name: "Hollowbrook Treat Box", listPrice: 20 };
function fakeServer(replies: { classify?: () => Response; validate?: () => Response } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "/api/import/classify") return replies.classify?.() ?? Response.json({ reasonCounts: SAMPLE_REASON_COUNTS, notes: ["40 of 40 rows classified."] });
    if (url === "/api/import/validate") return replies.validate?.() ?? Response.json({ summary, reasonTargeting: true });
    return new Response("not found", { status: 404 });
  });
}

it("checks every file locally before any request and names the source of each error", async () => {
  const fetcher = fakeServer();
  const result = await buildImport({ history: "month,segment\n", feedback: "segment,text\nvip,hi\n", economics: { ...DEFAULT_ECONOMICS, listPrice: 0 } }, fetcher);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(new Set(result.errors.map((e) => e.source))).toEqual(new Set(["history", "economics", "feedback"]));
  expect(fetcher).not.toHaveBeenCalled();
});

it("classifies feedback, then validates the payload, and builds a session", async () => {
  const fetcher = fakeServer();
  const result = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fetcher);
  expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual(["/api/import/classify", "/api/import/validate"]);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).rows).toHaveLength(40);
  const sent = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(sent).toMatchObject({ economics: SAMPLE_ECONOMICS, reasonCounts: SAMPLE_REASON_COUNTS });
  expect(sent.rows).toHaveLength(60);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session.payload).toEqual(sent);
  expect(result.session.starterStrategies.map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-18", "list-23"]);
  expect(result.session.classifierNotes).toEqual(["40 of 40 rows classified."]);
});

it("skips classification without feedback and drops price-reason starters", async () => {
  const fetcher = fakeServer({ validate: () => Response.json({ summary, reasonTargeting: false }) });
  const result = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fetcher);
  expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual(["/api/import/validate"]);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("reasonCounts");
  expect(result.ok && result.session.starterStrategies.map((s) => s.id)).not.toContain("cancel-price-25-3m");
});

it("keeps server row errors and turns other failures into one message", async () => {
  const rows = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ error: "INVALID_IMPORT", errors: [{ row: 14, column: "voluntary_cancels", message: "too many" }] }, { status: 400 }) }));
  expect(!rows.ok && rows.errors.map(formatImportError)).toEqual(["Server check · row 14, voluntary_cancels: too many"]);
  const unavailable = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fakeServer({ classify: () => Response.json({ error: "CLASSIFIER_UNAVAILABLE", message: "Feedback classification is not configured on this server." }, { status: 503 }) }));
  expect(!unavailable.ok && unavailable.errors.map(formatImportError)).toEqual(["Feedback file · Feedback classification is not configured on this server."]);
  const limited = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ error: "RATE_LIMITED" }, { status: 429 }) }));
  expect(!limited.ok && limited.errors.map(formatImportError)).toEqual(["Server check · Too many requests. Try again later."]);
});
```

`src/components/ImportPanel.test.ts`:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SAMPLE_FILES } from "@/import/sample-files";
import { samplePayload } from "@/test/import-fixture";
import type { MerchantSummary } from "@/merchant/summary";
import { DemoOnlyNotice, ImportedBanner, ImportErrors, ImportPanel } from "./ImportPanel";
import type { ImportSession } from "./import-flow";

it("offers template and sample downloads, two file inputs and the prefilled economics", () => {
  const html = renderToStaticMarkup(createElement(ImportPanel, { disabled: false, onImported() {} }));
  expect(html).toContain("Use your own data");
  for (const path of Object.values(SAMPLE_FILES)) expect(html).toContain(`href="/${path}"`);
  expect(html.match(/type="file"/g)).toHaveLength(2);
  expect(html).toContain('value="Your merchant"');
  expect(html).toContain('value="24"');
  expect(html).toContain("merchant-entered assumptions");
  expect(html).toContain("Build twin");
  expect(html).toContain("Load sample merchant");
});

it("shows the imported banner, notes and Back to Ridgeline, and the demo-only notice", () => {
  const session = { id: 1, payload: samplePayload(), summary: { name: "Hollowbrook Treat Box" } as MerchantSummary, starterStrategies: [], reasonTargeting: true, classifierNotes: ["40 of 40 rows classified."] } satisfies ImportSession;
  const banner = renderToStaticMarkup(createElement(ImportedBanner, { session, disabled: false, onBack() {} }));
  expect(banner).toContain("Imported: Hollowbrook Treat Box · simulate only");
  expect(banner).toContain("Back to Ridgeline");
  expect(banner).toContain("40 of 40 rows classified.");
  expect(renderToStaticMarkup(createElement(DemoOnlyNotice))).toContain("PayPal actions are available for the demo merchant only.");
});

it("lists every import error with its file, row and column", () => {
  const html = renderToStaticMarkup(createElement(ImportErrors, { errors: [
    { source: "history", row: 14, column: "voluntary_cancels", message: "voluntary + involuntary cancels + moves exceed active_start" },
    { source: "economics", row: null, column: "listPrice", message: "must be at least 1 USD" },
  ] }));
  expect(html).toContain("History file · row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start");
  expect(html).toContain("Economics · listPrice: must be at least 1 USD");
  expect(html).toContain("the current twin is unchanged");
  expect(html).toContain('role="alert"');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/import-flow.test.ts src/components/ImportPanel.test.ts`

Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement the flow**

`src/components/import-flow.ts`:

```ts
import { EconomicsSchema, economicsErrors } from "@/import/economics";
import { parseFeedbackCsv } from "@/import/feedback-csv";
import { parseHistoryCsv } from "@/import/history-csv";
import { toTuple, type ImportPayload } from "@/import/import-payload";
import { formatRowError, type RowError } from "@/import/row-error";
import { starterStrategiesFor } from "@/merchant/candidates";
import type { MerchantSummary } from "@/merchant/summary";
import type { ReasonCounts } from "@/twin/build-twin";
import type { Strategy } from "@/twin/interventions";

// Browser side of a CSV import: parse locally for instant per-row errors, then classify feedback (optional) and let the
// server re-validate. Nothing changes unless every step succeeds; the session lives only in this tab's memory.

export interface ImportSession {
  /** Changes on every successful import, so the workspace remounts. */
  id: number;
  payload: ImportPayload;
  summary: MerchantSummary;
  starterStrategies: Strategy[];
  reasonTargeting: boolean;
  classifierNotes: string[];
}
export interface ImportError extends RowError { source: "history" | "feedback" | "economics" | "server" }
export interface ImportFiles { history: string; feedback: string | null; economics: unknown }
export type ImportResult = { ok: true; session: ImportSession } | { ok: false; errors: ImportError[] };

const LABELS: Record<ImportError["source"], string> = { history: "History file", feedback: "Feedback file", economics: "Economics", server: "Server check" };
export const formatImportError = (error: ImportError) => `${LABELS[error.source]} · ${formatRowError(error)}`;

let nextSessionId = 1;
const tag = (source: ImportError["source"], errors: RowError[]): ImportError[] => errors.map((error) => ({ ...error, source }));

async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, data: { message: "Network error. Nothing was changed." } };
  }
}

function serverErrors(source: ImportError["source"], response: { status: number; data: unknown }): ImportError[] {
  const body = (response.data ?? {}) as { errors?: RowError[]; message?: string };
  if (Array.isArray(body.errors) && body.errors.length) return tag(source, body.errors);
  const message = body.message ?? (response.status === 429 ? "Too many requests. Try again later." : `Request failed (${response.status}).`);
  return [{ source, row: null, column: null, message }];
}

export async function buildImport(files: ImportFiles, fetcher: typeof fetch = fetch): Promise<ImportResult> {
  const history = parseHistoryCsv(files.history);
  const economics = EconomicsSchema.safeParse(files.economics);
  const feedback = files.feedback === null ? null : parseFeedbackCsv(files.feedback);
  if (!history.ok || !economics.success || (feedback && !feedback.ok)) {
    return { ok: false, errors: [
      ...(history.ok ? [] : tag("history", history.errors)),
      ...(economics.success ? [] : tag("economics", economicsErrors(economics.error))),
      ...(feedback && !feedback.ok ? tag("feedback", feedback.errors) : []),
    ] };
  }
  let reasonCounts: ReasonCounts | undefined;
  let classifierNotes: string[] = [];
  if (feedback) {
    const classified = await post(fetcher, "/api/import/classify", { rows: feedback.rows });
    if (!classified.ok) return { ok: false, errors: serverErrors("feedback", classified) };
    const data = classified.data as { reasonCounts: ReasonCounts; notes: string[] };
    reasonCounts = data.reasonCounts;
    classifierNotes = data.notes;
  }
  const payload: ImportPayload = { rows: history.rows.map(toTuple), economics: economics.data, ...(reasonCounts ? { reasonCounts } : {}) };
  const validated = await post(fetcher, "/api/import/validate", payload);
  if (!validated.ok) return { ok: false, errors: serverErrors("server", validated) };
  const { summary, reasonTargeting } = validated.data as { summary: MerchantSummary; reasonTargeting: boolean };
  return { ok: true, session: { id: nextSessionId++, payload, summary, reasonTargeting, classifierNotes, starterStrategies: starterStrategiesFor(summary.listPrice, { reasonTargeting }) } };
}
```

- [ ] **Step 4: Implement the panel**

`src/components/ImportPanel.tsx`:

```tsx
"use client";

import { useState, type ChangeEvent } from "react";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS, type Economics } from "@/import/economics";
import { MAX_FEEDBACK_BYTES } from "@/import/feedback-csv";
import { MAX_HISTORY_BYTES } from "@/import/history-csv";
import { DEMO_ONLY_MESSAGE } from "@/import/messages";
import { SAMPLE_FILES } from "@/import/sample-files";
import { buildImport, formatImportError, type ImportError, type ImportSession } from "./import-flow";

interface LoadedFile { name: string; text: string }
type EconomicsForm = Record<keyof Economics, string>;
const NUMBER_FIELDS = [
  ["listPrice", "List price (USD per month, 1–200)"],
  ["unitCost", "Unit cost (USD)"],
  ["shippingCost", "Shipping cost (USD)"],
  ["paymentFeeRate", "Payment fee rate (0–0.2)"],
  ["paymentFeeFixed", "Fixed payment fee (USD, 0–5)"],
] as const;
const input = "mt-1 block min-h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3";
const toForm = (e: Economics): EconomicsForm => ({ merchantName: e.merchantName, planName: e.planName, listPrice: String(e.listPrice), unitCost: String(e.unitCost), shippingCost: String(e.shippingCost), paymentFeeRate: String(e.paymentFeeRate), paymentFeeFixed: String(e.paymentFeeFixed) });
/** Blank or non-numeric fields become NaN, which the schema reports per field. */
const toNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
const fromForm = (f: EconomicsForm) => ({ merchantName: f.merchantName, planName: f.planName, listPrice: toNumber(f.listPrice), unitCost: toNumber(f.unitCost), shippingCost: toNumber(f.shippingCost), paymentFeeRate: toNumber(f.paymentFeeRate), paymentFeeFixed: toNumber(f.paymentFeeFixed) });
const fileError = (source: ImportError["source"], message: string): ImportError => ({ source, row: null, column: null, message });

async function readLimited(file: File, maxBytes: number, source: "history" | "feedback"): Promise<LoadedFile | ImportError> {
  if (file.size > maxBytes) return fileError(source, `${file.name} is larger than ${maxBytes / 1024} KiB`);
  return { name: file.name, text: await file.text() };
}

export function ImportPanel({ disabled, onImported }: { disabled: boolean; onImported(session: ImportSession): void }) {
  const [history, setHistory] = useState<LoadedFile | null>(null);
  const [feedback, setFeedback] = useState<LoadedFile | null>(null);
  const [form, setForm] = useState<EconomicsForm>(() => toForm(DEFAULT_ECONOMICS));
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;

  const pick = (source: "history" | "feedback") => async (event: ChangeEvent<HTMLInputElement>) => {
    const set = source === "history" ? setHistory : setFeedback;
    const file = event.target.files?.[0];
    if (!file) { set(null); return; }
    const loaded = await readLimited(file, source === "history" ? MAX_HISTORY_BYTES : MAX_FEEDBACK_BYTES, source);
    if ("text" in loaded) { set(loaded); setErrors([]); } else { set(null); setErrors([loaded]); }
  };
  const loadSample = async () => {
    setBusy(true); setErrors([]);
    try {
      const [h, f] = await Promise.all([SAMPLE_FILES.history, SAMPLE_FILES.feedback].map(async (path) => {
        const response = await fetch(`/${path}`);
        if (!response.ok) throw new Error(path);
        return { name: path.split("/").pop()!, text: await response.text() };
      }));
      setHistory(h); setFeedback(f); setForm(toForm(SAMPLE_ECONOMICS));
    } catch {
      setErrors([fileError("server", "The sample files could not be loaded.")]);
    } finally { setBusy(false); }
  };
  const build = async () => {
    if (!history) { setErrors([fileError("history", "Choose a history CSV first.")]); return; }
    setBusy(true); setErrors([]);
    try {
      const result = await buildImport({ history: history.text, feedback: feedback?.text ?? null, economics: fromForm(form) });
      if (result.ok) onImported(result.session); else setErrors(result.errors);
    } finally { setBusy(false); }
  };

  return (
    <details className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <summary className="min-h-10 cursor-pointer pt-2 text-lg font-semibold">Use your own data</summary>
      <p className="mt-2 text-sm text-muted">
        Upload monthly subscriber history and, optionally, cancellation feedback to build a separate twin for this browser tab. It is simulate only: {DEMO_ONLY_MESSAGE} Your files stay in this tab; the server re-checks them on each request and stores nothing. Reloading the page returns to Ridgeline.
      </p>
      <p className="mt-2 text-sm">
        Download: <a href={`/${SAMPLE_FILES.template}`} download className="text-brand-accent underline">history template</a> · <a href={`/${SAMPLE_FILES.history}`} download className="text-brand-accent underline">sample history</a> · <a href={`/${SAMPLE_FILES.feedback}`} download className="text-brand-accent underline">sample feedback</a>
      </p>
      <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="min-w-0 text-sm">History CSV (required: 6–60 months, up to 256 KiB)
          <input type="file" accept=".csv,text/csv" disabled={locked} onChange={pick("history")} className="mt-1 block w-full min-w-0 text-sm" />
          {history && <span className="mt-1 block text-muted">Using {history.name}</span>}
        </label>
        <label className="min-w-0 text-sm">Feedback CSV (optional: up to 200 rows, classified by AI; text is not stored)
          <input type="file" accept=".csv,text/csv" disabled={locked} onChange={pick("feedback")} className="mt-1 block w-full min-w-0 text-sm" />
          {feedback && <span className="mt-1 block text-muted">Using {feedback.name} <button type="button" disabled={locked} onClick={() => setFeedback(null)} className="ml-2 min-h-10 text-brand-accent underline">Remove</button></span>}
        </label>
      </div>
      <fieldset disabled={locked} className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">Unit economics: merchant-entered assumptions, prefilled with the demo merchant&apos;s numbers</legend>
        <label className="min-w-0 text-sm">Merchant name<input value={form.merchantName} maxLength={80} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} className={input} /></label>
        <label className="min-w-0 text-sm">Plan name<input value={form.planName} maxLength={80} onChange={(e) => setForm({ ...form, planName: e.target.value })} className={input} /></label>
        {NUMBER_FIELDS.map(([key, label]) => (
          <label key={key} className="min-w-0 text-sm">{label}<input type="number" step="any" inputMode="decimal" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={input} /></label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={build} disabled={locked || !history} className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50">{busy ? "Building…" : "Build twin"}</button>
        <button type="button" onClick={loadSample} disabled={locked} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:border-brand-accent disabled:opacity-50">Load sample merchant</button>
      </div>
      {errors.length > 0 && <ImportErrors errors={errors} />}
    </details>
  );
}

export function ImportErrors({ errors }: { errors: ImportError[] }) {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
      <p className="font-medium">The import was not applied; the current twin is unchanged. Fix these and build again.</p>
      <ul className="mt-2 list-inside list-disc space-y-1 break-words">{errors.map((error, i) => <li key={i}>{formatImportError(error)}</li>)}</ul>
    </div>
  );
}

export function ImportedBanner({ session, disabled, onBack }: { session: ImportSession; disabled: boolean; onBack(): void }) {
  return (
    <section aria-label="Imported merchant" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/50 bg-surface p-4 text-sm">
      <div className="min-w-0">
        <p className="font-semibold">Imported: {session.summary.name} · simulate only</p>
        <p className="text-muted">Built from your CSV in this browser tab. Nothing was stored; reloading the page also returns to Ridgeline.</p>
        {session.classifierNotes.length > 0 && <ul className="mt-1 list-inside list-disc text-muted">{session.classifierNotes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </div>
      <button type="button" onClick={onBack} disabled={disabled} className="min-h-10 rounded-lg border border-border px-4 py-2 font-medium hover:border-brand-accent disabled:opacity-50">Back to Ridgeline</button>
    </section>
  );
}

export function DemoOnlyNotice() {
  return (
    <section aria-labelledby="demo-only-title" className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 text-sm sm:p-6">
      <h2 id="demo-only-title" className="text-lg font-semibold">Approval, pilots, annual offers and recovery</h2>
      <p className="mt-2 text-muted">{DEMO_ONLY_MESSAGE} Go back to Ridgeline to prepare, approve or recover PayPal Sandbox actions.</p>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/components/import-flow.test.ts src/components/ImportPanel.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/import-flow.ts src/components/import-flow.test.ts src/components/ImportPanel.tsx src/components/ImportPanel.test.ts
git commit -m "feat(ui): add the CSV import flow and panel"
```

---

### Task 20: Simulate-only headline and imported labels

**Files:**
- Modify: `src/components/headline.ts` (whole file)
- Modify: `src/components/comparison-model.ts`: `comparisonRows`
- Modify: `src/components/ScenarioGrid.tsx`: `toRows`
- Modify: `src/components/DecisionSummary.tsx`
- Modify: `src/components/EvidencePanel.tsx`
- Modify: `src/components/MerchantOverview.tsx`
- Modify: `src/import/sample-headline.test.ts`
- Test: `src/components/headline.test.ts`, `src/components/comparison-model.test.ts`, `src/components/DecisionSummary.test.ts`, `src/components/EvidencePanel.test.ts`, `src/components/MerchantOverview.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

In `src/components/headline.test.ts`, in "falls back to the highest simulated value …", change the expectation to:

```ts
    expect(headline).toEqual({ selectedId: "rise", recommended: false, simulateOnly: false, biggerLevers: [], alsoExecutable: [] });
```

and append inside the `describe`:

```ts
  it("treats an imported merchant as simulate-only: same pick, nothing executable", () => {
    const c = comparison(result("rise", priceRise, 61_792, .003), result("annual", annual, 10_268, 0, 8_866), result("save", saveOffer, 147, .385, 570));
    const imported = chooseHeadline(c, DEFAULT_DECISION_RULES, { simulateOnly: true });
    expect(imported).toMatchObject({ selectedId: "annual", recommended: true, simulateOnly: true, alsoExecutable: [] });
    expect(imported.biggerLevers.map((r) => r.strategy.id)).toEqual(["rise"]);
    expect(chooseHeadline(c)).toMatchObject({ selectedId: "annual", simulateOnly: false });
    expect(isExecutableIntervention(annual, { simulateOnly: true })).toBe(false);
    expect(isExecutableIntervention(saveOffer, { simulateOnly: true })).toBe(false);
    expect(isRecommendableIntervention(saveOffer) && isRecommendableIntervention(annual) && !isRecommendableIntervention(priceRise)).toBe(true);
  });
```

Change its import to `import { chooseHeadline, isExecutableIntervention, isRecommendableIntervention, whyNotExecutable } from "./headline";`.

Append to `src/components/comparison-model.test.ts`:

```ts
it("marks nothing executable for a simulate-only (imported) merchant", () => {
  const data = [result("b", "baseline"), result("x", "targeted_discount"), result("a", "annual_plan")];
  expect(comparisonRows(data, "b").candidates.map((r) => r.executable)).toEqual([true, true]);
  expect(comparisonRows(data, "b", { simulateOnly: true }).candidates.map((r) => r.executable)).toEqual([false, false]);
});
```

Append to `src/components/DecisionSummary.test.ts` (add `import { STARTER_STRATEGIES } from "@/merchant/candidates";` if missing; it is already imported):

```ts
it("labels an imported pick simulate-only and never offers PayPal wording", () => {
  const annualPick = { ...selected, strategy: STARTER_STRATEGIES[2] };
  const html = render({ ...baseProps, selected: annualPick, recommended: true, simulateOnly: true });
  expect(html).toContain("Best within your rules · simulated, not observed · simulate only");
  expect(html).toContain("Simulate only: PayPal actions are available for the demo merchant only.");
  expect(html).not.toContain("Recommended now");
  expect(html).not.toContain("Can be sent as an offer");
  const none = render({ ...baseProps, noQualifyingAction: true, simulateOnly: true });
  expect(none).toContain("No strategy meets the decision rules");
});
```

Append to `src/components/EvidencePanel.test.ts`:

```ts
it("shows an imported twin's own provenance and feedback, never Ridgeline's measured or annual evidence", () => {
  const zero = { price: 0, other: 0 };
  const annualEvidence = { offers: [{ segment: "core" as const, accepted: 1, declined: 0, unresolved: 1 }], changes: [], limitation: "Annual limitation." };
  const imported = {
    ...summary, observedEvidence: initialSnapshot.evidence, annualEvidence,
    provenance: { monthlyChurn: { source: "estimated", note: "Beta posterior per segment, estimated from your CSV (12 months)." } },
    imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 5, reasonCounts: { new: zero, core: zero, price_sensitive: zero, at_risk: zero, cancel_intent: { price: 4, other: 1 } } },
  } as MerchantSummary;
  const html = renderToStaticMarkup(createElement(EvidencePanel, { summary: imported, evidence: null, source: "manual", snapshot: null, liveAnnual: { annual: annualEvidence } }));
  expect(html).toContain("Imported CSV history · 2025-10 to 2026-09 (12 months)");
  expect(html).toContain("AI-classified from 5 uploaded feedback rows");
  expect(html).toMatch(/Cancel intent: 5 feedback rows · 4 price · 1 other/);
  expect(html).toContain("estimated from your CSV (12 months)");
  for (const absent of ["Measured sandbox outcomes", "annual-evidence-title", "snapshot unavailable", "Annual limitation."]) expect(html).not.toContain(absent);
  const noFeedback = renderToStaticMarkup(createElement(EvidencePanel, { summary: { ...imported, imported: { ...imported.imported!, feedbackRows: 0, reasonCounts: undefined } }, evidence: null, source: null, snapshot: null }));
  expect(noFeedback).toContain("No feedback imported");
});
```

Append to `src/components/MerchantOverview.test.ts`:

```ts
it("labels an imported merchant's history as its own CSV", () => {
  const html = renderToStaticMarkup(createElement(MerchantOverview, { summary: { ...summary, imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 0 } } }));
  expect(html).toContain("Imported CSV · 2025-10 to 2026-09");
  expect(html).toContain("estimates from your CSV");
  expect(html).not.toContain("Synthetic demo history");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/headline.test.ts src/components/comparison-model.test.ts src/components/DecisionSummary.test.ts src/components/EvidencePanel.test.ts src/components/MerchantOverview.test.ts`

Expected: FAIL on the new expectations.

- [ ] **Step 3: Replace `src/components/headline.ts`**

```ts
import { DEFAULT_DECISION_RULES, type DecisionRules } from "@/agent/contracts";
import type { Intervention } from "@/twin/interventions";
import type { ComparisonResult, StrategyResult } from "@/twin/simulate";

// The headline must be something the app can stand behind and act on: the best strategy this
// build can execute through PayPal within the decision rules. Higher-value strategies it can only
// simulate are disclosed beside it with the reason they are not the recommendation.
// An imported merchant (M6) uses the same pick rule, but nothing is executable for it.

/**
 * Kinds the headline may recommend: the kinds with a PayPal action for the demo merchant. List-price changes stay out
 * for every merchant, because price response is an unobserved assumption. Keep in step with `proposeStrategy`
 * (src/execution/annual-proposal.ts) and the agent's `recommend` tool.
 */
export const isRecommendableIntervention = (intervention: Intervention) => intervention.kind === "targeted_discount" || intervention.kind === "annual_plan";

export interface HeadlineOptions {
  /** An imported merchant: no PayPal action exists, so nothing is executable and the pick is simulate only. */
  simulateOnly?: boolean;
}
/** Executable through PayPal in this build: a recommendable kind, for the demo merchant only. */
export const isExecutableIntervention = (intervention: Intervention, options: HeadlineOptions = {}) => !options.simulateOnly && isRecommendableIntervention(intervention);
export const isExecutable = (r: StrategyResult, options: HeadlineOptions = {}) => isExecutableIntervention(r.strategy.intervention, options);

/** The discount budget governs retention discounts only; an annual prepay discount is netted in total value. */
const withinRules = (r: StrategyResult, rules: DecisionRules) =>
  r.probValueBelowBaseline <= rules.maxProbWorse &&
  (r.strategy.intervention.kind !== "targeted_discount" || r.metrics.discountCost.mean <= rules.discountBudget);

export interface Headline {
  selectedId: string | null;
  /** False when no recommendable strategy meets the rules; the selection is then context only. */
  recommended: boolean;
  /** True for an imported merchant: the pick is a simulate-only recommendation. */
  simulateOnly: boolean;
  /** Strategies the headline may not recommend (list-price changes) with a higher median value than the pick. */
  biggerLevers: StrategyResult[];
  /** Other executable strategies that also meet the rules, best first. Always empty when simulate only. */
  alsoExecutable: StrategyResult[];
}

export function chooseHeadline(comparison: ComparisonResult, rules: DecisionRules = DEFAULT_DECISION_RULES, options: HeadlineOptions = {}): Headline {
  const simulateOnly = options.simulateOnly === true;
  const ranked = comparison.strategies
    .filter((s) => s.strategy.id !== comparison.baselineId)
    .sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);
  const recommendable = (s: StrategyResult) => isRecommendableIntervention(s.strategy.intervention);
  const qualifies = (s: StrategyResult) => recommendable(s) && withinRules(s, rules);
  const pick = ranked.find(qualifies);
  if (!pick) return { selectedId: ranked[0]?.strategy.id ?? null, recommended: false, simulateOnly, biggerLevers: [], alsoExecutable: [] };
  return {
    selectedId: pick.strategy.id,
    recommended: true,
    simulateOnly,
    biggerLevers: ranked.filter((s) => !recommendable(s) && s.vsBaseline.totalValue.p50 > pick.vsBaseline.totalValue.p50),
    alsoExecutable: simulateOnly ? [] : ranked.filter((s) => s !== pick && qualifies(s)),
  };
}

export function whyNotExecutable(intervention: Intervention): string | null {
  switch (intervention.kind) {
    case "list_price_change":
      return "It changes the price for every subscriber at once, and how customers react to price is an assumption with no observed evidence. Test it on a small group before rolling it out.";
    case "annual_plan":
    case "baseline":
    case "targeted_discount":
      return null;
  }
}
```

- [ ] **Step 4: Pass the option through the grid rows**

In `src/components/comparison-model.ts`, change the import to `import { isExecutable, type HeadlineOptions } from "./headline";`, the signature to `export function comparisonRows(results: StrategyResult[], baselineId: string, options: HeadlineOptions = {}): { candidates: ScenarioRow[]; baseline: ScenarioRow | null } {`, and `executable: isExecutable(r),` to `executable: isExecutable(r, options),`.

In `src/components/ScenarioGrid.tsx`, add `import type { HeadlineOptions } from "./headline";` and replace `toRows`:

```ts
export function toRows(results: StrategyResult[], baselineId: string, options: HeadlineOptions = {}): ScenarioRow[] {
  const { candidates, baseline } = comparisonRows(results, baselineId, options);
  return baseline ? [...candidates, baseline] : candidates;
}
```

- [ ] **Step 5: Simulate-only wording in `src/components/DecisionSummary.tsx`**

Add `import { DEMO_ONLY_MESSAGE } from "@/import/messages";`. In `Props`, after `alsoExecutable?`, add:

```ts
  /** An imported merchant (M6): nothing is executable; the pick is simulate only. */
  simulateOnly?: boolean;
```

Add `simulateOnly = false` to the destructured parameters (after `alsoExecutable = []`). Then:
- replace `: recommended ? "Recommended now" : source === "manual" ? "Manual scenario" : "Selected scenario";` with `: recommended ? (simulateOnly ? "Best within your rules" : "Recommended now") : source === "manual" ? "Manual scenario" : "Selected scenario";`;
- replace `<p className="eyebrow">{label} · simulated, not observed</p>` with `<p className="eyebrow">{label} · simulated, not observed{simulateOnly ? " · simulate only" : ""}</p>`;
- replace the `noQualifyingAction` paragraph with:

```tsx
      {noQualifyingAction && <p className="mt-3 text-sm text-muted">{simulateOnly ? "No strategy meets the decision rules, so nothing is recommended." : "No executable strategy meets the decision rules, so nothing is recommended."} This is the highest simulated value, shown for context.</p>}
```

- replace the `!isExecutableIntervention(…)` paragraph with:

```tsx
      {!isExecutableIntervention(selected.strategy.intervention, { simulateOnly }) && <p className="mt-3 text-sm text-muted">Simulate only: {[simulateOnly ? DEMO_ONLY_MESSAGE : null, whyNotExecutable(selected.strategy.intervention)].filter(Boolean).join(" ") || "this strategy has no executable PayPal action in this build."}</p>}
```

- replace `{selected.strategy.intervention.kind === "annual_plan" && <p` with `{!simulateOnly && selected.strategy.intervention.kind === "annual_plan" && <p`.

The `alsoExecutable` block needs no change: the headline leaves it empty when simulate only.

- [ ] **Step 6: Imported labels in `src/components/EvidencePanel.tsx`**

Replace the four derived values at the top of `EvidencePanel` (`provenance`, `measured`, `changes`, `annual`) with:

```ts
  // An imported twin (M6) has its own provenance and never shows Ridgeline's measured or annual evidence.
  const imported = summary.imported;
  const provenance = imported ? summary.provenance : snapshot?.provenance ?? (source ? {} : summary.provenance);
  const measured = imported ? undefined : snapshot?.evidence ?? (source ? undefined : summary.observedEvidence);
  const changes = imported ? undefined : snapshot?.changes ?? (source ? undefined : summary.parameterChanges);
  const annual = imported ? undefined : liveAnnual?.annual ?? (snapshot ? snapshot.annual : source ? undefined : summary.annualEvidence);
```

Replace `<p className="mt-1 text-muted">Synthetic demo history · {summary.asOfMonth}</p>` with:

```tsx
          <p className="mt-1 text-muted">{imported ? `Imported CSV history · ${imported.firstMonth} to ${imported.lastMonth} (${imported.months} months)` : `Synthetic demo history · ${summary.asOfMonth}`}</p>
```

Replace `{classified ? <>` (the start of the feedback block's conditional) with `{imported ? <ImportedFeedback imported={imported} segments={summary.segments} /> : classified ? <>`.

Replace `{source && !snapshot && <p` with `{!imported && source && !snapshot && <p`.

Replace the footer paragraph's opening `<p className="mt-3 text-sm text-muted">{source === "manual" ?` with `<p className="mt-3 text-sm text-muted">{imported ? "Estimated from your CSV with merchant-entered economics; price sensitivity, annual uptake and discount effects stay assumptions. Simulate only." : source === "manual" ?`.

Add `import type { ImportedDetails } from "@/merchant/summary";` and, after `AnnualOfferEvidence`, this component:

```tsx
function ImportedFeedback({ imported, segments }: { imported: ImportedDetails; segments: MerchantSummary["segments"] }) {
  const counts = imported.reasonCounts;
  if (!counts || imported.feedbackRows === 0) return <p className="mt-1 text-muted">No feedback imported, so leaving reasons are unknown: price-reason targeting is unavailable and reason shares stay prior assumptions.</p>;
  return <>
    <p className="mt-1 text-muted">AI-classified from {imported.feedbackRows} uploaded feedback rows, before simulation</p>
    <ul className="mt-2 space-y-1">{segments.map((segment) => {
      const c = counts[segment.id];
      return <li key={segment.id}>{segment.label}: {c.price + c.other} feedback rows · {c.price} price · {c.other} other</li>;
    })}</ul>
    <p className="mt-2 text-muted">Feedback rows are a separate sample, not a share of the active population or proof that an offer caused retention.</p>
  </>;
}
```

- [ ] **Step 7: Imported labels in `src/components/MerchantOverview.tsx`**

Replace `<span className="source-badge">Synthetic demo history · {summary.asOfMonth}</span>` with:

```tsx
        <span className="source-badge">{summary.imported ? `Imported CSV · ${summary.imported.firstMonth} to ${summary.imported.lastMonth}` : `Synthetic demo history · ${summary.asOfMonth}`}</span>
```

and `Churn figures are estimates from synthetic history.` with `Churn figures are estimates from {summary.imported ? "your CSV" : "synthetic history"}.`

- [ ] **Step 8: Make the sample headline test assert simulate-only**

In `src/import/sample-headline.test.ts`, add `import { DEFAULT_DECISION_RULES } from "@/agent/contracts";`, change the sample's headline line to:

```ts
  const sampleHeadline = chooseHeadline(compareStrategies(built.twin, starterStrategiesFor(built.twin.params.listPrice), options), DEFAULT_DECISION_RULES, { simulateOnly: true });
```

and its expectation to:

```ts
  expect(sampleHeadline).toMatchObject({ selectedId: "at-risk-20-3m", recommended: true, simulateOnly: true, alsoExecutable: [] });
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `npx vitest run src/components src/import/sample-headline.test.ts && npm run typecheck`

Expected: PASS. `lab-state.ts` needs no change: its `chooseHeadline` call only reads `selectedId`, which does not depend on `simulateOnly`.

- [ ] **Step 10: Commit**

```bash
git add src/components/headline.ts src/components/headline.test.ts src/components/comparison-model.ts src/components/comparison-model.test.ts src/components/ScenarioGrid.tsx src/components/DecisionSummary.tsx src/components/DecisionSummary.test.ts src/components/EvidencePanel.tsx src/components/EvidencePanel.test.ts src/components/MerchantOverview.tsx src/components/MerchantOverview.test.ts src/import/sample-headline.test.ts
git commit -m "feat(ui): simulate-only headline and labels for imported twins"
```

---

### Task 21: Workspace per merchant in `Lab`

**Files:**
- Modify: `src/components/Lab.tsx`
- Test: `src/components/Lab.test.ts`

- [ ] **Step 1: Write the failing test**

`src/components/Lab.test.ts`:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { buildImportedTwin } from "@/import/imported-twin";
import { STARTER_STRATEGIES, starterStrategiesFor } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { summarizeMerchant } from "@/merchant/summary";
import { samplePayload } from "@/test/import-fixture";
import type { ImportSession } from "./import-flow";
import { Lab, Workspace } from "./Lab";

const built = buildImportedTwin(samplePayload());
if (!built.ok) throw new Error("The sample must build.");
const importedSummary = summarizeMerchant(built.twin, built.history, { imported: { months: built.months, firstMonth: built.firstMonth, lastMonth: built.lastMonth, feedbackRows: built.feedbackRows } });
const session: ImportSession = { id: 1, payload: samplePayload(), summary: importedSummary, starterStrategies: starterStrategiesFor(20), reasonTargeting: true, classifierNotes: ["40 of 40 rows classified."] };
const demo = buildDemoTwin();
const demoSummary = summarizeMerchant(demo.twin, demo.history);

it("renders Ridgeline with its PayPal panels and the import panel", () => {
  const html = renderToStaticMarkup(createElement(Lab, { summary: demoSummary, starterStrategies: STARTER_STRATEGIES, simulationRuns: 400 }));
  expect(html).toContain("Ridgeline Roasters · Roaster&#x27;s Choice (monthly) · synthetic demo");
  for (const shown of ["Pilot cohort in PayPal Sandbox", "Administrator access", "Restore a verified discount", "PayPal Sandbox:", "Use your own data"]) expect(html).toContain(shown);
  expect(html).not.toContain("Go back to Ridgeline");
});

it("renders an imported merchant simulate-only, with no PayPal panels", () => {
  const html = renderToStaticMarkup(createElement(Workspace, { summary: importedSummary, starterStrategies: session.starterStrategies, simulationRuns: 400, imported: session, onImported() {}, onBackToDemo() {} }));
  expect(html).toContain("Imported: Hollowbrook Treat Box · simulate only");
  expect(html).toContain("Back to Ridgeline");
  expect(html).toContain("Hollowbrook Treat Box · Treat Box (monthly) · imported CSV · simulate only");
  expect(html).toContain("PayPal actions are available for the demo merchant only. Go back to Ridgeline");
  expect(html).toContain("Ready to investigate. Imported merchant: simulate only, no PayPal action.");
  for (const hidden of ["Pilot cohort in PayPal Sandbox", "Administrator access", "Restore a verified discount", "PayPal Sandbox:"]) expect(html).not.toContain(hidden);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/Lab.test.ts`

Expected: FAIL: `Workspace` is not exported and `Lab` has no import panel.

- [ ] **Step 3: Split `Lab` into a holder and a per-merchant `Workspace`**

All edits are in `src/components/Lab.tsx`; anchors are quoted exactly.

(a) After `import { clampOfferWindowDays, DEFAULT_OFFER_WINDOW_DAYS, outcomeCells, proposalBody, reportColumns } from "./annual-offers-view";` add:

```tsx
import { DemoOnlyNotice, ImportedBanner, ImportPanel } from "./ImportPanel";
import type { ImportSession } from "./import-flow";
```

(b) Replace `export function Lab({ summary, starterStrategies, simulationRuns }: { summary: MerchantSummary; starterStrategies: Strategy[]; simulationRuns: number }) {` with:

```tsx
/**
 * Holds this tab's CSV import (M6). Each merchant gets a freshly mounted workspace (React `key`), so no comparison,
 * proposal or evidence crosses twins. Reloading the page drops the import and returns to Ridgeline.
 */
export function Lab({ summary, starterStrategies, simulationRuns }: { summary: MerchantSummary; starterStrategies: Strategy[]; simulationRuns: number }) {
  const [imported, setImported] = useState<ImportSession | null>(null);
  return (
    <Workspace
      key={imported ? `import-${imported.id}` : "demo"}
      summary={imported?.summary ?? summary}
      starterStrategies={imported?.starterStrategies ?? starterStrategies}
      simulationRuns={simulationRuns}
      imported={imported}
      onImported={setImported}
      onBackToDemo={() => setImported(null)}
    />
  );
}

export function Workspace({ summary, starterStrategies, simulationRuns, imported, onImported, onBackToDemo }: {
  summary: MerchantSummary; starterStrategies: Strategy[]; simulationRuns: number;
  /** Set for an imported merchant: simulate only, no PayPal reads or actions. */
  imported: ImportSession | null;
  onImported(session: ImportSession): void;
  onBackToDemo(): void;
}) {
```

(c) Replace the two mount effects:

```tsx
  useEffect(() => { void refreshPayPal(); }, [refreshPayPal]);
  useEffect(() => { api<AccessState>("/api/admin/session").then(setAccess).catch(() => setError("Administrator access unavailable.")); }, []);
```

with:

```tsx
  // Imported mode is simulate only: no PayPal status, annual offer, recovery or administrator reads.
  useEffect(() => { if (!imported) void refreshPayPal(); }, [refreshPayPal, imported]);
  useEffect(() => { if (!imported) api<AccessState>("/api/admin/session").then(setAccess).catch(() => setError("Administrator access unavailable.")); }, [imported]);
```

(d) In `simulate`, replace:

```tsx
      const { observedSnapshot, ...comparison } = await api<ObservedComparison>("/api/simulate", { method: "POST", body: JSON.stringify({ strategies: starterStrategies }) });
      dispatch({ type: "comparison", comparison, source: "manual", observedSnapshot: ObservedSnapshotSchema.parse(observedSnapshot) });
```

with:

```tsx
      // An imported twin is rebuilt server-side from the payload on every request and has no observed snapshot.
      const { observedSnapshot, ...comparison } = await api<ObservedComparison>("/api/simulate", { method: "POST", body: JSON.stringify(imported ? { strategies: starterStrategies, import: imported.payload } : { strategies: starterStrategies }) });
      dispatch({ type: "comparison", comparison, source: "manual", observedSnapshot: imported ? undefined : ObservedSnapshotSchema.parse(observedSnapshot) });
```

(e) Replace:

```tsx
  const headline = comparison ? chooseHeadline(comparison, (comparisonSource === "agent" ? rules : null) ?? DEFAULT_DECISION_RULES) : null;
```

with:

```tsx
  const headline = comparison ? chooseHeadline(comparison, (comparisonSource === "agent" ? rules : null) ?? DEFAULT_DECISION_RULES, { simulateOnly: !!imported }) : null;
```

and:

```tsx
  const rows = useMemo(() => (comparison ? toRows(comparison.strategies, comparison.baselineId) : []), [comparison]);
```

with:

```tsx
  const rows = useMemo(() => (comparison ? toRows(comparison.strategies, comparison.baselineId, { simulateOnly: !!imported }) : []), [comparison, imported]);
```

(f) Replace `const executable = !!selected && isExecutableIntervention(selected.strategy.intervention);` with `const executable = !!selected && isExecutableIntervention(selected.strategy.intervention, { simulateOnly: !!imported });`.

(g) Replace `<p className="text-sm text-muted">{summary.name} · {summary.planName} · synthetic demo</p>` with `<p className="text-sm text-muted">{summary.name} · {summary.planName} · {imported ? "imported CSV · simulate only" : "synthetic demo"}</p>`, and the PayPal badge:

```tsx
        <span
          className={`source-badge ${paypal?.configured ? "text-positive" : "text-muted"}`}
        >
          PayPal Sandbox: {paypal ? (paypal.configured ? "connected" : "not configured") : "checking…"}
        </span>
```

with:

```tsx
        {imported ? <span className="source-badge text-muted">PayPal actions: demo merchant only</span> : (
          <span className={`source-badge ${paypal?.configured ? "text-positive" : "text-muted"}`}>
            PayPal Sandbox: {paypal ? (paypal.configured ? "connected" : "not configured") : "checking…"}
          </span>
        )}
```

(h) Replace `<AdminAccess state={access} onChange={(value) => { setAccess(value); setAccessEpoch((epoch) => epoch + 1); setConfirmed(false); }} />` with:

```tsx
      {imported ? <ImportedBanner session={imported} disabled={busy !== null} onBack={onBackToDemo} /> : <AdminAccess state={access} onChange={(value) => { setAccess(value); setAccessEpoch((epoch) => epoch + 1); setConfirmed(false); }} />}
```

(i) In the `<DecisionSummary … />` line, replace `alsoExecutable={isHeadlinePick ? headline.alsoExecutable : []} onSelect=` with `alsoExecutable={isHeadlinePick ? headline.alsoExecutable : []} simulateOnly={!!imported} onSelect=`.

(j) Replace `<AgentPanel objective={objective} disabled={busy !== null} onStart={startAgent} onEvent={agentEvent} onFinish={finishAgent} />` with `<AgentPanel objective={objective} disabled={busy !== null} importPayload={imported?.payload ?? null} onStart={startAgent} onEvent={agentEvent} onFinish={finishAgent} />`.

(k) Replace `<div className="mb-6"><MerchantOverview summary={summary} /></div>` with:

```tsx
      <div className="mb-6"><MerchantOverview summary={summary} /></div>
      <div className="mb-6"><ImportPanel disabled={busy !== null} onImported={onImported} /></div>
```

The panel stays available while an import is active, so a broken upload can be shown to leave the imported twin unchanged.

(l) Replace `{selected && selected.strategy.id !== comparison?.baselineId && (` with `{!imported && selected && selected.strategy.id !== comparison?.baselineId && (`, and `{report && (` with `{!imported && report && (`.

(m) Immediately before the line `      <AnnualOffersPanel` insert:

```tsx
      {imported ? <DemoOnlyNotice /> : (<>
```

and replace the pilot cohort section's closing lines (the only place `</section>` is directly followed by `</main>`):

```tsx
      </section>
    </main>
```

with:

```tsx
      </section>
      </>)}
    </main>
```

The annual offers panel, recovery panel and pilot cohort table are now not mounted for imports, so their fetches never run.

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npx vitest run src/components && npm run typecheck && npm run lint`

Expected: PASS. ESLint's `react-hooks/exhaustive-deps` is satisfied by the `imported` dependencies added in (c) and (e).

- [ ] **Step 5: Commit**

```bash
git add src/components/Lab.tsx src/components/Lab.test.ts
git commit -m "feat(ui): workspace per merchant with a simulate-only import mode"
```

---

### Task 22: Decision record, architecture and README

**Files:**
- Create: `docs/decisions/0009-csv-import.md`
- Modify: `docs/architecture.md` (LF)
- Modify: `README.md` (LF)

- [ ] **Step 1: Write the decision record**

`docs/decisions/0009-csv-import.md`:

```markdown
# 0009: CSV import as a simulate-only, stateless twin

**Status:** accepted (M6). Spec: `docs/superpowers/specs/2026-11-01-m6-csv-import-design.md`. Plan: `docs/superpowers/plans/2026-11-01-m6-csv-import.md`.

## Context

M6 lets a merchant upload monthly subscriber history (and optional cancellation feedback) and get a twin estimated from it, with the same simulation, agent and evidence views as the demo merchant. PayPal actions are tied to Ridgeline's registered Sandbox pilots, so an imported merchant cannot act.

## Decision

- **Stateless rebuild.** The browser keeps the validated import in memory and sends it with each validate, simulate and agent request; the server re-validates it and rebuilds the twin for that request. Nothing about the upload is stored, logged or exported. Reloading the page returns to Ridgeline.
- **Shared builder.** `buildTwinFromHistory` (`src/twin/build-twin.ts`) holds the estimation that used to live in `buildDemoTwin`; a byte-for-byte golden fixture proves Ridgeline's twin is unchanged.
- **History semantics.** `active_start` excludes the month's signups; signups join `new` and are exposed to that month's churn. For `new` rows the capacity rule includes that month's signups.
- **Simulate only.** Imported simulate and agent requests never call `observedMerchant` (discount outcomes and annual-offer evidence belong to Ridgeline's pilots), never create proposals or annual offers, and never reach PayPal. `POST /api/proposals` refuses any body with an `import` field. The agent's `recommend` records a simulate-only recommendation (`recommendation` event).
- **Headline.** The pick rule is the same for both merchants: retention discounts and annual plans within the decision rules; list-price changes stay simulate-only levers because price response is unobserved. For imports nothing is labelled executable, `alsoExecutable` is empty, and the pick reads "Best within your rules · simulate only".
- **Feedback.** Optional, at most 200 rows, classified by the existing classifier behind the agent admission limit and the agent lease, with a 300 s deadline that returns partial counts. Imports never write the persistent `feedback_prediction_cache` (which holds hashed keys and labels, never text, but travels in ledger exports); a bounded process-memory cache with the same hashed keys and labels only is read first. Without feedback, price-reason targeting is unavailable.
- **Sample merchant.** "Hollowbrook Treat Box" (synthetic, seed 7311, 12 months, 40 feedback rows). With its feedback classified as labelled, the pick is "At-risk: 20% off for 3 months" (Ridgeline's is "Annual prepay at 15% off"); without feedback the annual plan narrowly leads.

## Consequences

- The client's row numbers are physical CSV lines; the server numbers payload rows as index + 2. They agree for files without blank lines or multi-line cells.
- A classification on the hosted demo takes about a minute per 20 rows at the default Gemini rate profile and shares the agent's hourly limit.
- Saving, sharing or syncing imported merchants, PayPal actions for them, and estimating price sensitivity from a CSV remain out of scope.
```

- [ ] **Step 2: Update `docs/architecture.md`**

In the module table, replace the Merchant row with:

```markdown
| Merchant | `src/merchant/` | Builds the twin for the current merchant (today: synthetic Ridgeline Roasters history → estimated parameters + labelled priors) through the shared builder in `src/twin/build-twin.ts`; `summary.ts` builds the overview for Ridgeline and for imports. | twin |
| Import | `src/import/` | Pure CSV import (M6): minimal CSV reader, history and feedback parsers with per-row errors, economics schema, strict size-capped payload, imported twin builder and the synthetic Hollowbrook sample. No server-only imports. | twin, merchant (candidates) |
```

In the Agent row, append to the responsibility text: ` Imported merchants run simulate-only: no observed evidence, no registry reads, and recommend emits a recommendation instead of a proposal.`

Directly above `## Agent run and timeline (M3)`, add:

```markdown
## CSV import (M6)

Decision: `docs/decisions/0009-csv-import.md`.

1. The browser parses the history (and optional feedback) CSV and the economics form locally for instant per-row errors (`src/components/import-flow.ts`).
2. Feedback rows go to `POST /api/import/classify` (agent admission limit, agent lease, 300 s budget, memory-only cache) and come back as per-segment `{ price, other }` counts and notes. Text is never stored.
3. `POST /api/import/validate` (preparation limit) re-validates the payload `{ rows, economics, reasonCounts? }`, builds the twin and returns a `MerchantSummary` with `imported` details.
4. The `Lab` remounts a `Workspace` for the imported merchant. Simulate and agent requests carry the payload; the server rebuilds the twin per request and never reads Ridgeline's observed evidence. Approval, annual offers, recovery, pilots and administrator sign-in are not mounted; one notice says "PayPal actions are available for the demo merchant only."
5. "Back to Ridgeline" or a reload returns to the demo merchant.
```

- [ ] **Step 3: Update `README.md`**

Directly above `## Feedback provider evaluation`, add:

```markdown
## Use your own data

Open **Use your own data** under the merchant snapshot. Download the history template (or the sample "Hollowbrook Treat Box" files), upload your monthly history and, optionally, up to 200 rows of cancellation feedback, check the prefilled unit economics, and choose **Build twin**. Errors are reported per row and column, and nothing changes until the whole import is valid.

The imported twin is **simulate only**: comparisons, the agent and the evidence panel work on it, but PayPal actions stay with the demo merchant. Your files stay in the browser tab; the server re-checks them on every request and stores nothing. Feedback text is sent to the configured classifier only. Reload the page or choose **Back to Ridgeline** to return to the demo.

The sample files are generated by `npm run samples:generate` (deterministic; a test compares them with the generator).
```

- [ ] **Step 4: Check the docs**

Run: `npm run lint && git diff --stat`

Expected: lint passes; the diff touches only the three documents. No user-specific paths, secrets or links beyond repository-relative paths.

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/0009-csv-import.md docs/architecture.md README.md
git commit -m "docs(m6): record CSV import decisions and usage"
```

---

### Task 23: Local acceptance

**Files:**
- Modify: `docs/current-state.md` (CRLF), through the usual handoff commit only

- [ ] **Step 1: Full gates and a production build**

```bash
npm run build:workers
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run build
```

Expected: all pass. Record the test count (baseline + the new tests).

- [ ] **Step 2: Start the app without AI or PayPal calls**

Start the dev server through the preview tooling (`.claude/launch.json` entry running `npm run dev`, port 3001), or `npm run dev` in a terminal. Do not add AI or PayPal credentials for this step. If `.env.local` already holds AI keys, do not load the sample with feedback in Steps 3–7: feedback classification would call the provider.

- [ ] **Step 3: Browser check: a broken file leaves Ridgeline unchanged**

At `http://localhost:3001`:
1. The header reads "Ridgeline Roasters · Roaster's Choice (monthly) · synthetic demo".
2. Open **Use your own data**, download the template, upload it as the history file and choose **Build twin**.
3. Expected: an alert with "History file · month: at least 6 consecutive months are required (found 1)" and "the current twin is unchanged"; the header still names Ridgeline; the network panel shows no request to `/api/import/*`.

- [ ] **Step 4: Browser check: the sample without feedback**

1. Choose **Load sample merchant**, then **Remove** next to the feedback file, then **Build twin**.
2. Expected: one `POST /api/import/validate` (200) and no `/api/import/classify`; the banner "Imported: Hollowbrook Treat Box · simulate only" with "Back to Ridgeline"; the header "… · imported CSV · simulate only"; the PayPal badge reads "PayPal actions: demo merchant only"; the demo-only notice replaces annual offers, recovery and the pilot cohort; no administrator sign-in.
3. Choose **Simulate strategies**. Expected: four candidates (no price-reason save); the headline reads "Best within your rules · simulated, not observed · simulate only". Decision 13 expects "Annual prepay at 15% off" here, by a hair at the local 1,000 futures (+$2,822 against +$2,805 for the at-risk discount); this step checks the labels, so either pick passes, but record which one and both medians; the grid shows "Simulate only" on every row; there is no Approval section; the evidence panel says "Imported CSV history · 2025-10 to 2026-09 (12 months)" and "No feedback imported".
4. In the network panel, after the import there are no `/api/paypal/status`, `/api/admin/session`, `/api/annual-offers/links` or `/api/proposals*` requests.

- [ ] **Step 5: Browser check: a broken file while imported, then back**

1. While imported, upload the template again as history and **Build twin**. Expected: the per-row error; the banner still names Hollowbrook; the comparison is unchanged.
2. Choose **Back to Ridgeline**. Expected: Ridgeline's header, administrator access, pilot cohort and a fresh `/api/paypal/status` read; no comparison carried over.
3. Import the sample again (without feedback), then reload the page. Expected: Ridgeline.

- [ ] **Step 6: Responsiveness, console and logs**

1. At 375 px width: no horizontal scroll with the import panel open and while imported.
2. The browser console has no errors.
3. The dev server log contains no CSV cell, merchant name or feedback text from the upload (search it for `Hollowbrook` and for a sample feedback sentence; expect no match).

- [ ] **Step 7 (optional, needs Jethro's explicit approval in chat): the sample with feedback**

Only if Jethro approves an AI provider call from this machine, with `AI_PROVIDER` and a key configured in `.env.local`: load the sample with feedback and build. Expected: one `POST /api/import/classify` (40 rows, two batches; at the default Groq or Gemini profile this takes about a minute), the banner lists the classifier notes, and **Simulate strategies** headlines "At-risk: 20% off for 3 months" as "Best within your rules · simulate only". Record the classified counts. If the classifier labels differ enough to change the pick, record the counts and the comparison and stop.

- [ ] **Step 8: Handoff**

Record in `docs/current-state.md` (CRLF): the gates and test count, what Steps 3–6 (and 7, if run) showed, and "next: Task 24 needs Jethro's approval to push, merge and deploy". Commit as `docs: record M6 Task 23`.

---

### Task 24: Hosted acceptance (human-gated)

**Files:**
- Modify: `docs/current-state.md` (CRLF), `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md` (CRLF)

- [ ] **Step 1: Ask before anything leaves this machine**

Ask Jethro in chat, and wait for an explicit yes, to: push `feat/m6-csv-import`, open a pull request, merge it into `main` (fast-forward, as for M7) and let Render deploy. Name the branch, the commit range (`git log --oneline origin/main..HEAD`) and the test count. Do nothing in Steps 2–5 without that approval.

- [ ] **Step 2: Push, pull request, CI, merge**

```bash
gh auth status
git push -u origin feat/m6-csv-import
gh pr create --base main --head feat/m6-csv-import --title "feat: CSV import (M6)" --body "Simulate-only CSV import: parsers, shared twin builder (Ridgeline unchanged), import validate and classify routes, imported simulate and agent runs (no observed evidence, no proposals or offers), import panel and simulate-only labels. Plan: docs/superpowers/plans/2026-11-01-m6-csv-import.md. Decision: docs/decisions/0009-csv-import.md."
gh pr checks --watch
```

Expected: `gh auth status` shows `jephoton`; CI passes on Linux. Then, as Jethro directs:

```bash
git checkout main
git merge --ff-only feat/m6-csv-import
git push origin main
```

Confirm the Render deploy finished (Render dashboard or the deploy hook output Jethro shares).

- [ ] **Step 3: Hosted browser check**

At `https://aurrery.onrender.com/` (allow about 35 seconds for a cold wake):
1. Ridgeline still headlines "Annual prepay at 15% off" as "Recommended now" after **Simulate strategies** (hosted Ridgeline uses its observed evidence; record the headline if it differs).
2. **Use your own data** → **Load sample merchant** (with feedback) → **Build twin**. Expected: `POST /api/import/classify` returns 200 (two batches, up to about two minutes), then `POST /api/import/validate` returns 200; the banner shows the classifier notes.
3. **Simulate strategies** (400 futures). Expected: "At-risk: 20% off for 3 months" headlined as "Best within your rules · simulated, not observed · simulate only" (decision 13: about +$3,500 median, about $890 discount cost), different from Ridgeline's headline; the evidence panel shows "AI-classified from N uploaded feedback rows" with the at-risk segment mostly price; every grid row reads "Simulate only"; the demo-only notice replaces the PayPal panels.
4. Optional, uses one of the agent's three hourly runs: **Run agent** on the imported twin. Expected: the activity log ends with "Recommended (simulate only): …" and the demo-only notice; no "Proposed:" entry.
5. Upload the template as history. Expected: per-row error; the imported twin is unchanged.
6. **Back to Ridgeline**, then reload: Ridgeline, with its pilot cohort and PayPal status.
7. 375 px width has no horizontal scroll; the console has no errors.

If the hosted classifier labels the sample differently enough to change the pick, record the classified counts and the comparison and stop: do not tune the sample.

- [ ] **Step 4: Record acceptance**

Add an "M6 hosted acceptance" entry to `docs/current-state.md` (gates, CI run, deploy, what Step 3 showed, classified counts) and mark M6 done in the roadmap's milestone table. Normalize both files to CRLF and commit:

```bash
git add docs/current-state.md docs/superpowers/plans/2026-10-22-aurrery-roadmap.md
git commit -m "docs: record M6 hosted acceptance"
```

Push this commit to `main` only with Jethro's approval from Step 1 or a fresh one.

---

## Self-review

Run against the spec after writing; fixes are already folded into the tasks above.

1. **Spec coverage.** Every spec section maps to a task in "Spec coverage". Notable points:
   - Simulate-only for imports is enforced in four places: simulate route (Task 12), agent tools and run (Tasks 16–17), proposals route (Task 12, decision 19) and UI (Tasks 20–21). The headline never calls an imported strategy executable (decision 10, Task 20).
   - "Never reads the ledger's observed evidence" is tested for both readers that `observedMerchant` uses: discount outcomes and annual offers (Tasks 12 and 17).
   - The spec's "different, explained recommendation" depends on classified feedback (decision 13). Tests prove it with the intended labels (Task 10, Task 20); the hosted check proves it with the live classifier (Task 24).
   - The cache check the spec asks for is recorded in decision 6 and decision record 0009.
2. **Placeholder scan.** No "TBD", "TODO", "similar to Task N" or code-free code steps. Conditional instructions (stop if the headline differs, ask before pushing, optional AI step) state exactly what to do.
3. **Type and name consistency.** `RowError`, `ParseResult`, `HistoryRow`, `HistoryTuple`, `ImportPayload`, `ReasonCounts`, `ImportedContext`, `ImportedRun`, `ImportSession`, `ImportError`, `MerchantSummary.imported` (`ImportedDetails`), `HeadlineOptions`, `isRecommendableIntervention`, `isExecutableIntervention(intervention, options)`, `chooseHeadline(comparison, rules, options)`, `comparisonRows`/`toRows(…, options)`, `createBudgetedClassifier(config, budget, { onLimit })`, `createMemoryPredictionCache`, `importPredictionCache`, `classifyImportedFeedback`, `createClassifyHandler`, `payloadIssues`, `invalidImportResponse`, `reasonUnavailableResponse`, `demoOnlyResponse`, `DEMO_ONLY_MESSAGE`, `REASON_UNAVAILABLE_MESSAGE` and `CONTROL_CHARACTER_MESSAGE` are each defined once and used with the same signature everywhere.
4. **Current-tree check.** Paths, line ranges and quoted anchors were checked against `feat/m6-csv-import` at `2b595a1` (post-M7): `demo.ts` lines 1–102 above `WEAK_RATE_PRIOR`; `Lab.tsx` imports at lines 9–12 and `MerchantSummary` at 29–43; `run.ts` classifier block at lines 82–91; `tools.ts`, `http.ts`, `stream.ts`, `contracts.ts`, `headline.ts`, `comparison-model.ts`, `EvidencePanel.tsx`, `DecisionSummary.tsx` and `MerchantOverview.tsx` anchors as quoted. Tasks 9 and later quote content, not line numbers, wherever an earlier task shifts lines.

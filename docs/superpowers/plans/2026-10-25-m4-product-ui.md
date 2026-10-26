# M4 product UI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, one implementer followed by independent spec then quality review.

**Goal:** Deliver the approved navy/gold orbit workspace with trustworthy decision/source labels, polished comparisons and unchanged exact-payload approval.

**Architecture:** Preserve Lab orchestration and existing server contracts. Present computed typed results through focused components, extending reducer retention only for rules/stress that the UI needs. AG Grid stays Community; use family filters/labels and a pinned baseline rather than enterprise grouping.

**Tech Stack:** Next.js 16.4.2, React 19, TypeScript, Tailwind 4, AG Grid Community 36, SVG, Vitest.

Design: `docs/superpowers/specs/2026-10-25-m4-product-ui-design.md`. Work on `feat/m4-product-ui`; reuse the current checkout and ignored local setup. Do not approve/execute/send, read credentials, run live provider calls from implementer agents or change model/provider/server behavior.

## Task 1: Typed decision and evidence presentation

Files: `src/components/lab-state.ts`, `lab-state.test.ts`; new `DecisionSummary.tsx`, `EvidencePanel.tsx` and meaningful rendering tests; integrate in `Lab.tsx`. Update architecture/current state after completion.

- [x] Add RED reducer cases for retaining rules/matching stress and invalidating stale stress on classification/rule/comparison revisions/new run. Keep objective/selection review invalidation. A stress event without a current matching strategy must not become headline evidence.
- [x] Extend state with `rules: DecisionRules | null` and `stress: Extract<AgentEvent,{type:"stress"}> | null`. Reset stress whenever comparison/evidence/rules are replaced; retain only stress whose strategy belongs to the current comparison. Present stress only for the selected ID.
- [x] Add RED rendering checks using computed results whose mean differs from median: expected value uses `.vsBaseline.totalValue.mean`; median uses `.p50`; interval `.p10/.p90`; risk `.probValueBelowBaseline`; cost `.metrics.discountCost.mean`. Verify selected/manual/scenario versus actual proposal labels and review anchor without approval control.
- [x] Add `DecisionSummary` with typed selected result, optional matching proposal/rules/stress, horizon/source and busy state. Display non-recommendation/empty/simulate-only/status variants honestly. Review link targets `#approval` only for the currently shown proposal; no approval/preparation callbacks.
- [x] Add `EvidencePanel` with summary segment population and optional current classification counts as distinct datasets, synthetic source labels and provenance badges. Test 18 active versus 42 records (21/21) as separate labelled values; model commentary is not the source of metrics.
- [x] Integrate components into existing Lab without changing API calls, winner selection or payload controls. Preserve no-secrets client boundary. Use existing theme tokens pending Task 2.
- [x] Run focused tests, typecheck, zero-warning lint, update handoff; atomic commit. Independent spec then quality review before Task 2.

## Task 2: Navy/gold workspace and orbit hierarchy

Files: `src/app/globals.css`, `src/components/Lab.tsx`, `AgentPanel.tsx`, new `MerchantOverview.tsx` and optional small brand SVG; presentational components from Task 1. Read installed Next.js CSS/client guides first. Update architecture/current state.

- [x] Implement ink/navy/surface/off-white/muted/gold/green/coral tokens in the existing Tailwind theme. Set strong body contrast, visible focus, wrapping and reduced-motion rules. Keep existing fonts and avoid dependencies.
- [x] Compose header, merchant overview, prominent decision/objective area, activity, scenario/trajectory/evidence and approval in the design's order. Initial state has no invented recommendation. Keep manual simulation visible and busy/Stop semantics unchanged.
- [x] Build a restrained static orbit visual from summary counts plus an accessible segment list; orbital distances do not encode invented risk. Use clear synthetic-history/estimated-churn labels and responsive reflow.
- [x] Style the agent log as activity; keep genuine model commentary text escaped and secondary to typed evidence. Do not hide errors or claim model prose is verified. Ensure request/stop controls remain discoverable.
- [x] Add `id="approval"` to the existing exact-action region and visible heading context. Retain checkbox/disabled execution/status/targets/hash; make long IDs and PayPal/report tables responsive. Remove prominent raw operation jargon only by placing it in an accessible details block, preserving exact review information.
- [x] Check relevant existing rendering/session tests, add only tests for changed behavior/semantics. Run typecheck/lint, update handoff and commit. Independent spec then quality review before Task 3.

## Task 3: Comparison, interval and trajectory polish

Files: `src/components/ScenarioGrid.tsx`, new focused grid/interval helpers/tests if needed, `FanChart.tsx`/tests; Lab integration if required. Use documented installed/community APIs.

- [x] Add RED meaningful tests for family mapping, baseline uniqueness, shared interval domain, zero-crossing/all-negative/degenerate finite geometry and numeric accessible labels. Map intervention kinds to Retention / Annual / Pricing / Baseline; no ID-name heuristics.
- [x] Add family filter buttons/labels using Community-compatible filtering and one `pinnedBottomRowData` baseline excluded from ordinary rows. Baseline is comparison context, not an executable recommendation; retain clear baseline access. Filters never silently change selected scenario/proposal. Do not enable enterprise modules or install a license.
- [x] Render intervals on a common zero-inclusive domain with median point, zero marker and numeric p10/p90 text/label; retain sorting on numeric median and full risk/cost/capability columns. All numbers stay computed.
- [x] Wire documented keyboard selection through selection events with a guard against redundant parent updates. Programmatic reselection must not erase a valid proposal; pinned baseline must not pretend to be a candidate. Preserve disabled/inert behavior.
- [x] Keep desktop first-column usefulness without trapping narrow/mobile viewports; grid scroll stays local and selected scenario details remain readable outside it.
- [x] Restyle fan chart to match the workspace: gold candidate, dashed baseline, legible axes/legend, honest band, numeric accessible description and valid empty/one-point handling. No fabricated trajectory or quantile changes.
- [x] Run focused tests/typecheck/lint, handoff update and atomic commit. Independent spec then quality review.

## Task 4: Parent acceptance, publication and handoff

- [x] Resolve the numerical annual-stress blocker found during the parent browser check: bounded tiny-positive binomial RED tests and a bounded three-segment/1,000-run annual RED reproduction preceded the `log1p(-p)` fix. Focused tests, both genuine provider replays, full serial suite, typecheck, zero-warning lint and canonical starter values pass; see `docs/current-state.md`. No simulation assumptions or recordings changed.
- [x] Parent independently review the numerical fix, rebuild the owned server and repeat the real Gemini annual comparison/stress/proposal browser flow before M4 acceptance.
- [x] Run full serial tests, typecheck, zero-warning lint and production build with the owned server stopped. Scan tracked files for configured secrets/personal paths. Request final integrated review.
- [x] Rebuild/restart owned server on 3001 and verify in CUA browser: initial state, manual comparison, family filters, pinned baseline, keyboard selection, responsive layout, typed mean/median and separate feedback/population counts, review navigation and no approval. Check real agent progress/comparison/stress/proposal, Stop/error behavior, exact A/B-only $18 payload with unchecked confirmation and disabled execution. Never approve/reject/execute/send during QA.
- [x] Save useful ignored screenshots for desktop and narrow layouts, check console/runtime errors and fresh read-only PayPal status/ledger counts. Record failures honestly and fix/re-review any actionable issues.
- [x] Update measured M4 report, architecture/current state/roadmap; mark M4 done only when browser and review checks pass. Merge fast-forward, perform required merged-main check, push and verify refs. M5 follows; hosting is not M4.


<!-- Generated local acceptance, 2026-10-26. -->

All source tasks, review corrections and local production-browser acceptance passed at the `e194c25` application checkpoint: 454 tests/38 files, typecheck, zero-warning lint, production build and 143-file hygiene scan. Final live default-objective Gemini flow completed with typed comparison/stress and A/B-only $18 proposal, confirmation unchecked and execution disabled. Numerical `log1p`, interval-role, risk-precision, chart-label and responsive-order fixes each passed independent review. Historical recordings/priors remain unchanged. M5 hosting is next; see the measured report for observed limitations. Publication passed: all 454 tests passed on merged main and matching main/M4 remote refs were verified at `7178738` before the following documentation-only publication note.

- [x] Verify M4 main/branch remote refs and record publication.

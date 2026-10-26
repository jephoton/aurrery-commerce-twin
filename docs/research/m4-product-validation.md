# M4 product UI validation

<!-- Generated task record; acceptance is pending until measured below. -->

## Scope and baseline

M4 starts from published M3 at `3aedae3` on `feat/m4-product-ui`. The user explicitly chose dark navy with restrained gold accents and orbit-inspired subscriber visuals. The [design](../superpowers/specs/2026-10-25-m4-product-ui-design.md) and [task plan](../superpowers/plans/2026-10-25-m4-product-ui.md) preserve simulation, classification, provider limits and exact-payload approval.

The parent captured the real existing production UI at 1440×1000 using the supported browser viewport capability. Ignored baseline screenshot: `data/m4-browser/before-desktop.jpg`. The in-app browser's existing 559px viewport is also available. A separate Chrome QA tab supports explicit desktop/mobile breakpoints; temporary overrides must be reset after QA. No approval, execution or rejection was performed.

## Acceptance requirements

The decision summary must name mean/expected and median separately from typed results. Feedback record counts must remain distinct from current active subscriber counts. A headline review link must navigate to the exact-action panel without preparing, confirming or executing an action. Scenario selection, new runs, changed evidence/rules and Stop must preserve stale-state protections. Matching adverse stress remains visible.

Verify the selected theme, meaningful orbit overview, Community-compatible family controls/pinned baseline, common-scale interval cells, accessible trajectories and provenance at desktop and 360px. Record actual browser interactions, automated checks, independent reviews, screenshots and any limitations below. Hosting remains M5; local production acceptance cannot establish hosted acceptance.

## Current result

Implementation is in progress. No M4 completion or publication is claimed yet. Prior M3 421-test/build acceptance remains the baseline, with narrative wording limitations preserved in its genuine recordings.

## Task 1 review findings

The initial typed-summary/evidence implementation at `36609b9` passed 23 focused component tests, typecheck and zero-warning lint. Spec review found that classification incorrectly cleared explicit UI rules even though the server preserves them. The correction must keep rules while invalidating comparison/stress/review and test rules → classification → comparison ordering.

Parent inspection also identified that manually preparing an action after an agent comparison inherited the comparison's agent label. Manual preparation uses canonical estimates, potentially with a different horizon, while the classified comparison is separate. Track proposal origin independently, keep headline scenario statistics bound to their own source, explain the separately prepared canonical action and preserve origin on same-ID status updates. No provider, model, simulation or approval change is required. These corrections require re-review before the next task.

Both findings were corrected in `f1fbd34` with regressions observed failing first. Classification preserves explicit rules; proposal origin is distinct from comparison source, including matching status updates/reports. Independent spec re-review and quality review both passed (25 focused tests each). Parent verification passed all 28 component tests across six files. Implementer typecheck, zero-warning lint and diff checks passed. No live calls or production build were performed for Task 1; visual/browser acceptance remains pending after subsequent tasks.

## Task 2 workspace checkpoint, 2026-10-26

`321af7f` composes the selected navy/gold workspace, one dynamic h1, actual merchant counts with decorative orbits, readable mobile segment lists, secondary public activity and exact approval details. Independent spec and quality reviews passed. Thirteen focused tests, typecheck and zero-warning lint passed. Source-badge status text remains explicit; quality review noted that its unlayered muted colour overrides utility status colours, a nonblocking visual detail.

The first parent production build passed but emitted the previous blue/white CSS (`1kt4_ii8q3492.css`), despite the new source stylesheet. The browser showed the new component structure with the old theme. Read-only inspection confirmed both the built artifact and browser CSS variable were old, ruling out browser-only caching. With the owned server stopped, the parent moved only the resolved workspace `.next/cache/turbopack` directory into ignored diagnostic storage and rebuilt. The new CSS (`2bwyjbr-tf9v9.css`) contained the navy variables and orbit rules; the browser then reported `--background: #090f1b`. No source/configuration change was used to hide this cache discrepancy.

Both builds passed. Recovery for the observed stale-build case is to stop the owned server, move the generated `.next/cache/turbopack` aside to a fresh ignored diagnostic directory within the repository, run `npm run build`, restart on 3001 and reload. Verify emitted CSS and the actual browser theme before claiming visual acceptance. This records an observed local cache issue, not a proven general framework defect.

At requested 1440×1000 and 360×800 viewports, initial-state screenshots showed the navy/gold design and no page-wide horizontal overflow (client/scroll widths 1425/1425 and 345/345, accounting for scrollbars). The mobile orbit graphic is omitted while its labelled segment data remains available. Screenshots: `data/m4-browser/workspace-desktop.jpg` and `workspace-mobile.jpg`. Final comparison/agent/approval checks remain pending Task 3. No inference, approval, execution or rejection was triggered during this initial-layout inspection.

## Task 3 and integrated checks

`51cd9f0` added Community-compatible family controls, the single pinned baseline, common-scale intervals and accessible trajectories. Spec review passed. Quality review identified a generic interval wrapper that did not reliably expose its numeric accessible name; `8d40ec2` adds a nameable image role, with a failing-then-passing semantic regression. Both reviews then passed. Actual browser accessibility output subsequently included images named with p10, median and p90 values.

At `8d40ec2`, parent verification passed all 446 tests/36 files, typecheck, zero-warning lint, production build and the 140-file configured-secret/personal-path scan. A warm rebuild retained the corrected navy stylesheet. Integrated spec and quality audits passed. These checks precede the later risk-format and numerical fixes; their own verification is recorded separately.

Real manual simulation displayed distinct mean/median values and canonical/manual provenance. Retention filtering left the selected pricing scenario unchanged and showed an off-filter hint; only retention candidates plus one baseline remained. Pressing Space on the save-offer strategy cell updated the headline and selected trajectory without preparing a proposal. Screenshot: `data/m4-browser/comparison-desktop.jpg`. The active interval accessibility tree contained the numeric names. A request while the owned server was intentionally stopped produced the visible `Failed to fetch` alert (`error-state.txt`); rebuilding/restarting restored operation. Run → Stop restored controls and left ledger counts unchanged at three proposed rows, zero approvals and zero executions.

Browser inspection also found grid risk rounded a true 0.1% to 0% while the headline retained 0.1%. `106e7c6` uses one-decimal risk formatting consistently, with regressions for 0.001, 0.407, zero and one. Independent spec and quality reviews passed, as did nine focused tests, typecheck and scoped zero-warning lint.

## Live annual-candidate stall and numerical follow-up

A fresh Gemini run at the `8d40ec2` runtime showed 200 cache hits, two eligible pilots and agent-selected $50,000 / 50% / 12-month rules, then compared broad retention, selective saves and an annual candidate covering core, price-sensitive and at-risk subscribers. Those are the actual selected rules/candidate, not the earlier M3 default-run choices. Four model responses returned HTTP 200 before progress stopped after comparison. The annual comparison itself was finite: the rounded headline showed mean +$11,375 and median +$10,787, versus its own baseline. No proposal was created.

Initial suspicion of a provider wait was corrected after read-only inspection: the server was CPU-bound and a separate five-second local health request could not complete. The browser's Stop restored client controls, but the parent had to stop its owned server process. Public state is retained at `data/m4-browser/annual-stress-stalled-state.txt`; safe response metrics are in `data/gemini-browser-http-2026-10-26T06-02-54-955Z-ed882967-6408-40ff-b276-ebf0a00f2d8a.jsonl` (also contains the earlier cancellation check).

An isolated bounded child process reproduced the underlying numerical fault: `new Rng(1).binomial(120, 1e-20)` failed to return within 1.5 seconds. `Math.log(1 - 1e-20)` rounds to zero; the geometric-skip denominator then makes position negative infinity and the loop cannot terminate. The stable `Math.log1p(-p)` calculation retains the small negative value. A separate reviewed numerical correction and a real annual-stress regression are required before retrying final acceptance. Preserve model assumptions and genuine recordings; no probability floor, resampling cap or forced winner is authorized.

## Numerical correction and final acceptance

`ef01288` changes only the binomial geometric-skip logarithm to `Math.log1p(-p)`. Before the change, bounded tiny/subnormal-probability tests failed and the exact three-segment annual stress case (15%, 1,000 runs, 12 months, seed 20261113) timed out in a five-second child process. Afterward, 16 RNG/stress tests and both genuine replays passed; the full suite passed 452 tests/37 files. Canonical M1 values from `twin:inspect` matched the documented results. Independent spec and quality reviews passed. No assumptions, probabilities, predictions, fixtures or winning strategies were altered.

The first real post-fix default-objective run completed at that checkpoint: seven recorded HTTP 200 responses, 26,714 reported tokens and about 18.84 seconds from first request start to last response. It used 200 cache hits and proposed only A/B at $18, with $1,000 / 50% / 12-month rules and adverse stress visible. The existing action hash remained correct; no approval occurred. This is warm-cache performance, not a fresh-classification benchmark or a capacity guarantee.

Final visual inspection found a clipped Month 12 label and an uncertain responsive Strategy-column order. `fa56011` anchors endpoint labels inward without moving data points. `e194c25` explicitly keeps Strategy first while unpinning on mobile, preserving column widths/sorts and row selection. Both deltas passed independent spec and quality reviews. Actual browser verification confirmed the Strategy column's physical left edge before the median column (about 38px versus 258px), with `aria-colindex=1`; AG Grid's virtualized DOM node order need not equal visual order. The label anchors read start/middle/end for Months 1/6/12.

At the final application-code checkpoint `e194c25`, parent verification passed **454 tests across 38 files**, typecheck, zero-warning lint, production build, diff check and all **143 tracked files** scanned for configured secrets/personal paths. Integrated source spec/quality reviews and each later correction passed. Existing Vite configuration-format and experimental SQLite notices remain; lint has no warnings.

The real default-objective browser flow completed again on the final build: seven tools, six recorded HTTP 200 responses, **21,767 reported tokens**, and about **17.80 seconds** from first request start to last response. It showed 200 accepted cache hits, zero unclassified items, two eligible pilots, comparison, matching adverse stress, display-only draft and a proposed A/B-only $24 → $18 action. The exact full action hash is `4153b4bb6c7cba3d5d69f0d7c6424ff958c8b876256c3fed36ad8e486fb34293`. Mean value delta is about $105, median $89, interval -$442 to +$656, chance worse 40.7%, and mean discount cost $476; adverse stress remains median -$68 / 57.1% chance worse. Annual remains simulation-only.

The final agent selected $20,000 / 50% / 12-month rules, which the typed card displayed. Repeated runs can choose different permitted rules/candidates; M4 did not change that existing policy or impose a predetermined winner. Default rules are not immutable merchant spending caps. Merchant review must inspect the actual displayed rules and exact proposed payload. Typed evidence now separates 18 active cancel-intent subscribers from 42 feedback records (21 price/21 other), and mean from median; public model prose remains interpretive rather than certified evidence.

Review navigation, family filtering, desktop/mobile resizing and return to All left the proposal intact, confirmation unchecked and Approve & execute disabled. At 360×800, page scroll width equalled client width (345px); the grid scrolled locally (271px client / 1040px scroll width). The pinned baseline appeared once. Keyboard Space selection updated the selected scenario in the manual flow. No unexpected browser console errors/warnings were captured. The temporary viewport override was reset.

Fresh read-only verification found five proposed rows, zero approval audit events and zero execution rows. The latest action matched only A/B, its hash recomputed correctly, and approval/completion timestamps were null. All four PayPal subscriptions remained ACTIVE at $24, with D's pre-existing override flag unchanged. No approval, rejection, execution, message sending or PayPal mutation was performed.

Ignored final evidence: `data/m4-browser/final-head-agent-state.txt`, `final-decision-desktop.jpg`, `final-decision-mobile.jpg`, `final-approval-desktop.jpg`, `comparison-desktop.jpg`, `comparison-mobile.jpg`, `ledger-check.json`; successful run metrics are `data/gemini-browser-http-2026-10-26T06-22-06-669Z-17cc4522-ef0e-4ef8-be98-993f289835ed.jsonl` and `data/gemini-browser-http-2026-10-26T06-34-36-691Z-fbcdcc30-f93c-4a21-90bc-2052003379a3.jsonl`. They contain public UI state or safe timing/status/token totals, not credentials or private provider reasoning.

**M4 local production acceptance is complete.** Hosted walkthrough remains M5/M8 work; no hosted deployment is claimed. Before hosting, carry forward the observed limit that timers cannot preempt synchronous CPU work: the numerical hang is fixed, but process/worker isolation has not been added. Final merge/publication is recorded in the current-state handoff.

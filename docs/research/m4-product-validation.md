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

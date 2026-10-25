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

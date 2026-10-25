# M4 product UI design

<!-- Generated from the approved product spec/roadmap, M3 handoff, and the user's explicit dark navy + gold orbit-theme choice. -->

## Goal and direction

Make the first 30 seconds explain what Aurrery does and why the merchant should inspect its recommendation. The user selected a dark navy workspace with restrained gold accents and orbit-inspired subscriber visuals. Keep the existing model, provider choice, action eligibility, exact-payload confirmation and execution boundaries.

Use an instrument-like visual language: ink background, slightly lighter navy surfaces, warm off-white text, muted blue-grey secondary text and gold for the primary action/selected trajectory. Green and coral communicate positive/negative values with words/signs as well as colour. Keep Geist body/mono fonts already installed. Thin orbital rings and a simple mark establish identity; avoid moving particles or decorative chart scales. One restrained entry transition may respect reduced motion. Do not add animation dependencies or external assets.

Alternatives considered: ivory/gold would be lighter but less aligned with the chosen direction; retaining blue/white would be cheaper but leave the current weak hierarchy. The selected navy/gold system is a presentation change, not a new product workflow.

## Composition and states

1. A compact brand/header shows merchant, synthetic-demo context and PayPal Sandbox connection separately.
2. A prominent decision area leads with the objective before a run. After comparison it shows the selected scenario; only an actual proposal may be called an agent proposal. Put mean (expected) value, median value, p10–p90 interval, chance worse, discount cost and horizon in clearly labelled positions. Never pick a different winner for presentation. A matching adverse-stress warning remains visible when worse than base.
3. The headline action is **Review exact action**, an anchor to the existing approval panel. It does not approve, prepare or execute anything. Simulate-only scenarios say so; rejected/completed/incomplete states must not look newly recommended. Manual simulation remains available beside Run agent.
4. A compact orbit-inspired subscriber overview uses the actual summary segment counts and estimated churn. Orbital placement is decorative, not a quantitative distance/risk scale; a labelled list/table carries the data. On mobile, show the readable list without an oversized graphic.
5. An activity area exposes current progress, Stop, safe errors and optional model commentary. Typed statistical/source summaries take precedence visually over interpretive model prose. Preserve genuine text; never rewrite stored model responses.
6. Scenario comparison groups related interventions visually using family labels/filter controls, with the baseline pinned independently. Keep AG Grid Community; native enterprise row grouping is not licensed. Include a shared-scale p10–p90 interval cell with a zero marker, median point, numeric text and accessible label. Mouse and keyboard selection must update the same scenario state. Narrow layouts scroll inside the grid, not the page, and do not pin an oversized first column.
7. The selected trajectory retains the actual fan chart, legends, axes and 80% uncertainty band. Match the gold candidate/navy system, distinguish baseline with a dashed line, and provide an accessible numeric summary.
8. Supporting evidence shows current active population and classified feedback sample in separate columns. Example: 18 active cancel-intent subscribers; 42 feedback records, 21 price and 21 other. Do not imply those records are the 18 people or claim a causal churn effect. Separate estimated, assumption and observed provenance with text badges. PayPal read-back alone is labelled observed; synthetic history/classified feedback remain explicitly synthetic.
9. Approval retains the exact current payload, targets, hash, status, unchecked checkbox and existing disabled-until-confirmed execution control. Long IDs wrap; tables have their own horizontal overflow. Do not exercise approval, execution, rejection or message sending during QA.

## Data and component boundaries

`Lab.tsx` remains orchestration for existing API calls and reducer state. Add small presentational components for decision summary, source/evidence display and merchant overview. Extend `lab-state.ts` to retain typed rules and matching stress needed for the new presentation. Reset or invalidate them with new runs, classification, rules and replacement comparisons as appropriate; selecting a different scenario must never show another scenario's stress. Existing objective/selection changes still clear proposal/report/confirmation. Use computed typed metrics, not numbers extracted from model text.

Keep server secrets/ledger/provider code outside client imports. No change to frozen M2 inputs, evaluation, model priors, simulations, API contracts or provider limits. Do not preload fictitious recommendations or cached proposals into the product. The fresh page must explain how to begin without implying a completed run.

## Accessibility and validation

Use native headings, links, buttons and details controls; visible gold focus rings; labelled status/progress and existing live log. Target at least 4.5:1 body-text contrast and 3:1 component/large-text contrast. Controls should have generous 40px-or-larger targets. Avoid colour-only meaning. At 360px and desktop widths, controls wrap and content remains usable without page-wide overflow. Respect reduced motion. Keep AG Grid keyboard navigation and ensure keyboard row selection updates the parent.

Meaningful automated checks cover metric/source correctness, stale rule/stress invalidation, no approval side effect from review navigation, accessible labels, interval geometry for crossing/negative/degenerate ranges, baseline uniqueness and keyboard selection. Avoid snapshot/style-string tests for reversible visual details. Run the full suite, typecheck, zero-warning lint and production build after integration. Inspect actual manual and live-agent flows in the browser at desktop and narrow widths, including progress/Stop/error and unchecked approval. Review each implementation task independently for spec then quality, scan tracked files for secrets/personal paths, update handoff and merge/push only after acceptance.

## Scope boundary

M4 includes the source/statistical-label correction deferred from M3, headline hierarchy, theme, orbit language, grid/fan-chart polish and responsive accessibility. It does not implement hosting, webhooks, automatic revert/reset, CSV import, annual-plan execution, provider fallback or a new approval flow. Those remain their roadmap milestones.

Primary implementation references: [AG Grid grouping](https://www.ag-grid.com/react-data-grid/grouping/), [keyboard navigation](https://www.ag-grid.com/react-data-grid/keyboard-navigation/), the installed Next.js CSS/client-component guides and existing local APIs.

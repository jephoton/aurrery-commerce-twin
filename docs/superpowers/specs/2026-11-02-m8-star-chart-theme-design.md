# M8: Star-chart theme, design

**Status:** approved in brainstorming on 2026-11-02 (scope: full illustrated look). Roadmap: M8 "Theme" notes in `docs/superpowers/plans/2026-10-22-aurrery-roadmap.md`.

## Goal

Give Aurrery a deliberate, recognisable identity that matches its orrery name: a celestial star chart (planisphere) on a deep cobalt ground, white engraved line work, and gold kept as the "brass instrument" accent. Purely visual: no change to app logic, data, routes or copy meaning.

**Done when:** Ridgeline and an imported merchant both render in the new theme on desktop and at 375 px with no horizontal scroll; text, gold and status colours meet WCAG AA on their backgrounds; all existing tests, typecheck, lint and build pass; decoration is hidden from assistive tech and never intercepts clicks.

## Visual language

### Palette (CSS variables in `src/app/globals.css`)

| Token | Role | Value (starting point; tune for contrast) |
| --- | --- | --- |
| `--background` | page ground | deep cobalt `#0b1f4a` |
| `--surface` | panels | `#102a5c` |
| `--raised` | raised controls, chips | `#16346d` |
| `--foreground` | body text | `#eef2fb` |
| `--muted` | secondary text | `#b9c6e4` |
| `--border` | engraved hairline | white at ~28% (`#ffffff47`) |
| `--brand` / `--brand-accent` | brass gold | `#e0b65e` / `#efcf8a` |
| `--positive`, `--negative`, `--sim`, `--observed` | status | re-tuned green, coral, violet so each is ≥ 4.5:1 on `--surface` |

Gold is reserved for: the brand mark, eyebrow labels, the recommended headline and its key number, primary action buttons, the planisphere's outer ring and constellation lines, and focus rings. Not for body text or large fills.

### Typography

- Display serif for the brand name, page and section headings, and the headline strategy name: Cormorant Garamond (500/600) via `next/font/google`, exposed as `--font-display`.
- Body, tables, numbers and controls stay Geist Sans / Geist Mono.

### Engraved panels

- Panels get a double hairline: a 1 px border plus a thin outline offset a few px inside or outside, in the engraved white.
- Key panels (decision headline, approval card, evidence record) get small gold corner ticks.
- A reusable celestial divider (ring, short rays, star) between major sections.
- Dotted rules (`border-style: dotted` or a dotted SVG line) for secondary dividers.

## Illustrated artwork

All artwork is hand-authored inline SVG line art (no raster images, no external assets), in a new `src/components/art/` folder:

- `PageFrame`: engraved roses and leafy branches in the page corners, plus a tree-and-cloud flourish along the top band, in white line work at low opacity (about 0.25–0.4) so it reads as an etched cyanotype behind the content. Positioned in the page margins; on narrow screens it collapses to small corner ornaments.
- `Starfield`: a fixed backdrop of scattered dot stars and four-point sparkles (deterministic positions, not random per render).
- `CornerTicks`, `CelestialDivider`: small reusable accents.
- `BrandMark`: the existing orrery mark redrawn in gold with an engraved ellipse and a small star.

Every art component is `aria-hidden="true"` and `pointer-events: none`, renders the same markup on server and client (no hydration mismatch), and adds no client JavaScript beyond rendering.

## Signature component: planisphere

`MerchantOverview`'s decorative orbit becomes an SVG planisphere:

- concentric rings, one dotted ring, and radial "rays" of dotted stars converging on the centre;
- a gold outer ring;
- one star per segment, its radius scaled by that segment's share of active subscribers (with a minimum size), placed at fixed angles;
- gold constellation lines joining the segment stars;
- the total active subscribers in the centre;
- segment labels in the SVG, plus an accessible `role="img"` label summarising the segments. The existing text list of segments and churn stays as the accessible source of truth.
- Copy stays honest: positions are decorative, not a risk scale (keep the existing note).

## Guard rails

- Responsive: at 375 px no horizontal scroll; the frame collapses to corner ornaments; the planisphere scales to the panel width.
- Motion: none required. If any twinkle is added, it is slow, subtle and disabled under `prefers-reduced-motion`.
- Contrast: body text, muted text, gold on surfaces and status colours checked against their backgrounds (AA: 4.5:1 for text, 3:1 for large text and UI lines that convey meaning).
- No logic or behaviour changes; existing component tests must pass unchanged except where a test asserts a class name that the restyle renames (update the assertion, not the behaviour).
- Imported (simulate-only) mode keeps all its labels and notices; the theme applies equally.

## Verification

Before and after screenshots (Ridgeline and the imported Hollowbrook sample, desktop and 375 px), a contrast check of the main token pairs, full test suite, typecheck, lint and build, then a hosted deploy and browser check with Jethro's approval.

## Out of scope

Raster illustrations, animation beyond optional twinkle, layout restructuring, copy rewrites, new features.

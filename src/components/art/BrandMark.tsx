import { polar, pt, sparkle } from "./geometry";

// Aurrery's mark: a brass orrery. Gold rim with an engraved tick scale, a tilted orbit, the sun at the centre,
// one planet on its orbit and a small star outside. Decorative; the brand name is the text beside it.

const TICKS = Array.from({ length: 24 }, (_, i) => i * 15)
  .map((deg) => `M${pt(polar(24, 24, deg % 90 === 0 ? 17.6 : 19.4, deg))} L${pt(polar(24, 24, 21, deg))}`)
  .join(" ");

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <g fill="none" strokeLinecap="round">
        <circle cx="24" cy="24" r="22.5" stroke="var(--brand)" strokeWidth="1.2" />
        <path d={TICKS} stroke="var(--brand)" strokeWidth="0.8" opacity="0.8" />
        <ellipse cx="24" cy="24" rx="15.5" ry="6.4" transform="rotate(-26 24 24)" stroke="var(--brand-accent)" strokeWidth="0.9" opacity="0.85" />
        <ellipse cx="24" cy="24" rx="15.5" ry="6.4" transform="rotate(-26 24 24)" stroke="#f3e6c8" strokeWidth="0.5" strokeDasharray="0 2.4" opacity="0.5" />
      </g>
      <circle cx="24" cy="24" r="3.6" fill="var(--brand)" />
      <circle cx="24" cy="24" r="5.6" fill="none" stroke="var(--brand)" strokeWidth="0.6" opacity="0.6" />
      <circle cx="37.9" cy="17.2" r="1.9" fill="var(--brand-accent)" />
      <path d={sparkle(35.5, 34, 2.6)} fill="var(--brand-accent)" />
    </svg>
  );
}

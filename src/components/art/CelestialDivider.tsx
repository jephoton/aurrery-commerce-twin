import { polar, pt, sparkle } from "./geometry";

// A divider between major sections: fading hairlines either side of a small ring with short rays and a star.

const RAYS = Array.from({ length: 12 }, (_, i) => i * 30)
  .map((deg) => `M${pt(polar(20, 12, deg % 90 === 0 ? 10.5 : 9, deg))} L${pt(polar(20, 12, deg % 90 === 0 ? 13.5 : 11, deg))}`)
  .join(" ");

export function CelestialDivider({ className = "" }: { className?: string }) {
  return (
    <div className={`celestial-divider ${className}`} aria-hidden="true">
      <span className="celestial-divider-line" />
      <svg viewBox="0 0 40 24" width="40" height="24" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round">
          <circle cx="20" cy="12" r="7.5" />
          <circle cx="20" cy="12" r="5.5" strokeDasharray="0 2.2" />
          <path d={RAYS} />
        </g>
        <path d={sparkle(20, 12, 3.4)} fill="var(--brand)" />
      </svg>
      <span className="celestial-divider-line celestial-divider-line-end" />
    </div>
  );
}

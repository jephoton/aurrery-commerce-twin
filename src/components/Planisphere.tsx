import { polar, pt, r2, sparkle } from "./art/geometry";

// The merchant snapshot drawn as a planisphere: engraved rings and dotted rays, one gold star per subscriber
// segment sized by its share of active subscribers (with a floor so small segments stay visible), joined by
// constellation lines, with the total in the centre. Positions are fixed by segment order and are decorative,
// not a risk scale; the segment list beside it stays the accessible source of truth.

export interface PlanisphereSegment { id: string; label: string; active: number }

const SIZE = 340;
const C = SIZE / 2;
const OUTER = 158;
const RINGS = [112, 80] as const;
export const STAR_MIN = 4;
export const STAR_MAX = 13;

/** Star arm length for a segment: proportional to the square root of its share (area tracks share), never below the floor. */
export function starSize(active: number, total: number): number {
  const share = total > 0 ? Math.max(0, active) / total : 0;
  return r2(Math.max(STAR_MIN, STAR_MAX * Math.sqrt(share)));
}

/** "At risk (skipped or paused recently)" → "At risk": the full label stays in the list and the accessible name. */
const shortLabel = (label: string) => label.split(" (")[0];

const TICKS = Array.from({ length: 72 }, (_, i) => i * 5)
  .map((deg) => `M${pt(polar(C, C, deg % 30 === 0 ? 145 : 148.5, deg))} L${pt(polar(C, C, 152, deg))}`)
  .join(" ");

export function Planisphere({ segments, total }: { segments: PlanisphereSegment[]; total: number }) {
  const n = segments.length;
  const sum = segments.reduce((s, seg) => s + Math.max(0, seg.active), 0);
  const stars = segments.map((segment, i) => {
    const deg = -90 + (i * 360) / Math.max(1, n);
    const [x, y] = polar(C, C, RINGS[i % 2], deg);
    return { ...segment, x: r2(x), y: r2(y), size: starSize(segment.active, sum) };
  });
  // Dotted rays converge on the centre between the ring marks; dots near a segment star are left out.
  const rayDots = Array.from({ length: 12 }, (_, k) => 15 + k * 30).flatMap((deg) =>
    Array.from({ length: 9 }, (_, j) => 54 + j * 10.5).map((radius) => {
      const [x, y] = polar(C, C, radius, deg);
      return { x: r2(x), y: r2(y), r: r2(0.55 + (radius / 140) * 0.8), key: `${deg}-${radius}` };
    }),
  ).filter((dot) => stars.every((star) => Math.hypot(star.x - dot.x, star.y - dot.y) > star.size + 8));
  const label = `Planisphere of ${n} subscriber segment${n === 1 ? "" : "s"}, ${total.toLocaleString()} active subscribers in total. `
    + segments.map((s) => `${s.label}: ${s.active.toLocaleString()} active`).join("; ")
    + ". Star size shows each segment's share of active subscribers; positions are decorative, not a risk scale.";

  return (
    <svg className="planisphere" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label}>
      <g fill="none" stroke="#ffffff" vectorEffect="non-scaling-stroke">
        <circle cx={C} cy={C} r={140} strokeWidth="0.8" opacity="0.42" />
        <circle cx={C} cy={C} r={RINGS[0]} strokeWidth="1.5" strokeDasharray="0 5" strokeLinecap="round" opacity="0.5" />
        <circle cx={C} cy={C} r={RINGS[1]} strokeWidth="0.8" opacity="0.3" />
        <path d={`M${C - 140},${C} H${C + 140} M${C},${C - 140} V${C + 140}`} strokeWidth="0.6" strokeDasharray="1 4" opacity="0.22" />
      </g>
      <g fill="#ffffff" opacity="0.55">
        {rayDots.map((dot) => <circle key={dot.key} cx={dot.x} cy={dot.y} r={dot.r} />)}
      </g>
      <g fill="none" stroke="var(--brand)">
        <circle cx={C} cy={C} r={OUTER} strokeWidth="1.4" />
        <circle cx={C} cy={C} r={152} strokeWidth="0.6" opacity="0.7" />
        <path d={TICKS} strokeWidth="0.7" opacity="0.75" />
      </g>
      {n > 1 && (
        <g fill="none" stroke="var(--brand)" strokeWidth="1" strokeLinejoin="round" opacity="0.7" className="planisphere-constellation">
          {n > 2 ? <polygon points={stars.map((s) => pt([s.x, s.y])).join(" ")} /> : <polyline points={stars.map((s) => pt([s.x, s.y])).join(" ")} />}
        </g>
      )}
      <circle cx={C} cy={C} r={46} fill="var(--raised)" stroke="var(--brand)" strokeWidth="0.8" strokeOpacity="0.6" />
      <circle cx={C} cy={C} r={41} fill="none" stroke="#ffffff" strokeWidth="0.5" strokeDasharray="0 3" strokeLinecap="round" opacity="0.5" />
      <text x={C} y={C + 4} textAnchor="middle" className="planisphere-total" fill="var(--brand-accent)">{total.toLocaleString()}</text>
      <text x={C} y={C + 20} textAnchor="middle" fontSize="9.5" letterSpacing="1.4" fill="var(--muted)">ACTIVE</text>
      {stars.map((star) => (
        <g key={star.id} className="planisphere-star" data-segment={star.id} data-size={star.size}>
          <circle cx={star.x} cy={star.y} r={r2(star.size * 1.55)} fill="var(--brand)" opacity="0.13" />
          <path d={sparkle(star.x, star.y, star.size)} fill="var(--brand-accent)" />
          <circle cx={star.x} cy={star.y} r={r2(Math.max(1.2, star.size * 0.28))} fill="#ffffff" />
          <text x={star.x} y={r2(star.y + star.size + 13)} textAnchor="middle" fontSize="10.5" fill="var(--foreground)" stroke="var(--surface)" strokeWidth="3" strokeLinejoin="round" paintOrder="stroke">
            {shortLabel(star.label)}
          </text>
        </g>
      ))}
    </svg>
  );
}

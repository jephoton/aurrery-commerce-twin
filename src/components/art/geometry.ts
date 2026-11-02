// Small, deterministic helpers for the engraved line art. Everything here is pure: the same input always
// produces the same path string, so server and client render identical markup (no hydration mismatch).

export type Point = readonly [number, number];

/** Rounds to two decimals so path strings stay short and identical across runtimes. */
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const pt = ([x, y]: Point) => `${r2(x)},${r2(y)}`;

/** A point at `radius` and `deg` around (cx, cy); 0° points right and angles grow clockwise (SVG y-down). */
export function polar(cx: number, cy: number, radius: number, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
}

/** A polyline through many points: smooth enough for hairline engraving at these sizes. */
export const polyline = (points: Point[]) => `M${points.map(pt).join(" L")}`;

/** An Archimedean-style spiral from `fromDeg` to `toDeg`, its radius easing from r0 to r1. */
export function spiral(cx: number, cy: number, r0: number, r1: number, fromDeg: number, toDeg: number, steps = 48): string {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push(polar(cx, cy, r0 + (r1 - r0) * t, fromDeg + (toDeg - fromDeg) * t));
  }
  return polyline(points);
}

/** A four-point sparkle centred on (x, y) with arm length `s`; a slight waist makes it read as engraved, not a plus sign. */
export function sparkle(x: number, y: number, s: number): string {
  const w = s * 0.2;
  return `M${r2(x)},${r2(y - s)} Q${r2(x + w)},${r2(y - w)} ${r2(x + s)},${r2(y)} Q${r2(x + w)},${r2(y + w)} ${r2(x)},${r2(y + s)} Q${r2(x - w)},${r2(y + w)} ${r2(x - s)},${r2(y)} Q${r2(x - w)},${r2(y - w)} ${r2(x)},${r2(y - s)} Z`;
}

/** A pointed leaf along +x from the origin, with a midrib and paired side veins. Place it with a transform. */
export function leaf(length: number, width: number): { blade: string; veins: string } {
  const L = length, w = width;
  const blade = `M0,0 C${r2(L * 0.22)},${r2(-w * 1.05)} ${r2(L * 0.7)},${r2(-w * 0.95)} ${r2(L)},0 C${r2(L * 0.7)},${r2(w * 0.95)} ${r2(L * 0.22)},${r2(w * 1.05)} 0,0 Z`;
  const veins = [
    `M0,0 Q${r2(L * 0.5)},${r2(-w * 0.08)} ${r2(L * 0.9)},0`,
    ...[0.28, 0.5, 0.7].flatMap((t) => [
      `M${r2(L * t)},0 Q${r2(L * (t + 0.08))},${r2(-w * 0.3)} ${r2(L * (t + 0.16))},${r2(-w * 0.55)}`,
      `M${r2(L * t)},0 Q${r2(L * (t + 0.08))},${r2(w * 0.3)} ${r2(L * (t + 0.16))},${r2(w * 0.55)}`,
    ]),
  ].join(" ");
  return { blade, veins };
}

/** Point and tangent angle (degrees) on a cubic Bézier at t. */
export function bezierAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): { at: Point; deg: number } {
  const u = 1 - t;
  const at: Point = [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
  const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const dy = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  return { at, deg: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/**
 * A scalloped arc: `count` outward bumps between `fromDeg` and `toDeg` on an ellipse around (cx, cy).
 * Bumps bulge away from the centre (sweep flag 1 while walking clockwise).
 */
export function scallops(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, count: number, bulge = 0.62): string {
  const at = (deg: number): Point => {
    const a = (deg * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  };
  let d = `M${pt(at(fromDeg))}`;
  for (let i = 1; i <= count; i++) {
    const a = at(fromDeg + ((toDeg - fromDeg) * (i - 1)) / count);
    const b = at(fromDeg + ((toDeg - fromDeg) * i) / count);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    d += ` A${r2(chord * bulge)},${r2(chord * bulge)} 0 0 1 ${pt(b)}`;
  }
  return d;
}

/** Seeded PRNG (mulberry32): fixed seeds give the same "random" star positions on every render. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

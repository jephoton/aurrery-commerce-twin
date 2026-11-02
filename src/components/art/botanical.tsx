import { bezierAt, leaf, polar, pt, r2, spiral, type Point } from "./geometry";

// Engraved botanical motifs shared by the page frame: an open rose, a closed bud and a leafy branch.
// Drawn once at module load as plain path strings, so rendering is just markup.

const ROSE = (() => {
  const d: string[] = [];
  // The heart: a tight spiral of petals seen from above.
  d.push(spiral(0, 0, 1.4, 13.2, -90, 522, 72));
  // Three cupped inner petals hugging the heart.
  for (const a of [10, 130, 250]) d.push(`M${pt(polar(0, 0, 14.5, a - 52))} Q${pt(polar(0, 0, 21.5, a))} ${pt(polar(0, 0, 14.5, a + 52))}`);
  // Five middle petals with a small notch at the lip.
  for (let i = 0; i < 5; i++) {
    const a = i * 72 - 90;
    d.push(
      `M${pt(polar(0, 0, 17, a - 33))} C${pt(polar(0, 0, 28, a - 40))} ${pt(polar(0, 0, 31.5, a - 16))} ${pt(polar(0, 0, 29.6, a - 4.5))}` +
      ` L${pt(polar(0, 0, 27.6, a))} L${pt(polar(0, 0, 29.6, a + 4.5))}` +
      ` C${pt(polar(0, 0, 31.5, a + 16))} ${pt(polar(0, 0, 28, a + 40))} ${pt(polar(0, 0, 17, a + 33))}`,
    );
    // A turned-back edge on each middle petal.
    d.push(`M${pt(polar(0, 0, 22, a - 20))} Q${pt(polar(0, 0, 25.5, a - 8))} ${pt(polar(0, 0, 24.5, a + 6))}`);
  }
  // Five broad outer petals, offset between the middle ones, with fine veins.
  for (let i = 0; i < 5; i++) {
    const b = i * 72 - 54;
    d.push(
      `M${pt(polar(0, 0, 29.4, b - 31))} C${pt(polar(0, 0, 38.5, b - 33))} ${pt(polar(0, 0, 42.5, b - 12))} ${pt(polar(0, 0, 41, b))}` +
      ` C${pt(polar(0, 0, 42.5, b + 12))} ${pt(polar(0, 0, 38.5, b + 33))} ${pt(polar(0, 0, 29.4, b + 31))}`,
    );
    for (const [off, r0, r1] of [[0, 31.5, 38.5], [-11, 32, 36.5], [11, 32, 36.5]] as const) d.push(`M${pt(polar(0, 0, r0, b + off))} L${pt(polar(0, 0, r1, b + off * 1.15))}`);
  }
  // Pointed sepals showing between the outer petals.
  for (let i = 0; i < 5; i++) {
    const a = i * 72 - 90;
    d.push(`M${pt(polar(0, 0, 31, a - 7))} Q${pt(polar(0, 0, 41, a - 5))} ${pt(polar(0, 0, 50, a))} Q${pt(polar(0, 0, 41, a + 5))} ${pt(polar(0, 0, 31, a + 7))}`);
    d.push(`M${pt(polar(0, 0, 33, a))} L${pt(polar(0, 0, 45, a))}`);
  }
  return d.join(" ");
})();

/** An open rose about 100 units across, centred on (x, y). */
export function Rose({ x, y, scale = 1, rotate = 0 }: { x: number; y: number; scale?: number; rotate?: number }) {
  return <path d={ROSE} transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} />;
}

const BUD = [
  // Closed petals: a teardrop wrapped by one overlapping petal.
  "M0,0 C-7,-3 -8,-13 0,-22 C8,-13 7,-3 0,0 Z",
  "M-5.4,-6 C-1,-8 3,-13 2.6,-19.5",
  "M5.6,-5 C2.5,-9 -1,-11 -3.2,-15.5",
  // Sepals cupping the bud and a short neck.
  "M0,1 C-6,0 -11,-4 -12,-11 C-8,-6 -4,-4 -1,-3",
  "M0,1 C6,0 11,-4 12,-11 C8,-6 4,-4 1,-3",
  "M0,1 Q-0.6,5 0,9",
].join(" ");

/** A rosebud about 24 units tall, its tip pointing along `deg` (0° = right). */
export function Bud({ x, y, deg, scale = 1 }: { x: number; y: number; deg: number; scale?: number }) {
  return <path d={BUD} transform={`translate(${r2(x)} ${r2(y)}) rotate(${r2(deg + 90)}) scale(${scale})`} />;
}

interface BranchSpec {
  from: Point; c1: Point; c2: Point; to: Point;
  /** Leaves along the stem: t position, side (1 or -1), length. */
  leaves: readonly (readonly [number, 1 | -1, number])[];
  bud?: boolean;
}

/** A curving stem with alternating veined leaves and an optional bud at its tip. */
export function Branch({ spec }: { spec: BranchSpec }) {
  const { from, c1, c2, to } = spec;
  const end = bezierAt(from, c1, c2, to, 1);
  return (
    <g>
      <path d={`M${pt(from)} C${pt(c1)} ${pt(c2)} ${pt(to)}`} />
      {spec.leaves.map(([t, side, length]) => {
        const { at, deg } = bezierAt(from, c1, c2, to, t);
        const shape = leaf(length, length * 0.34);
        const transform = `translate(${pt(at).replace(",", " ")}) rotate(${r2(deg + side * 48)})`;
        return (
          <g key={t} transform={transform}>
            <path d={shape.blade} />
            <path d={shape.veins} strokeWidth="0.6" />
          </g>
        );
      })}
      {spec.bud && <Bud x={end.at[0]} y={end.at[1]} deg={end.deg} scale={0.9} />}
    </g>
  );
}

export type { BranchSpec };

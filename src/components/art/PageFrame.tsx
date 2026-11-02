import { Branch, Bud, Rose, type BranchSpec } from "./botanical";
import { leaf, polar, pt, r2, scallops, sparkle, spiral, type Point } from "./geometry";

// The etched frame around the page: a rose with leafy branches in each corner (fixed to the viewport, so it frames
// the chart as you scroll) and a tree flanked by cloud scrolls along the top band. White line work at low opacity,
// hidden from assistive tech and never interactive. On narrow screens the corners shrink to the rose alone and
// the top band is hidden (see .page-frame rules in globals.css).

const ALONG_TOP: BranchSpec = {
  from: [104, 50], c1: [142, 32], c2: [186, 44], to: [230, 28],
  leaves: [[0.16, -1, 19], [0.32, 1, 21], [0.5, -1, 18], [0.66, 1, 17], [0.82, -1, 13]],
  bud: true,
};

const TOWARD_CENTRE: BranchSpec = {
  from: [104, 104], c1: [114, 112], c2: [124, 120], to: [134, 134],
  leaves: [[0.35, 1, 14], [0.55, -1, 13]],
  bud: true,
};

const CORNER_STARS: [number, number, number][] = [[166, 82, 4.5], [82, 166, 4.5], [214, 70, 2.8], [70, 214, 2.8], [150, 150, 2.4]];

function Corner({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg className={`page-frame-corner page-frame-corner-${position}`} viewBox="0 0 260 260" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        {/* Double plate rule along the two page edges. */}
        <g className="page-frame-extended" strokeWidth="0.7">
          <path d="M8,244 V8 H244 M14,236 V14 H236" />
          <circle cx="244" cy="8" r="1.6" /><circle cx="8" cy="244" r="1.6" />
        </g>
        <g className="page-frame-extended">
          <Branch spec={ALONG_TOP} />
          {/* The same branch mirrored down the side edge. */}
          <g transform="matrix(0 1 1 0 0 0)"><Branch spec={ALONG_TOP} /></g>
          <Branch spec={TOWARD_CENTRE} />
          {CORNER_STARS.map(([x, y, s]) => <path key={`${x}-${y}`} d={sparkle(x, y, s)} strokeWidth="0.7" />)}
        </g>
        <Rose x={64} y={64} rotate={8} />
      </g>
    </svg>
  );
}

// ——— Top band: tree of life between two cloud scrolls ———

const TREE = (() => {
  const d: string[] = [];
  // Trunk with flared roots.
  d.push("M352,118 C356,104 355,88 351,74", "M368,118 C364,104 365,88 369,74");
  d.push("M352,118 C346,120 340,121 332,124", "M368,118 C374,120 380,121 388,124", "M358,118 C357,121 354,123 349,125", "M362,118 C363,121 366,123 371,125");
  d.push("M357,96 C359,91 359,86 358,82", "M363,104 C362,99 363,94 364,90"); // bark
  // Limbs reaching into the crown.
  d.push("M351,74 C342,66 331,62 316,60", "M369,74 C378,66 389,62 404,60");
  d.push("M356,72 C350,58 343,48 333,40", "M364,72 C370,58 377,48 387,40", "M360,72 C360,60 359,46 360,34");
  d.push("M333,40 C329,37 325,36 320,37", "M387,40 C391,37 395,36 400,37", "M343,52 C338,50 334,50 330,52", "M377,52 C382,50 386,50 390,52");
  // The crown: a scalloped dome curling in at both ends.
  d.push(scallops(360, 68, 66, 54, 180, 360, 13, 0.6));
  d.push(spiral(299, 68, 5, 1.4, 180, -110, 30), spiral(421, 68, 5, 1.4, 0, 290, 30));
  // Leaf clusters inside the crown.
  for (const [cx, cy, rx] of [[322, 50, 11], [398, 50, 11], [346, 30, 10], [374, 30, 10], [360, 26, 8]] as const) d.push(scallops(cx, cy, rx, rx * 0.8, 200, 340, 3, 0.62));
  // Ground: a low mound.
  d.push("M262,124 Q360,112 458,124");
  return d.join(" ");
})();

function cloud(x0: number, y: number, bumps: number[]): string {
  // Bumps rise above the baseline; both ends finish in inward scrolls, and an echo line runs beneath.
  const total = bumps.reduce((s, b) => s + b, 0);
  let d = `M${x0},${y}`;
  for (const b of bumps) d += ` a${b / 2},${(b / 2) * 0.86} 0 0 1 ${b},0`;
  const xe = x0 + total;
  // Scrolls curl outward from each end of the baseline.
  const curls = [spiral(xe + 7, y - 7, 7 * Math.SQRT2, 1.8, 135, -200, 44), spiral(x0 - 7, y - 7, 7 * Math.SQRT2, 1.8, 45, 380, 44)];
  const echo = `M${x0 + 14},${y + 7} H${xe - 18} ${spiral(xe - 18, y + 3, 4, 1.2, 90, -190, 24)}`;
  // Fine inner lines echo each bump, like burin work.
  let x = x0;
  const inner: string[] = [];
  for (const b of bumps) {
    const r = (b / 2) * 0.55;
    inner.push(`M${x + b / 2 - r},${y - 2} a${r},${r * 0.86} 0 0 1 ${2 * r},0`);
    x += b;
  }
  return [d, ...curls, echo, ...inner].join(" ");
}

const LEFT_CLOUD = cloud(150, 86, [22, 30, 38, 26]);

const BAND_STARS: [number, number, number][] = [[118, 40, 5], [214, 28, 3.2], [278, 18, 2.4], [442, 18, 2.4], [506, 28, 3.2], [70, 74, 2.4], [652, 88, 2.2]];

function Moon({ x, y, r }: { x: number; y: number; r: number }) {
  const [ax, ay] = polar(x, y, r, -60);
  const [bx, by] = polar(x, y, r, 60);
  // Outer limb round the left, inner limb back with a shallower bow: a waxing crescent.
  return <path d={`M${pt([ax, ay])} A${r},${r} 0 1 0 ${pt([bx, by])} A${r2(r * 0.886)},${r2(r * 0.886)} 0 0 1 ${pt([ax, ay])} Z`} />;
}

function Sprig({ at, deg }: { at: Point; deg: number }) {
  const shape = leaf(12, 4);
  return (
    <g transform={`translate(${pt(at).replace(",", " ")}) rotate(${deg})`}>
      <path d="M0,0 L16,0" />
      <path d={shape.blade} transform="translate(4 0) rotate(-40)" />
      <path d={shape.blade} transform="translate(9 0) rotate(40)" />
    </g>
  );
}

function TopBand() {
  return (
    <svg className="page-frame-band" viewBox="0 0 720 130" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        <path d={TREE} />
        <path d={LEFT_CLOUD} />
        <g transform="matrix(-1 0 0 1 720 0)"><path d={LEFT_CLOUD} /></g>
        <Sprig at={[254, 112]} deg={-160} />
        <g transform="matrix(-1 0 0 1 720 0)"><Sprig at={[254, 112]} deg={-160} /></g>
        <g transform="translate(626 46)"><Moon x={0} y={0} r={11} /></g>
        <Bud x={96} y={58} deg={-60} scale={0.7} />
        {BAND_STARS.map(([x, y, s]) => <path key={`${x}-${y}`} d={sparkle(x, y, s)} strokeWidth="0.7" />)}
        <path d="M40,124 H230 M490,124 H680" strokeDasharray="0 7" strokeWidth="1.4" />
      </g>
    </svg>
  );
}

export function PageFrame() {
  return (
    <div className="page-frame" aria-hidden="true">
      <TopBand />
      <Corner position="tl" />
      <Corner position="tr" />
      <Corner position="bl" />
      <Corner position="br" />
    </div>
  );
}

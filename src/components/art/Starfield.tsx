import { r2, seeded, sparkle } from "./geometry";

// A fixed backdrop of dot stars and four-point sparkles, with two faint dotted great circles like a chart's
// ecliptic. Positions come from a fixed seed, so every render (server or client) is identical. A handful of
// sparkles twinkle slowly; the .twinkle rule in globals.css turns that off under prefers-reduced-motion.

const W = 1600;
const H = 1000;

const { dots, sparkles } = (() => {
  const rand = seeded(20261102);
  const dots = Array.from({ length: 170 }, () => {
    const big = rand() > 0.88;
    return { x: r2(rand() * W), y: r2(rand() * H), r: r2(big ? 1.1 + rand() * 0.7 : 0.45 + rand() * 0.55), o: r2(big ? 0.55 + rand() * 0.3 : 0.22 + rand() * 0.35) };
  });
  const sparkles = Array.from({ length: 18 }, (_, i) => ({ d: sparkle(rand() * W, rand() * H, 3 + rand() * 4.5), o: r2(0.45 + rand() * 0.35), twinkle: i % 3 === 0, delay: r2(rand() * 9) }));
  return { dots, sparkles };
})();

export function Starfield() {
  return (
    <svg className="starfield" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <g fill="none" stroke="#ffffff" strokeWidth="1" strokeDasharray="0 9" strokeLinecap="round" opacity="0.14" vectorEffect="non-scaling-stroke">
        <path d="M-60,760 C380,520 1080,430 1680,180" />
        <path d="M-60,330 C420,470 1100,660 1680,700" />
      </g>
      <g fill="#ffffff">
        {dots.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />)}
      </g>
      <g fill="#ffffff">
        {sparkles.map((s, i) => <path key={i} d={s.d} opacity={s.o} className={s.twinkle ? "twinkle" : undefined} style={s.twinkle ? { animationDelay: `${s.delay}s` } : undefined} />)}
      </g>
    </svg>
  );
}

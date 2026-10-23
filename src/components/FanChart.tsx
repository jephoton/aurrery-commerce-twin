import type { Band } from "@/twin/types";

// Median line with an 80% band, for a candidate strategy against the baseline.

interface Series {
  label: string;
  band: Band;
  color: string;
}

export function FanChart({ series, title, format }: { series: Series[]; title: string; format: (v: number) => string }) {
  const W = 560;
  const H = 220;
  const pad = { l: 64, r: 16, t: 16, b: 28 };
  const months = series[0]?.band.p50.length ?? 0;
  const all = series.flatMap((s) => [...s.band.p10, ...s.band.p90]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (i / Math.max(1, months - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (b: Band) =>
    `${line(b.p90)} ${b.p10
      .map((v, i) => [i, v] as const)
      .reverse()
      .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ")} Z`;
  const ticks = [lo, lo + span / 2, hi];

  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-center gap-4 text-sm text-muted">
        <span className="font-medium text-foreground">{title}</span>
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span>shaded: 80% interval</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {[...new Set([0, Math.floor((months - 1) / 2), months - 1])].map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
            Month {i + 1}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.label}>
            <path d={area(s.band)} fill={s.color} opacity={0.14} />
            <path d={line(s.band.p50)} fill="none" stroke={s.color} strokeWidth={2.2} />
          </g>
        ))}
      </svg>
    </figure>
  );
}

import type { Band } from "@/twin/types";

// Median line with an 80% band, for a candidate strategy against the baseline.

interface Series {
  label: string;
  band: Band;
  color: string;
  baseline?: boolean;
}

export function FanChart({ series, title, format }: { series: Series[]; title: string; format: (v: number) => string }) {
  const W = 560;
  const H = 220;
  const pad = { l: 64, r: 16, t: 16, b: 28 };
  const count = (s: Series) => Math.min(s.band.p10.length, s.band.p50.length, s.band.p90.length);
  const chartable = series.filter((s) => count(s) > 0);
  const months = Math.max(0, ...chartable.map(count));
  const all = chartable.flatMap((s) => [...s.band.p10.slice(0, count(s)), ...s.band.p50.slice(0, count(s)), ...s.band.p90.slice(0, count(s))]).filter(Number.isFinite);
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (i / Math.max(1, months - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => hi === lo ? pad.t + (H - pad.t - pad.b) / 2 : pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const line = (vals: number[], n: number) => vals.slice(0, n).map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (b: Band, n: number) =>
    `${line(b.p90, n)} ${b.p10.slice(0, n)
      .map((v, i) => [i, v] as const)
      .reverse()
      .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ")} Z`;
  const ticks = hi === lo ? [lo] : [lo, lo + span / 2, hi];
  const description = series.map((s) => {
    const n = Math.min(s.band.p10.length, s.band.p50.length, s.band.p90.length);
    if (!n) return `${s.label}: no trajectory`;
    const point = (i: number) => `month ${i + 1} median ${format(s.band.p50[i])}, p10 ${format(s.band.p10[i])}, p90 ${format(s.band.p90[i])}`;
    return `${s.label}: ${point(0)}${n > 1 ? `; ${point(n - 1)}` : ""}`;
  }).join(". ");

  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-center gap-4 text-sm text-muted">
        <span className="font-medium text-foreground">{title}</span>
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2" style={{ borderColor: s.color, borderStyle: s.baseline ? "dashed" : "solid" }} />
            {s.label}
          </span>
        ))}
        <span>shaded: 80% interval</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${title}. ${description || "No trajectory available"}. Shaded area is the 80% interval.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {[...new Set(months > 0 ? [0, Math.floor((months - 1) / 2), months - 1] : [])].map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === months - 1 ? "end" : "middle"} fontSize="11" fill="var(--muted)">
            Month {i + 1}
          </text>
        ))}
        {chartable.map((s) => (
          <g key={s.label}>
            {count(s) > 1 ? <path d={area(s.band, count(s))} fill={s.color} opacity={0.14} /> : <line x1={x(0)} x2={x(0)} y1={y(s.band.p10[0])} y2={y(s.band.p90[0])} stroke={s.color} strokeWidth={6} opacity={0.45} />}
            <path d={line(s.band.p50, count(s))} fill="none" stroke={s.color} strokeWidth={2.2} strokeDasharray={s.baseline ? "6 4" : undefined} />
            {count(s) === 1 && <circle cx={x(0)} cy={y(s.band.p50[0])} r={4} fill={s.color} />}
          </g>
        ))}
      </svg>
    </figure>
  );
}

import { intervalGeometry } from "./comparison-model";

export const signedUsd = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`;

export function IntervalCell({ p10, p50, p90, domain }: { p10: number; p50: number; p90: number; domain: [number, number] }) {
  const { start, median, end, zero } = intervalGeometry(p10, p50, p90, domain);
  const x = (position: number) => 5 + position * 130;
  const label = `80% interval: p10 ${signedUsd(p10)}, median ${signedUsd(p50)}, p90 ${signedUsd(p90)}`;
  return (
    <span className="flex min-w-[220px] flex-col justify-center gap-0.5 py-1" aria-label={label}>
      <svg viewBox="0 0 140 16" width="140" height="16" aria-hidden="true" focusable="false">
        <line x1={x(zero)} x2={x(zero)} y1="1" y2="15" stroke="#abb8cb" strokeWidth="1" strokeDasharray="2 2" />
        <line x1={x(start)} x2={x(end)} y1="8" y2="8" stroke="#e6bd69" strokeWidth="5" strokeLinecap="round" />
        <circle cx={x(median)} cy="8" r="4" fill="#f4f0e7" stroke="#e6bd69" strokeWidth="2" />
      </svg>
      <span className="text-[11px] leading-none text-muted" aria-hidden="true">{signedUsd(p10)} … {signedUsd(p90)}</span>
    </span>
  );
}

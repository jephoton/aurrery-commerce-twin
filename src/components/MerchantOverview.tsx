import type { MerchantSummary } from "./Lab";

export function MerchantOverview({ summary }: { summary: MerchantSummary }) {
  return (
    <section aria-labelledby="merchant-overview-title" className="overview-panel min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Merchant snapshot</p>
          <h2 id="merchant-overview-title" className="mt-2 text-xl font-semibold tracking-tight">Subscribers in orbit</h2>
        </div>
        <span className="source-badge">Synthetic demo history · {summary.asOfMonth}</span>
      </div>
      <div className="mt-5 grid min-w-0 items-center gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="orbit-map hidden h-52 items-center justify-center sm:flex" aria-hidden="true">
          <div className="orbit-ring orbit-ring-outer" />
          <div className="orbit-ring orbit-ring-middle" />
          <div className="orbit-ring orbit-ring-inner" />
          <span className="orbit-core">{summary.active.toLocaleString()}<small>subscribers</small></span>
          {summary.segments.map((segment, index) => <span key={segment.id} className={`orbit-point orbit-point-${index % 5}`} />)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-7 gap-y-2 border-b border-border pb-4">
            <p><strong className="text-2xl font-semibold text-foreground">{summary.active.toLocaleString()}</strong> <span className="text-muted">active subscribers</span></p>
            <p><strong className="text-xl font-semibold text-foreground">${Math.round(summary.mrr).toLocaleString()}</strong> <span className="text-muted">monthly recurring revenue</span></p>
          </div>
          <p className="mt-3 text-xs text-muted">Orbit positions are decorative, not a risk scale. Churn figures are estimates from synthetic history.</p>
          <ul className="mt-4 grid gap-2" aria-label="Subscriber segments and estimated churn">
            {summary.segments.map((segment) => (
              <li key={segment.id} className="flex min-w-0 flex-col gap-0.5 border-b border-border/70 py-1.5 text-sm last:border-0 lg:flex-row lg:justify-between lg:gap-3">
                <span className="font-medium">{segment.label}</span>
                <span className="text-muted lg:text-right">{segment.active.toLocaleString()} active · {(segment.churn * 100).toFixed(1)}% estimated monthly churn</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Last month&apos;s estimated churn: {(summary.lastMonthChurnRate * 100).toFixed(1)}%. {summary.planName} plan at ${summary.listPrice.toFixed(2)}.</p>
        </div>
      </div>
    </section>
  );
}

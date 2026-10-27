import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import type { ObservedSnapshot } from "@/merchant/observed-snapshot";

interface Props {
  summary: MerchantSummary;
  evidence: Extract<AgentEvent, { type: "classification" }> | null;
  source: "manual" | "agent" | null;
  snapshot?: ObservedSnapshot | null;
}

export function EvidencePanel({ summary, evidence, source, snapshot }: Props) {
  const classified = source === "agent" ? evidence : null;
  const provenance = snapshot?.provenance ?? (source ? {} : summary.provenance);
  const measured = snapshot?.evidence ?? (source ? undefined : summary.observedEvidence);
  const changes = snapshot?.changes ?? (source ? undefined : summary.parameterChanges);
  return (
    <aside className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="evidence-title">
      <p className="eyebrow">Evidence record</p>
      <h3 id="evidence-title" className="mb-4 mt-2 text-lg font-semibold">What this rests on</h3>
      <div className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <h4 className="font-medium">Active subscriber population</h4>
          <p className="mt-1 text-muted">Synthetic demo history · {summary.asOfMonth}</p>
          <ul className="mt-2 space-y-1">{summary.segments.map(segment => <li key={segment.id}>{segment.label}: {segment.active.toLocaleString()} active · estimated {((segment.churn) * 100).toFixed(1)}% monthly churn</li>)}</ul>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <h4 className="font-medium">Classified feedback sample</h4>
          {classified ? <>
            <p className="mt-1 text-muted">{classified.summary.source} · {classified.summary.provider} / {classified.summary.model}</p>
            <p className="mt-1">{classified.summary.accepted.toLocaleString()} accepted of {classified.summary.total.toLocaleString()} feedback records</p>
            <ul className="mt-2 space-y-1">{summary.segments.map(segment => {
              const counts = classified.hitmap[segment.id];
              return <li key={segment.id}>{segment.label}: {(counts?.price ?? 0) + (counts?.other ?? 0)} feedback records · {counts?.price ?? 0} price · {counts?.other ?? 0} other</li>;
            })}</ul>
            <p className="mt-2 text-muted">Feedback records are a separate sample, not a share of the active population or proof that an offer caused retention.</p>
          </> : <p className="mt-1 text-muted">{source === "manual" ? "Manual comparison: no AI classification applied." : "No feedback classified in this run."}</p>}
        </div>
      </div>
      {measured && <div className="mt-3 rounded-lg border border-border bg-background p-4 text-sm">
        <h4 className="font-medium">Measured sandbox outcomes</h4>
        <p className="mt-1 text-muted">{snapshot ? "Evidence snapshot used for this run." : "Evidence snapshot at page load."}</p>
        <p className="mt-1">{measured.episodes} verified discount episodes · {measured.subscriberMonths.toFixed(3)} observed discounted subscriber-months (30 days/month).</p>
        <p className="mt-1">{measured.cancellations} ambiguous cancellation facts · {measured.censoredEpisodes} episodes excluded, including preceding survival.</p>
        <p className="mt-1">Calibration: {measured.posteriorSubscriberMonths.toFixed(3)} subscriber-months · {measured.posteriorCancellations} qualified posterior cancellations.</p>
        {changes?.length ? <ul className="mt-2 space-y-1">{changes.map(change => <li key={change.parameter}>{change.parameter}: mean {change.before.mean.toFixed(4)} → {change.after.mean.toFixed(4)} · {change.evidence}</li>)}</ul> : <p className="mt-1">No measured effect parameter changes. A price override alone is not retention evidence.</p>}
        <p className="mt-2 text-muted">{measured.limitation}</p>
      </div>}
      {source && !snapshot && <p className="mt-3 text-sm text-muted">Measured evidence snapshot unavailable for this run.</p>}
      <p className="mt-3 text-sm text-muted">{source === "manual" ? "Canonical synthetic twin estimates with separately measured sandbox effects and registered pilots." : classified ? "Classified synthetic feedback updates reason estimates; measured effects, historical estimates and intervention assumptions remain distinct." : "Current synthetic history, measured sandbox effects and model assumptions."}</p>
      <details className="mt-4 border-t border-border pt-3 text-sm">
        <summary className="min-h-10 cursor-pointer pt-2 font-medium text-brand-accent">Sources and assumptions</summary>
        <ul className="mt-2 space-y-2">{Object.entries(provenance).map(([key, item]) => (
          <li key={key} className="flex min-w-0 flex-wrap gap-2"><span className={`h-fit shrink-0 rounded border px-1.5 text-xs font-medium ${item.source === "observed" ? "border-observed/50 text-observed" : item.source === "assumption" ? "border-sim/50 text-sim" : "border-brand/50 text-brand"}`}>{item.source}</span><span className="min-w-0 text-muted">{item.note}</span></li>
        ))}</ul>
      </details>
    </aside>
  );
}

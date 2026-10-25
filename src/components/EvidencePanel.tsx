import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";

interface Props {
  summary: MerchantSummary;
  evidence: Extract<AgentEvent, { type: "classification" }> | null;
  source: "manual" | "agent" | null;
}

export function EvidencePanel({ summary, evidence, source }: Props) {
  const classified = source === "agent" ? evidence : null;
  const provenance = classified?.provenance ?? summary.provenance;
  return (
    <aside className="rounded-xl border border-border bg-surface p-5" aria-labelledby="evidence-title">
      <h3 id="evidence-title" className="mb-3 font-semibold">What this rests on</h3>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-background p-3">
          <h4 className="font-medium">Active subscriber population</h4>
          <p className="mt-1 text-muted">Synthetic demo history · {summary.asOfMonth}</p>
          <ul className="mt-2 space-y-1">{summary.segments.map(segment => <li key={segment.id}>{segment.label}: {segment.active.toLocaleString()} active · estimated {((segment.churn) * 100).toFixed(1)}% monthly churn</li>)}</ul>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
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
      <p className="mt-3 text-sm text-muted">{source === "manual" ? "Canonical synthetic twin estimates and registered pilots." : classified ? "Classified synthetic feedback updates reason estimates; historical estimates and intervention assumptions remain distinct." : "Current synthetic history and model assumptions."}</p>
      <ul className="mt-2 space-y-2 text-sm">{Object.entries(provenance).map(([key, item]) => (
        <li key={key} className="flex gap-2"><span className="h-fit shrink-0 rounded bg-background px-1.5 text-xs font-medium text-brand-accent">{item.source}</span><span className="text-muted">{item.note}</span></li>
      ))}</ul>
    </aside>
  );
}

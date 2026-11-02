import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import type { LiveAnnual } from "./lab-state";
import type { AnnualEvidence, ObservedSnapshot } from "@/merchant/observed-snapshot";
import type { ImportedDetails } from "@/merchant/summary";

interface Props {
  summary: MerchantSummary;
  evidence: Extract<AgentEvent, { type: "classification" }> | null;
  source: "manual" | "agent" | null;
  snapshot?: ObservedSnapshot | null;
  /** Annual evidence re-read after a PayPal refresh; takes precedence over the page-load or run snapshot value. */
  liveAnnual?: LiveAnnual | null;
}

export function EvidencePanel({ summary, evidence, source, snapshot, liveAnnual }: Props) {
  const classified = source === "agent" ? evidence : null;
  // An imported twin (M6) has its own provenance and never shows Ridgeline's measured or annual evidence.
  const imported = summary.imported;
  const provenance = imported ? summary.provenance : snapshot?.provenance ?? (source ? {} : summary.provenance);
  const measured = imported ? undefined : snapshot?.evidence ?? (source ? undefined : summary.observedEvidence);
  const changes = imported ? undefined : snapshot?.changes ?? (source ? undefined : summary.parameterChanges);
  const annual = imported ? undefined : liveAnnual?.annual ?? (snapshot ? snapshot.annual : source ? undefined : summary.annualEvidence);
  return (
    <aside className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="evidence-title">
      <p className="eyebrow">Evidence record</p>
      <h3 id="evidence-title" className="mb-4 mt-2 text-lg font-semibold">What this rests on</h3>
      <div className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <h4 className="font-medium">Active subscriber population</h4>
          <p className="mt-1 text-muted">{imported ? `Imported CSV history · ${imported.firstMonth} to ${imported.lastMonth} (${imported.months} months)` : `Synthetic demo history · ${summary.asOfMonth}`}</p>
          <ul className="mt-2 space-y-1">{summary.segments.map(segment => <li key={segment.id}>{segment.label}: {segment.active.toLocaleString()} active · estimated {((segment.churn) * 100).toFixed(1)}% monthly churn</li>)}</ul>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <h4 className="font-medium">Classified feedback sample</h4>
          {imported ? <ImportedFeedback imported={imported} segments={summary.segments} /> : classified ? <>
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
      {annual && <AnnualOfferEvidence annual={annual} segments={summary.segments} live={!!liveAnnual} runDisplayed={!!snapshot} />}
      {!imported && source && !snapshot && <p className="mt-3 text-sm text-muted">Measured evidence snapshot unavailable for this run.</p>}
      <p className="mt-3 text-sm text-muted">{imported ? "Estimated from your CSV with merchant-entered economics; price sensitivity, annual uptake and discount effects stay assumptions. Simulate only." : source === "manual" ? "Canonical synthetic twin estimates with separately measured sandbox effects and registered pilots." : classified ? "Classified synthetic feedback updates reason estimates; measured effects, historical estimates and intervention assumptions remain distinct." : "Current synthetic history, measured sandbox effects and model assumptions."}</p>
      <details className="mt-4 border-t border-border pt-3 text-sm">
        <summary className="min-h-10 cursor-pointer pt-2 font-medium text-brand-accent">Sources and assumptions</summary>
        <ul className="mt-2 space-y-2">{Object.entries(provenance).map(([key, item]) => (
          <li key={key} className="flex min-w-0 flex-wrap gap-2"><span className={`h-fit shrink-0 rounded border px-1.5 text-xs font-medium ${item.source === "observed" ? "border-observed/50 text-observed" : item.source === "assumption" ? "border-sim/50 text-sim" : "border-brand/50 text-brand"}`}>{item.source}</span><span className="min-w-0 text-muted">{item.note}</span></li>
        ))}</ul>
      </details>
    </aside>
  );
}

function AnnualOfferEvidence({ annual, segments, live, runDisplayed }: { annual: AnnualEvidence; segments: MerchantSummary["segments"]; live: boolean; runDisplayed: boolean }) {
  const label = (id: string) => segments.find((segment) => segment.id === id)?.label ?? id.replaceAll("_", " ");
  const total = (key: "accepted" | "declined" | "unresolved") => annual.offers.reduce((sum, offer) => sum + offer[key], 0);
  return (
    <section className="mt-3 rounded-lg border border-border bg-background p-4 text-sm" aria-labelledby="annual-evidence-title">
      <h4 id="annual-evidence-title" className="font-medium">Annual offers</h4>
      {live && <p className="mt-1 text-muted">Current ledger, updated by the latest PayPal check.{runDisplayed && " The displayed run used the evidence snapshot above."}</p>}
      <p className="mt-1" aria-live="polite">{total("accepted")} accepted · {total("declined")} declined · {total("unresolved")} awaiting decision or final check</p>
      {annual.offers.length > 0 && <ul className="mt-2 space-y-1">{annual.offers.map((offer) => (
        <li key={offer.segment}>{label(offer.segment)}: {offer.accepted} accepted · {offer.declined} declined · {offer.unresolved} awaiting decision or final check</li>
      ))}</ul>}
      {annual.changes.length
        ? <ul className="mt-2 space-y-1">{annual.changes.map((change) => <li key={change.parameter}>{change.parameter}: mean {change.before.mean.toFixed(4)} → {change.after.mean.toFixed(4)} · {change.evidence}</li>)}</ul>
        : <p className="mt-1">No uptake estimate has changed: only switched or confirmed-declined offers update it.</p>}
      <p className="mt-2 text-muted">{annual.limitation}</p>
    </section>
  );
}

function ImportedFeedback({ imported, segments }: { imported: ImportedDetails; segments: MerchantSummary["segments"] }) {
  const counts = imported.reasonCounts;
  if (!counts || imported.feedbackRows === 0) return <p className="mt-1 text-muted">No feedback imported, so leaving reasons are unknown: price-reason targeting is unavailable and reason shares stay prior assumptions.</p>;
  return <>
    <p className="mt-1 text-muted">AI-classified from {imported.feedbackRows} uploaded feedback rows, before simulation</p>
    <ul className="mt-2 space-y-1">{segments.map((segment) => {
      const c = counts[segment.id];
      return <li key={segment.id}>{segment.label}: {c.price + c.other} feedback rows · {c.price} price · {c.other} other</li>;
    })}</ul>
    <p className="mt-2 text-muted">Feedback rows are a separate sample, not a share of the active population or proof that an offer caused retention.</p>
  </>;
}

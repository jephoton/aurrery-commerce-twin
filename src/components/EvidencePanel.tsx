import type { ReactNode } from "react";
import type { AgentEvent } from "@/agent/contracts";
import type { MerchantSummary } from "./Lab";
import type { LiveAnnual } from "./lab-state";
import type { AnnualEvidence, ObservedSnapshot } from "@/merchant/observed-snapshot";
import { CornerTicks } from "./art/CornerTicks";

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
  const maxChurn = Math.max(.01, ...summary.segments.map(segment => segment.churn));
  return (
    <aside className="engraved-key min-w-0 engraved border border-border bg-surface p-5 sm:p-6" aria-labelledby="evidence-title">
      <CornerTicks />
      <p className="eyebrow">Evidence record</p>
      <h3 id="evidence-title" className="display mb-4 mt-2 text-2xl font-semibold">What this rests on</h3>
      <TrustBar provenance={provenance} />
      <div className="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <h4 className="font-medium">Active subscriber population</h4>
          <p className="mt-1 text-xs text-muted">{imported ? `Imported CSV history · ${imported.firstMonth} to ${imported.lastMonth} (${imported.months} months)` : `Synthetic demo history · ${summary.asOfMonth}`} · estimated monthly churn</p>
          <ul className="mt-3 space-y-2">{summary.segments.map(segment => (
            <li key={segment.id}>
              <div className="flex justify-between gap-2"><span className="min-w-0">{segment.label} <span className="text-xs text-muted">{segment.active.toLocaleString()} active</span></span><span className="tabular-nums">{(segment.churn * 100).toFixed(1)}%</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(1, (segment.churn / maxChurn) * 100)}%` }} /></div>
            </li>
          ))}</ul>
        </div>
        {imported?.reasonCounts && imported.feedbackRows > 0 ? <FeedbackBars title="AI-classified feedback" note={`AI-classified from ${imported.feedbackRows} uploaded feedback rows`} unit="feedback rows" counts={imported.reasonCounts} segments={summary.segments} />
          : classified ? <FeedbackBars title="Classified feedback sample" note={`${classified.summary.source} · ${classified.summary.accepted.toLocaleString()} of ${classified.summary.total.toLocaleString()}`} unit="feedback records" counts={classified.hitmap} segments={summary.segments} /> : null}
      </div>
      {measured && <div className="mt-3 rounded-lg border border-border bg-background p-4 text-sm">
        <h4 className="font-medium">Measured sandbox outcomes</h4>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          <Stat value={measured.episodes} label="verified discounts" tone="text-observed" />
          <Stat value={measured.cancellations} label="ambiguous cancellations" />
        </div>
        <Fine label="Details">
          <p className="mt-1">{snapshot ? "Evidence snapshot used for this run." : "Evidence snapshot at page load."}</p>
          <p className="mt-1">{measured.episodes} verified discount episodes · {measured.subscriberMonths.toFixed(3)} observed discounted subscriber-months (30 days/month).</p>
          <p className="mt-1">{measured.cancellations} ambiguous cancellation facts · {measured.censoredEpisodes} episodes excluded, including preceding survival.</p>
          <p className="mt-1">Calibration: {measured.posteriorSubscriberMonths.toFixed(3)} subscriber-months · {measured.posteriorCancellations} qualified posterior cancellations.</p>
          {changes?.length ? <ul className="mt-2 space-y-1">{changes.map(change => <li key={change.parameter}>{change.parameter}: mean {change.before.mean.toFixed(4)} → {change.after.mean.toFixed(4)} · {change.evidence}</li>)}</ul> : <p className="mt-1">No measured effect parameter changes. A price override alone is not retention evidence.</p>}
          <p className="mt-2">{measured.limitation}</p>
        </Fine>
      </div>}
      {annual && <AnnualOfferEvidence annual={annual} segments={summary.segments} live={!!liveAnnual} runDisplayed={!!snapshot} />}
      {(measured || annual) && <p className="mt-3 text-xs text-muted">Small sandbox sample, not proof of cause.</p>}
      <details className="mt-3 border-t border-border pt-2 text-sm">
        <summary className="min-h-10 cursor-pointer pt-2 font-medium text-brand-accent">Full evidence and sources</summary>
        {!imported && source && !snapshot && <p className="mt-2 text-muted">Measured evidence snapshot unavailable for this run.</p>}
        {imported && (!imported.reasonCounts || imported.feedbackRows === 0) && <p className="mt-2 text-muted">No feedback imported, so leaving reasons are unknown: price-reason targeting is unavailable and reason shares stay prior assumptions.</p>}
        {!imported && !classified && <p className="mt-2 text-muted">{source === "manual" ? "Manual comparison: no AI classification applied." : "No feedback classified in this run."}</p>}
        {classified && <p className="mt-2 text-muted">{classified.summary.provider} / {classified.summary.model}. Feedback records are a separate sample, not a share of the active population or proof that an offer caused retention.</p>}
        {imported && imported.feedbackRows > 0 && <p className="mt-2 text-muted">Feedback rows are a separate sample, not a share of the active population or proof that an offer caused retention.</p>}
        <p className="mt-2 text-muted">{imported ? "Estimated from your CSV with merchant-entered economics; price sensitivity, annual uptake and discount effects stay assumptions. Simulate only." : source === "manual" ? "Canonical synthetic twin estimates with separately measured sandbox effects and registered pilots." : classified ? "Classified synthetic feedback updates reason estimates; measured effects, historical estimates and intervention assumptions remain distinct." : "Current synthetic history, measured sandbox effects and model assumptions."}</p>
        <ul className="mt-2 space-y-2">{Object.entries(provenance).map(([key, item]) => (
          <li key={key} className="flex min-w-0 flex-wrap gap-2"><span className={`h-fit shrink-0 rounded border px-1.5 text-xs font-medium ${item.source === "observed" ? "border-observed/50 text-observed" : item.source === "assumption" ? "border-sim/50 text-sim" : "border-brand/50 text-brand"}`}>{item.source}</span><span className="min-w-0 text-muted">{item.note}</span></li>
        ))}</ul>
      </details>
    </aside>
  );
}

/** How many of the model's inputs are estimated, observed or assumed: the quickest read on how much to trust a result. */
function TrustBar({ provenance }: { provenance: Record<string, { source: string }> }) {
  const items = Object.values(provenance);
  if (!items.length) return null;
  const parts = [
    { source: "estimated", label: "Estimated", bar: "bg-brand", text: "text-brand-accent" },
    { source: "observed", label: "Observed", bar: "bg-observed", text: "text-observed" },
    { source: "assumption", label: "Assumed", bar: "bg-sim", text: "text-sim" },
  ].map(part => ({ ...part, count: items.filter(item => item.source === part.source).length })).filter(part => part.count > 0);
  return (
    <div className="text-sm">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">{parts.map(part => <div key={part.source} className={part.bar} style={{ flexGrow: part.count }} />)}</div>
      <p className="mt-1.5 flex flex-wrap gap-x-4 text-xs">{parts.map(part => <span key={part.source} className={part.text}>{part.label} {part.count}</span>)}<span className="text-muted">of {items.length} inputs</span></p>
    </div>
  );
}

function Stat({ value, label, tone = "" }: { value: number; label: string; tone?: string }) {
  return <span><span className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</span> <span className="text-muted">{label}</span></span>;
}

function Fine({ label, children }: { label: string; children: ReactNode }) {
  return <details className="mt-2 text-muted"><summary className="min-h-8 cursor-pointer pt-1 text-xs font-medium text-brand-accent">{label}</summary>{children}</details>;
}

function FeedbackBars({ title, note, unit, counts, segments }: { title: string; note: string; unit: string; counts: Partial<Record<string, { price: number; other: number }>>; segments: MerchantSummary["segments"] }) {
  const most = Math.max(1, ...segments.map(segment => (counts[segment.id]?.price ?? 0) + (counts[segment.id]?.other ?? 0)));
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background p-4">
      <h4 className="font-medium">{title}</h4>
      <p className="mt-1 text-xs text-muted">{note}</p>
      <p className="mt-2 flex gap-4 text-xs"><span className="text-brand-accent">Price</span><span className="text-sim">Other</span></p>
      <ul className="mt-2 space-y-2">{segments.map(segment => {
        const price = counts[segment.id]?.price ?? 0, other = counts[segment.id]?.other ?? 0, total = price + other;
        return (
          <li key={segment.id} role="img" aria-label={`${segment.label}: ${total} ${unit} · ${price} price · ${other} other`}>
            <div className="flex justify-between gap-2"><span className="min-w-0">{segment.label}</span><span className="tabular-nums text-muted">{total}</span></div>
            <div className="mt-1 flex h-1.5 gap-px overflow-hidden rounded-full bg-raised" style={{ width: `${Math.max(2, (total / most) * 100)}%` }}><div className="bg-brand" style={{ flexGrow: price }} /><div className="bg-sim" style={{ flexGrow: other }} /></div>
          </li>
        );
      })}</ul>
    </div>
  );
}

function AnnualOfferEvidence({ annual, segments, live, runDisplayed }: { annual: AnnualEvidence; segments: MerchantSummary["segments"]; live: boolean; runDisplayed: boolean }) {
  const label = (id: string) => segments.find((segment) => segment.id === id)?.label ?? id.replaceAll("_", " ");
  const total = (key: "accepted" | "declined" | "unresolved") => annual.offers.reduce((sum, offer) => sum + offer[key], 0);
  const uptake = annual.changes.flatMap((change) => {
    const segment = /^segments\.(\w+)\.annualUptake$/.exec(change.parameter)?.[1];
    return segment ? [`${label(segment)} uptake ${Math.round(change.before.mean * 100)}% → ${Math.round(change.after.mean * 100)}%`] : [];
  });
  return (
    <section className="mt-3 rounded-lg border border-border bg-background p-4 text-sm" aria-labelledby="annual-evidence-title">
      <h4 id="annual-evidence-title" className="font-medium">Annual offers</h4>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1" aria-hidden="true">
        <Stat value={total("accepted")} label="accepted" tone="text-positive" />
        <Stat value={total("declined")} label="declined" />
        <Stat value={total("unresolved")} label="waiting" tone="text-brand-accent" />
      </div>
      {uptake.map((line) => <p key={line} className="mt-2 font-medium tabular-nums text-observed">{line}</p>)}
      <Fine label="Details">
        {live && <p className="mt-1">Current ledger, updated by the latest PayPal check.{runDisplayed && " The displayed run used the evidence snapshot above."}</p>}
        <p className="mt-1" aria-live="polite">{total("accepted")} accepted · {total("declined")} declined · {total("unresolved")} awaiting decision or final check</p>
        {annual.offers.length > 0 && <ul className="mt-2 space-y-1">{annual.offers.map((offer) => (
          <li key={offer.segment}>{label(offer.segment)}: {offer.accepted} accepted · {offer.declined} declined · {offer.unresolved} awaiting decision or final check</li>
        ))}</ul>}
        {annual.changes.length
          ? <ul className="mt-2 space-y-1">{annual.changes.map((change) => <li key={change.parameter}>{change.parameter}: mean {change.before.mean.toFixed(4)} → {change.after.mean.toFixed(4)} · {change.evidence}</li>)}</ul>
          : <p className="mt-1">No uptake estimate has changed: only switched or confirmed-declined offers update it.</p>}
        <p className="mt-2">{annual.limitation}</p>
      </Fine>
    </section>
  );
}

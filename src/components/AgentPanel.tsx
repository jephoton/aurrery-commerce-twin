"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/agent/contracts";
import { AgentSession } from "./agent-session";

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString()}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
export function AgentActivity({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "observed_snapshot": return <p className="text-muted">Loaded measured evidence: {event.snapshot.evidence.posteriorSubscriberMonths.toFixed(3)} qualified discounted subscriber-months for this run.</p>;
    case "status": case "summary": return <p className="whitespace-pre-wrap text-muted">{event.message}</p>;
    case "wait": return <p>{event.message} Waiting about {Math.ceil(event.durationMs / 1000)} seconds; Stop remains available.</p>;
    case "tool_started": return <p className="text-muted">Running {event.name.replaceAll("_", " ")}…</p>;
    case "tool_result": return <p className={event.result.ok ? "text-muted" : "text-negative"}>{event.name.replaceAll("_", " ")}: {event.result.ok ? "finished" : `${event.result.code} · ${event.result.message}`}</p>;
    case "classification": {
      const s = event.summary;
      return (
        <div>
          <p className="font-medium">{s.source} · {s.provider} / {s.model}</p>
          <p>{s.accepted}/{s.total} accepted · {s.cacheHits} cached · {Math.max(0, s.accepted - s.cacheHits)} fresh accepted · {s.unclassified} unclassified · {s.eligiblePilotCount}/{s.pilotCount} eligible pilots{s.stopped ? " · classification stopped" : ""}</p>
          <p className="text-muted">{s.mappingIssueCount} pilot mapping issues. {Object.entries(event.hitmap).map(([id, counts]) => `${id.replaceAll("_", " ")}: ${counts.price} price / ${counts.other} other`).join("; ")}.</p>
        </div>
      );
    }
    case "rules": return <p>Decision rules: discount budget {money(event.rules.discountBudget)} · chance of worse value ≤ {pct(event.rules.maxProbWorse)} · {event.rules.horizonMonths}-month horizon.</p>;
    case "comparison": return (
      <div>
        <p className="font-medium">Paired simulation · {event.comparison.options.runs.toLocaleString()} futures · {event.comparison.options.horizonMonths} months</p>
        <ul className="mt-1 space-y-1">
          {event.comparison.strategies.filter(s => s.strategy.id !== event.comparison.baselineId).map(s => (
            <li key={s.strategy.id}>{s.strategy.name}: median Δ value {money(s.vsBaseline.totalValue.p50)} ({money(s.vsBaseline.totalValue.p10)} … {money(s.vsBaseline.totalValue.p90)}); {pct(s.probValueBelowBaseline)} chance worse; mean discount {money(s.metrics.discountCost.mean)}.</li>
          ))}
        </ul>
        <p className="text-muted">Each difference is paired against this simulation&apos;s do-nothing baseline. Full results appear in the comparison below.</p>
      </div>
    );
    case "stress": return (
      <div>
        <p className="font-medium">Adverse stress · {event.strategyId}</p>
        <p>Median Δ value: base {money(event.stress.base.vsBaseline.totalValue.p50)} → stressed {money(event.stress.stressed.vsBaseline.totalValue.p50)}. Stressed 80% interval {money(event.stress.stressed.vsBaseline.totalValue.p10)} … {money(event.stress.stressed.vsBaseline.totalValue.p90)}; {pct(event.stress.stressed.probValueBelowBaseline)} chance worse.</p>
        <p className="text-muted">Source: adverse shifts to assumption parameters only; base and stress each use their own paired baseline. Approximate 80th/20th-percentile scenario.</p>
        <ul className="mt-1 list-inside list-disc">{event.stress.shifted.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
    );
    case "draft": return (
      <div>
        <p className="font-medium">Customer message · Display only · {event.strategyId}</p>
        <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">{event.message}</blockquote>
        <p className="text-muted">This draft has not been sent.</p>
      </div>
    );
    case "proposal": return (
      <div>
        <p className="font-medium">Proposed: {event.proposal.strategy?.name ?? "Recovery action"}</p>
        <p>{event.rationale}</p>
        <p className="text-muted">Tradeoffs: {event.tradeoffs}</p>
        <p>Review the exact action in Approval below. Merchant confirmation is required.</p>
      </div>
    );
    case "error": return <p role="alert" className="text-negative">{event.message} ({event.code})</p>;
    // The status below changes only after the decoder verifies the full stream.
    case "done": return null;
  }
}

export function AgentPanel({ objective, disabled, onStart, onEvent, onFinish }: {
  objective: string; disabled: boolean;
  onStart(): void; onEvent(event: AgentEvent): void; onFinish(): void;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState("Ready to investigate. Proposals require separate merchant approval.");
  const [running, setRunning] = useState(false);
  const session = useRef(new AgentSession());
  useEffect(() => { const current = session.current; return () => current.stop(); }, []);

  const start = async () => {
    if (disabled || session.current.active || !objective.trim() || objective.trim().length > 2000) return;
    setEvents([]); setRunning(true); setStatus("Agent running…"); onStart();
    await session.current.run(objective, {
      onEvent(event) {
        setEvents(previous => [...previous, event].slice(-120));
        onEvent(event);
      },
      onResult: done => setStatus(done.status === "complete" ? "Investigation complete. Review the proposal and uncertainty before approving." : `Run ${done.status}: ${done.reason ?? "no completed recommendation"}.`),
      onError: setStatus,
      onFinish() { setRunning(false); onFinish(); },
    });
  };
  const stop = () => {
    if (!session.current.active) return;
    session.current.stop();
    setRunning(false); setStatus("Run cancelled. Any visible proposal still requires separate approval."); onFinish();
  };
  return (
    <div className="mt-5 border-t border-border pt-5" aria-label="Agent activity">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={start} disabled={disabled || running || !objective.trim() || objective.trim().length > 2000} className="min-h-10 rounded-lg bg-brand px-5 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50">Run agent <span aria-hidden="true" className="ml-1">↗</span></button>
        {running && <button type="button" onClick={stop} className="min-h-10 rounded-lg border border-border px-4 py-2 font-medium hover:bg-background">Stop agent</button>}
        <p role="status" className="min-w-0 text-sm text-muted">{status}</p>
      </div>
      {!!events.length && (
        <div role="log" aria-label="Agent public activity" aria-live="polite" aria-relevant="additions" className="mt-5 max-h-[32rem] overflow-y-auto rounded-lg border border-border bg-background p-4 sm:p-5">
          <p className="eyebrow mb-4">Live activity · public agent output</p>
          <ol className="space-y-3 text-sm">
            {events.map((event, i) => event.type !== "done" && (
              <li key={i} className="border-b border-border pb-3 last:border-0 last:pb-0"><AgentActivity event={event} /></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

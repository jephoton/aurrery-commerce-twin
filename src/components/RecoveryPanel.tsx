"use client";

import { useCallback, useEffect, useState } from "react";
import type { Proposal } from "@/ledger/proposals";
import type { ExecutionReport } from "@/execution/execute";
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { ResetPreview } from "@/execution/reset";

type Listed = Proposal & { executions: { ok: boolean; verified: boolean }[] };
type OutstandingPage = { proposals: Proposal[]; nextCursor: string | null };
type Props = { canReview: boolean; paypalConfigured: boolean; onObservedChange: () => Promise<boolean> };

export function pendingActions(proposals: Proposal[]): Proposal[] {
  return proposals.filter((proposal) => proposal.action.type !== "subscription_price_override"
    ? ["proposed", "approved", "executing"].includes(proposal.status)
    : ["approved", "executing"].includes(proposal.status));
}

/** An execution error can follow a successful earlier target, so refresh facts even on rejection. */
export async function runRecoveryAttempt<T>(
  mutate: () => Promise<T>, refreshStatus: () => Promise<boolean>, readEvidence: () => Promise<DiscountEvidence>,
  setEvidence: (value: DiscountEvidence | null) => void,
): Promise<T> {
  setEvidence(null);
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try { result = await mutate(); }
  catch (error) { failure = error; failed = true; }
  try {
    if (await refreshStatus()) setEvidence(await readEvidence());
    else setEvidence(null);
  } catch { setEvidence(null); }
  if (failed) throw failure;
  return result as T;
}

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error ?? "Request unavailable.");
  return data as T;
}

export function RecoveryPanel({ canReview, paypalConfigured, onObservedChange }: Props) {
  const [sources, setSources] = useState<Listed[]>([]);
  const [pending, setPending] = useState<Proposal[]>([]);
  const [outstandingCursor, setOutstandingCursor] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [currentEvidence, setCurrentEvidence] = useState<DiscountEvidence | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSkipped, setResetSkipped] = useState<ResetPreview["skipped"] | null>(null);
  const reload = useCallback(async (selectedId?: string) => {
    const [data, outstanding, selected] = await Promise.all([
      json<{ proposals: Listed[] }>("/api/proposals"), json<OutstandingPage>("/api/proposals/outstanding"),
      selectedId ? json<{ proposal: Proposal }>(`/api/proposals/${encodeURIComponent(selectedId)}`).catch(() => null) : Promise.resolve(null),
    ]);
    setSources(data.proposals.filter((p) => p.action.type === "subscription_price_override" &&
      ["succeeded", "partially_failed"].includes(p.status) && p.executions.some((execution) => execution.ok && execution.verified)));
    setPending(pendingActions(outstanding.proposals));
    setOutstandingCursor(outstanding.nextCursor);
    if (selectedId) setProposal(selected?.proposal ?? null);
  }, []);
  useEffect(() => {
    void Promise.all([json<{ proposals: Listed[] }>("/api/proposals"), json<OutstandingPage>("/api/proposals/outstanding")])
      .then(([data, outstanding]) => {
        setSources(data.proposals.filter((p) => p.action.type === "subscription_price_override" &&
          ["succeeded", "partially_failed"].includes(p.status) && p.executions.some((execution) => execution.ok && execution.verified)));
        setPending(pendingActions(outstanding.proposals));
        setOutstandingCursor(outstanding.nextCursor);
      })
      .catch(() => setError("Proposal history unavailable."));
  }, []);

  const loadMore = async () => {
    if (!outstandingCursor || busy) return;
    setBusy(true); setError(null);
    try {
      const page = await json<OutstandingPage>(`/api/proposals/outstanding?cursor=${encodeURIComponent(outstandingCursor)}`);
      setPending((current) => {
        const known = new Set(current.map((proposal) => proposal.id));
        return [...current, ...pendingActions(page.proposals).filter((proposal) => !known.has(proposal.id))];
      });
      setOutstandingCursor(page.nextCursor);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  const prepare = async (sourceProposalId: string) => {
    if (busy) return;
    setBusy(true); setError(null); setReport(null); setConfirmed(false); setCurrentEvidence(null); setResetSkipped(null);
    try {
      const result = await json<{ proposal: Proposal }>("/api/proposals/revert", { sourceProposalId });
      setProposal(result.proposal);
      await reload(result.proposal.id);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const prepareReset = async () => {
    if (busy || !canReview) return;
    setBusy(true); setError(null); setReport(null); setProposal(null); setConfirmed(false); setCurrentEvidence(null); setResetSkipped(null);
    try {
      const result = await json<ResetPreview>("/api/proposals/reset", {});
      setProposal(result.proposal); setResetSkipped(result.skipped);
      await reload(result.proposal?.id);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const act = async (resume: boolean) => {
    if (!proposal || !confirmed || !canReview || busy) return;
    setBusy(true); setError(null); setCurrentEvidence(null); setReport(null);
    try {
      const result = await runRecoveryAttempt(
        () => json<ExecutionReport>(!resume && proposal.action.type === "subscription_price_reset"
          ? `/api/proposals/reset/${proposal.id}/confirm` : `/api/proposals/${proposal.id}/${resume ? "execute" : "approve"}`,
          resume || proposal.action.type === "subscription_price_reset" ? { actionHash: proposal.actionHash, confirmed: true } : { actionHash: proposal.actionHash, approvedBy: "merchant (demo)" }),
        onObservedChange,
        async () => (await json<{ evidence: DiscountEvidence }>("/api/twin")).evidence,
        setCurrentEvidence,
      );
      setReport(result); setProposal(result.proposal);
    } catch (failure) { setError((failure as Error).message); }
    finally {
      setConfirmed(false);
      try { await reload(proposal.id); } catch { setProposal(null); }
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!proposal || busy || !canReview) return;
    setBusy(true); setError(null);
    try { const result = await json<{ proposal: Proposal }>(`/api/proposals/${proposal.id}/reject`, {}); setProposal(result.proposal); await reload(result.proposal.id); }
    catch (failure) { setError((failure as Error).message); }
    finally { setConfirmed(false); setBusy(false); }
  };
  return (
    <section className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="recovery-title">
      <h2 id="recovery-title" className="text-lg font-semibold">Restore a verified discount</h2>
      <p className="mt-1 text-sm text-muted">Prepare a separate proposed action from a completed discount. Its exact targets and original list prices need a fresh merchant approval.</p>
      {canReview && <div className="mt-4 border-t border-border pt-4">
        <h3 className="font-medium">Administrator demo reset</h3>
        <p className="mt-1 text-sm text-muted">Preview currently registered active demo pilots away from the current list price. Review and confirm the exact proposal before any price change. History is preserved.</p>
        <button type="button" disabled={busy || !paypalConfigured} onClick={() => void prepareReset()} className="mt-2 min-h-10 rounded-lg border border-border px-3 hover:bg-background disabled:opacity-50">Preview demo reset</button>
      </div>}
      {resetSkipped && <div role="status" className="mt-3 text-sm">
        {!proposal && <p>No active off-list registered pilots require a reset.</p>}
        <ul>{resetSkipped.map((pilot) => <li key={pilot.label}>{pilot.label}{pilot.subscriptionId ? ` (${pilot.subscriptionId})` : ""}: {pilot.reason.replaceAll("_", " ")}</li>)}</ul>
      </div>}
      {sources.length > 0 && <ul className="mt-4 space-y-2">{sources.map((source) => <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="break-all font-mono">{source.id} · {source.status}</span>
        <button type="button" disabled={busy} onClick={() => void prepare(source.id)} className="min-h-10 rounded-lg border border-border px-3 hover:bg-background disabled:opacity-50">Preview restoration</button>
      </li>)}</ul>}
      {pending.length > 0 && <div className="mt-5 border-t border-border pt-4">
        <h3 className="font-medium">Outstanding approved and recovery actions</h3>
        <p className="mt-1 text-sm text-muted">Choose an action to inspect its current ledger state. Selection never approves or executes it.</p>
        <ul className="mt-2 space-y-2">{pending.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="break-all font-mono">{item.id} · {item.action.type === "subscription_price_revert" ? "restoration" : item.action.type === "subscription_price_reset" ? "demo reset" : "discount"} · {item.status}</span>
          <button type="button" disabled={busy} onClick={() => { setProposal(item); setConfirmed(false); setReport(null); setCurrentEvidence(null); setError(null); setResetSkipped(null); }} className="min-h-10 rounded-lg border border-border px-3 hover:bg-background disabled:opacity-50">Review action</button>
        </li>)}</ul>
        {outstandingCursor && <button type="button" disabled={busy} onClick={() => void loadMore()} className="mt-3 min-h-10 rounded-lg border border-border px-3 hover:bg-background disabled:opacity-50">Load more outstanding actions</button>}
      </div>}
      {proposal && proposal.action.type !== "subscription_price_override" && <RecoveryReview proposal={proposal} confirmed={confirmed} canReview={canReview} paypalConfigured={paypalConfigured} busy={busy}
        onConfirm={setConfirmed} onApprove={() => void act(false)} onResume={() => void act(true)} onReject={() => void reject()} />}
      {proposal?.action.type === "subscription_price_override" && <DiscountResumeReview proposal={proposal} confirmed={confirmed} canReview={canReview} paypalConfigured={paypalConfigured} busy={busy}
        onConfirm={setConfirmed} onResume={() => void act(true)} />}
      {report && <p className="mt-3 text-sm">Recovery {report.proposal.status.replaceAll("_", " ")}: {report.outcomes.filter((outcome) => outcome.ok && outcome.verified).length} of {report.outcomes.length} target(s) verified · {report.outcomes.filter((outcome) => outcome.skipped).length} already at list price. Current PayPal prices can be checked below; the run&apos;s simulation snapshot remains historical.</p>}
      {currentEvidence && <p className="mt-2 text-sm text-muted">Current ledger after the action attempt: {currentEvidence.episodes} verified discount episodes · {currentEvidence.subscriberMonths.toFixed(3)} observed discounted subscriber-months. Previous run evidence snapshots remain as recorded.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
    </section>
  );
}

export function DiscountResumeReview({ proposal, confirmed, canReview, paypalConfigured, busy, onConfirm, onResume }: {
  proposal: Proposal; confirmed: boolean; canReview: boolean; paypalConfigured: boolean; busy: boolean;
  onConfirm: (value: boolean) => void; onResume: () => void;
}) {
  if (proposal.action.type !== "subscription_price_override" || !["approved", "executing"].includes(proposal.status)) return null;
  const action = proposal.action;
  return <div className="mt-4 border-t border-border pt-4 text-sm">
    <p><strong>Approved discount:</strong> ${action.listPrice} → ${action.newPrice} for {action.targets.length} registered pilot(s).</p>
    <p><strong>Targets:</strong> <span className="break-all font-mono">{action.targets.join(", ")}</span></p>
    <p><strong>Payload hash:</strong> <span className="break-all font-mono">{proposal.actionHash}</span></p>
    {proposal.status === "approved" ? <>
      <p className="mt-2 text-muted">The prior approval remains recorded. This separate merchant request checks the exact hash and current state before any PayPal call.</p>
      <label className="mt-3 flex min-h-10 items-center gap-3"><input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(event) => onConfirm(event.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
        I confirm executing this already approved discount for {action.targets.length} PayPal Sandbox subscription(s).</label>
      <button type="button" disabled={!confirmed || busy || !canReview || !paypalConfigured} onClick={onResume} className="mt-2 min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background disabled:opacity-50">Execute approved discount</button>
    </> : <p className="mt-2 text-negative">Execution outcome requires ledger and PayPal reconciliation. Do not retry the PayPal action.</p>}
  </div>;
}

export function RecoveryReview({ proposal, confirmed, canReview, paypalConfigured, busy, onConfirm, onApprove, onResume, onReject }: {
  proposal: Proposal; confirmed: boolean; canReview: boolean; paypalConfigured: boolean; busy: boolean;
  onConfirm: (value: boolean) => void; onApprove: () => void; onResume?: () => void; onReject: () => void;
}) {
  if (proposal.action.type === "subscription_price_override") return null;
  const action = proposal.action;
  const reset = action.type === "subscription_price_reset";
  return <div className="mt-4 border-t border-border pt-4 text-sm">
    {action.type === "subscription_price_revert" && <p><strong>Source:</strong> <span className="break-all font-mono">{action.sourceProposalId}</span></p>}
    <p><strong>Payload hash:</strong> <span className="break-all font-mono">{proposal.actionHash}</span></p>
    <p className="mt-2">No simulated recovery benefit is claimed. {reset ? "This resets only the registered demo targets below to the canonical list price." : "This restores the original list price of the verified discounted targets below."}</p>
    <ul className="mt-2 list-inside list-disc">{action.targets.map((target) => <li key={target.subscriptionId} className="break-all font-mono">{target.subscriptionId}: ${target.expectedCurrentPrice} → ${action.type === "subscription_price_reset" ? action.canonicalListPrice : "listPrice" in target ? target.listPrice : ""}</li>)}</ul>
    <p className="mt-2">Status: {proposal.status.replaceAll("_", " ")}. PayPal is read before each price change; a concurrent external price change between that read and PATCH may not be detected.</p>
    {(proposal.status === "proposed" || proposal.status === "approved") && <>
      <label className="mt-3 flex min-h-10 items-center gap-3"><input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(event) => onConfirm(event.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
        I confirm {reset ? "resetting" : "restoring"} these {action.targets.length} PayPal Sandbox subscription price(s).</label>
      <div className="mt-2 flex gap-3">
        <button type="button" disabled={!confirmed || busy || !canReview || !paypalConfigured} onClick={proposal.status === "approved" ? onResume : onApprove} className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background disabled:opacity-50">
          {reset ? proposal.status === "approved" ? "Execute approved reset" : "Confirm & reset" : proposal.status === "approved" ? "Execute approved restoration" : "Approve & restore"}</button>
        {proposal.status === "proposed" && <button type="button" disabled={busy || !canReview} onClick={onReject} className="min-h-10 rounded-lg border border-border px-4">Reject</button>}
      </div>
    </>}
    {proposal.status === "executing" && <p className="mt-2 text-negative">Execution outcome requires ledger and PayPal reconciliation. Do not retry the PayPal action.</p>}
  </div>;
}

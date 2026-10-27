"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { AgentEvent } from "@/agent/contracts";
import type { ExecutionReport } from "@/execution/execute";
import type { Proposal } from "@/ledger/proposals";
import type { Strategy } from "@/twin/interventions";
import { ObservedSnapshotSchema, type ObservedComparison } from "@/merchant/observed-snapshot";
import type { Provenance, SegmentId } from "@/twin/types";
import type { DiscountEvidence } from "@/ledger/discount-outcomes";
import type { ParameterChange } from "@/twin/calibrate";
import { FanChart } from "./FanChart";
import { ScenarioGrid, toRows } from "./ScenarioGrid";
import { AgentPanel } from "./AgentPanel";
import { dashboardReducer, emptyDashboard } from "./lab-state";
import { DecisionSummary } from "./DecisionSummary";
import { EvidencePanel } from "./EvidencePanel";
import { MerchantOverview } from "./MerchantOverview";
import { AdminAccess } from "./AdminAccess";
import { canReviewAccess, type AccessState } from "./admin-access";

export interface MerchantSummary {
  name: string;
  description: string;
  planName: string;
  asOfMonth: string;
  listPrice: number;
  active: number;
  mrr: number;
  lastMonthChurnRate: number;
  segments: { id: SegmentId; label: string; active: number; churn: number }[];
  provenance: Record<string, Provenance>;
  observedEvidence?: DiscountEvidence;
  parameterChanges?: ParameterChange[];
}

interface PayPalStatus {
  configured: boolean;
  planId: string | null;
  subscriptions: {
    subscriptionId: string;
    label: string;
    segment: string;
    reason: string;
    live?: { status: string; regularPrice: string | null; planOverridden: boolean; nextBillingTime: string | null };
    error?: string;
  }[];
}

const DEFAULT_OBJECTIVE =
  "Churn among at-risk subscribers is eating our growth. Find the most valuable way to keep them without giving away margin we don't need to.";

const money = (v: number) => `$${Math.round(v).toLocaleString()}`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function Lab({ summary, starterStrategies }: { summary: MerchantSummary; starterStrategies: Strategy[] }) {
  const [objective, setObjective] = useState(DEFAULT_OBJECTIVE);
  const [{ comparison, selectedId, proposal, proposalSource, report, confirmed, evidence, comparisonSource, rules, stress, observedSnapshot }, dispatch] = useReducer(dashboardReducer, emptyDashboard);
  const [paypal, setPayPal] = useState<PayPalStatus | null>(null);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [busy, setBusy] = useState<"simulate" | "propose" | "execute" | "reject" | "agent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setConfirmed = (value: boolean) => dispatch({ type: "confirmed", value });
  const startAgent = useCallback(() => { setBusy("agent"); setError(null); dispatch({ type: "reset" }); }, []);
  const agentEvent = useCallback((event: AgentEvent) => dispatch({ type: "event", event }), []);
  const finishAgent = useCallback(() => setBusy(null), []);

  const refreshPayPal = useCallback(() => {
    api<PayPalStatus>("/api/paypal/status").then(setPayPal).catch((e) => setError(e.message));
  }, []);
  useEffect(refreshPayPal, [refreshPayPal]);
  useEffect(() => { api<AccessState>("/api/admin/session").then(setAccess).catch(() => setError("Administrator access unavailable.")); }, []);

  const simulate = async () => {
    if (busy) return;
    setBusy("simulate");
    setError(null);
    dispatch({ type: "reset" });
    try {
      const { observedSnapshot, ...comparison } = await api<ObservedComparison>("/api/simulate", { method: "POST", body: JSON.stringify({ strategies: starterStrategies }) });
      dispatch({ type: "comparison", comparison, source: "manual", observedSnapshot: ObservedSnapshotSchema.parse(observedSnapshot) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const selected = comparison?.strategies.find((s) => s.strategy.id === selectedId) ?? null;
  const baseline = comparison?.strategies.find((s) => s.strategy.id === comparison.baselineId) ?? null;
  const rows = useMemo(() => (comparison ? toRows(comparison.strategies, comparison.baselineId) : []), [comparison]);

  const propose = async () => {
    if (!selected || busy) return;
    setBusy("propose");
    setError(null);
    dispatch({ type: "clear-review" });
    try {
      const { proposal } = await api<{ proposal: Proposal }>("/api/proposals", {
        method: "POST",
        body: JSON.stringify({ objective, strategy: selected.strategy }),
      });
      dispatch({ type: "proposal", proposal });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!proposal || busy || !confirmed || !canReviewAccess(access)) return;
    setBusy("execute");
    setError(null);
    try {
      const result = await api<ExecutionReport>(`/api/proposals/${proposal.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ actionHash: proposal.actionHash, approvedBy: "merchant (demo)" }),
      });
      dispatch({ type: "report", report: result });
      refreshPayPal();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!proposal || busy || !canReviewAccess(access)) return;
    setBusy("reject"); setError(null);
    try {
      const { proposal: p } = await api<{ proposal: Proposal }>(`/api/proposals/${proposal.id}/reject`, { method: "POST", body: "{}" });
      dispatch({ type: "proposal-updated", proposal: p });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const executable = selected?.strategy.intervention.kind === "targeted_discount";

  return (
    <main className="mx-auto w-full min-w-0 max-w-[1440px] px-4 pb-12 pt-5 sm:px-7 lg:px-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 items-center gap-4">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight text-foreground">Aurrery <span className="ml-2 align-middle text-[10px] font-medium uppercase tracking-[.2em] text-brand-accent">Decision lab</span></p>
            <p className="text-sm text-muted">{summary.name} · {summary.planName} · synthetic demo</p>
          </div>
        </div>
        <span
          className={`source-badge ${paypal?.configured ? "text-positive" : "text-muted"}`}
        >
          PayPal Sandbox: {paypal ? (paypal.configured ? "connected" : "not configured") : "checking…"}
        </span>
      </header>

      {error && <div role="alert" className="mb-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{error}</div>}
      <AdminAccess state={access} onChange={(value) => { setAccess(value); setConfirmed(false); }} />

      <DecisionSummary selected={selected} proposal={proposal} proposalSource={proposalSource} rules={rules} stress={stress} horizonMonths={comparison?.options.horizonMonths ?? null} source={comparisonSource} busy={busy !== null} />

      <section className="mb-6 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="objective-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="objective-title" className="text-lg font-semibold">Set the objective</h2>
          <span className="text-xs text-muted">Agent investigation or manual comparison</span>
        </div>
        <label htmlFor="objective" className="sr-only">Business objective</label>
        <textarea
          id="objective"
          value={objective}
          disabled={busy !== null}
          maxLength={2000}
          onChange={(e) => {
            setObjective(e.target.value);
            dispatch({ type: "objective-edited" });
          }}
          rows={2}
          className="w-full min-w-0 rounded-lg border border-border bg-background px-4 py-3 text-foreground outline-none placeholder:text-muted focus:border-brand-accent"
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={simulate}
            disabled={busy !== null}
            className="min-h-10 rounded-lg border border-border px-4 py-2 font-medium text-foreground hover:border-brand-accent disabled:opacity-50"
          >
            {busy === "simulate" ? "Simulating 1,000 futures…" : "Simulate strategies"}
          </button>
          <span className="text-sm text-muted">{starterStrategies.length} candidates · 1,000 futures each · 12-month horizon</span>
        </div>
        <AgentPanel objective={objective} disabled={busy !== null} onStart={startAgent} onEvent={agentEvent} onFinish={finishAgent} />
      </section>

      <div className="mb-6"><MerchantOverview summary={summary} /></div>

      {comparison && (
        <section className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Scenario comparison</h2>
            <span className="source-badge">Simulated, not observed</span>
          </div>
          <ScenarioGrid rows={rows} selectedId={selectedId} disabled={busy !== null} horizonMonths={comparison.options.horizonMonths} onSelect={(id) => { if (!busy) dispatch({ type: "select", id }); }} />
          <p className="mt-2 text-xs text-muted">
            Value = {comparison.options.horizonMonths}-month gross profit + discounted margin of the subscribers remaining at month {comparison.options.horizonMonths} (next 24 months, 1%/mo). Differences are paired
            against the baseline under common random numbers.
          </p>
        </section>
      )}

      {selected && baseline && (
        <section className="mb-6 grid min-w-0 gap-6 lg:grid-cols-5">
          <div className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6 lg:col-span-3">
            <h2 className="mb-1 text-lg font-semibold">{selected.strategy.name}</h2>
            <p className="mb-4 text-muted">{selected.description}</p>
            <FanChart
              title="Active subscribers"
              format={(v) => Math.round(v).toLocaleString()}
              series={[
                { label: "Do nothing", band: baseline.activeBand, color: "#abb8cb", baseline: true },
                { label: selected.strategy.name, band: selected.activeBand, color: "#e6bd69" },
              ]}
            />
          </div>
          <div className="min-w-0 lg:col-span-2"><EvidencePanel summary={summary} evidence={evidence} source={comparisonSource} snapshot={observedSnapshot} /></div>
        </section>
      )}

      {selected && selected.strategy.id !== comparison?.baselineId && (
        <section id="approval" aria-labelledby="approval-title" className="mb-6 min-w-0 scroll-mt-5 rounded-2xl border border-brand/50 bg-surface p-5 sm:p-6">
          <p className="eyebrow mb-2">Merchant confirmation boundary</p>
          <h2 id="approval-title" className="mb-1 text-xl font-semibold">Approval · review exact action</h2>
          {!executable ? (
            <p className="text-muted">
              This strategy is simulate-only in this build. PayPal route: <span className="font-mono text-sm">{selected.paypalAction}</span>
            </p>
          ) : !proposal ? (
            <>
              <p className="mb-3 text-muted">Prepare the exact PayPal action for review. Nothing is sent to PayPal until you approve it.</p>
              {comparisonSource === "agent" && <p className="mb-3 text-sm text-muted">Manual preparation uses canonical twin estimates and registered pilots. The agent&apos;s classified pilot filter applies only to its own proposal.</p>}
              <button
                onClick={propose}
                disabled={busy !== null}
                className="min-h-10 rounded-lg border border-brand px-4 py-2 font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
              >
                {busy === "propose" ? "Preparing…" : "Prepare PayPal action"}
              </button>
            </>
          ) : (
            <ProposalCard
              proposal={proposal}
              paypal={paypal}
              confirmed={confirmed}
              setConfirmed={setConfirmed}
              busy={busy !== null}
              canReview={canReviewAccess(access)}
              onApprove={approve}
              onReject={reject}
            />
          )}
        </section>
      )}

      {report && (
        <section className="mb-6 min-w-0 rounded-2xl border border-observed/40 bg-surface p-5 sm:p-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">PayPal execution: {report.proposal.status.replace("_", " ")}</h2>
            <span className="source-badge text-observed">Observed from PayPal Sandbox read-back</span>
          </div>
          <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1">Subscription</th>
                <th>HTTP</th>
                <th>Price now (read back)</th>
                <th>Status</th>
                <th>Verified</th>
                <th>PayPal debug ID</th>
              </tr>
            </thead>
            <tbody>
              {report.outcomes.map((o) => (
                <tr key={o.subscriptionId} className="border-t border-border">
                  <td className="max-w-48 break-all py-2 font-mono">{o.subscriptionId}</td>
                  <td>{o.httpStatus ?? "—"}</td>
                  <td>{o.observed?.regularPrice ? `$${o.observed.regularPrice}` : "—"}</td>
                  <td>{o.observed?.status ?? o.error}</td>
                  <td className={o.verified ? "text-positive" : "text-negative"}>{o.verified ? "yes" : "no"}</td>
                  <td className="max-w-48 break-all font-mono text-xs">{o.debugId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Pilot cohort in PayPal Sandbox</h2>
          <button onClick={refreshPayPal} className="min-h-10 rounded-lg px-3 text-sm text-brand-accent hover:bg-background hover:underline">
            Refresh from PayPal
          </button>
        </div>
        {!paypal?.subscriptions.length ? (
          <p className="text-sm text-muted">
            No sandbox subscriptions registered yet. Run <code className="font-mono">npm run paypal:setup</code> and approve the links as a sandbox buyer.
          </p>
        ) : (
          <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1">Subscriber</th>
                <th>Segment</th>
                <th>Subscription</th>
                <th>Status</th>
                <th>Price</th>
                <th>Next billing</th>
              </tr>
            </thead>
            <tbody>
              {paypal.subscriptions.map((s) => (
                <tr key={s.subscriptionId} className="border-t border-border">
                  <td className="py-2">{s.label}</td>
                  <td>
                    {s.segment.replaceAll("_", " ")}
                    {s.reason === "price" && <span className="ml-1 rounded border border-brand/40 px-1 text-xs text-brand">price</span>}
                  </td>
                  <td className="max-w-48 break-all font-mono">{s.subscriptionId}</td>
                  <td>{s.live?.status ?? s.error ?? "—"}</td>
                  <td>{s.live ? (s.live.regularPrice ? `$${s.live.regularPrice}${s.live.planOverridden ? " (override)" : ""}` : `$${summary.listPrice.toFixed(2)} (plan)`) : "—"}</td>
                  <td>{s.live?.nextBillingTime?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}

function ProposalCard({
  proposal,
  paypal,
  confirmed,
  setConfirmed,
  busy,
  canReview,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  paypal: PayPalStatus | null;
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
  busy: boolean;
  canReview: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const a = proposal.action;
  const labels = new Map(paypal?.subscriptions.map((s) => [s.subscriptionId, s.label]) ?? []);
  const d = proposal.prediction.vsBaseline.totalValue;
  return (
    <div>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="Price change" value={`$${a.listPrice} → $${a.newPrice} (${a.discountPct}% off) for ${a.months} month(s)`} />
        <Field label="Targeting" value={`${a.segment.replaceAll("_", " ")} · ${a.reason === "any" ? "any reason" : "price reason"}`} />
        <Field label="Simulated campaign" value={a.campaignMonths === 0 ? "Today's cohort only (0-month campaign)" : `${a.campaignMonths}-month offer enrollment window; each offer lasts ${a.months} month(s)`} />
        <Field label="Targets" value={a.targets.map((t) => `${labels.get(t) ?? ""} ${t}`).join(", ")} />
        <Field label="Simulated Δ value (median, 80% interval)" value={`${money(d.p50)} (${money(d.p10)} … ${money(d.p90)})`} />
        <Field label="Status" value={proposal.status} />
        <Field label="Payload hash" value={proposal.actionHash} mono />
      </dl>
      <details className="mb-4 rounded-lg border border-border bg-background px-4 py-3 text-sm"><summary className="font-medium text-brand-accent">PayPal operation details</summary><p className="mt-2 break-all font-mono text-xs">PATCH /v1/billing/subscriptions/&#123;id&#125; · regular-cycle fixed_price</p></details>
      <p className="mb-3 text-sm text-muted">
        Approval executes for today&apos;s matching pilots only. Later campaign entrants need their own proposals and approvals.
        Campaign duration describes the simulated policy; it does not schedule future PayPal actions.
      </p>
      {proposal.status === "proposed" && (
        <>
          <p className="mb-3 text-sm text-muted">
            Billing within 10 days of a PayPal price change is unaffected. The discount is recorded with a revert date; reverting is a separate approved
            action.
          </p>
          <label className="mb-3 flex min-h-10 items-center gap-3 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(e) => setConfirmed(e.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
            I approve changing the price of these {a.targets.length} PayPal Sandbox subscription(s).
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={onApprove}
              disabled={!confirmed || busy || !paypal?.configured || !canReview}
              className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50"
            >
              {busy ? "Working…" : "Approve & execute"}
            </button>
            <button onClick={onReject} disabled={busy || !canReview} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:bg-background disabled:opacity-50">
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>{value}</dd>
    </div>
  );
}

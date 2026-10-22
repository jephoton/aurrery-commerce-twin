"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecutionReport } from "@/execution/execute";
import type { Proposal } from "@/ledger/proposals";
import type { Strategy } from "@/twin/interventions";
import type { ComparisonResult } from "@/twin/simulate";
import type { Provenance, SegmentId } from "@/twin/types";
import { FanChart } from "./FanChart";
import { ScenarioGrid, toRows } from "./ScenarioGrid";

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
const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function Lab({ summary, starterStrategies }: { summary: MerchantSummary; starterStrategies: Strategy[] }) {
  const [objective, setObjective] = useState(DEFAULT_OBJECTIVE);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [paypal, setPayPal] = useState<PayPalStatus | null>(null);
  const [busy, setBusy] = useState<"simulate" | "propose" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const refreshPayPal = useCallback(() => {
    api<PayPalStatus>("/api/paypal/status").then(setPayPal).catch((e) => setError(e.message));
  }, []);
  useEffect(refreshPayPal, [refreshPayPal]);

  const simulate = async () => {
    setBusy("simulate");
    setError(null);
    setProposal(null);
    setReport(null);
    try {
      const result = await api<ComparisonResult>("/api/simulate", { method: "POST", body: JSON.stringify({ strategies: starterStrategies }) });
      setComparison(result);
      const best = [...result.strategies]
        .filter((s) => s.strategy.id !== result.baselineId)
        .sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50)[0];
      setSelectedId(best?.strategy.id ?? null);
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
    if (!selected) return;
    setBusy("propose");
    setError(null);
    setReport(null);
    setConfirmed(false);
    try {
      const { proposal } = await api<{ proposal: Proposal }>("/api/proposals", {
        method: "POST",
        body: JSON.stringify({ objective, strategy: selected.strategy }),
      });
      setProposal(proposal);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!proposal) return;
    setBusy("execute");
    setError(null);
    try {
      const result = await api<ExecutionReport>(`/api/proposals/${proposal.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ actionHash: proposal.actionHash, approvedBy: "merchant (demo)" }),
      });
      setReport(result);
      setProposal(result.proposal);
      refreshPayPal();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!proposal) return;
    const { proposal: p } = await api<{ proposal: Proposal }>(`/api/proposals/${proposal.id}/reject`, { method: "POST", body: "{}" });
    setProposal(p);
  };

  const atRisk = summary.segments.find((s) => s.id === "at_risk")!;
  const executable = selected?.strategy.intervention.kind === "targeted_discount";

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-brand-accent">Aurrery</p>
          <h1 className="text-3xl font-semibold tracking-tight">Simulate before you transact.</h1>
          <p className="mt-1 max-w-2xl text-muted">
            A digital twin of your subscription business tests strategies under uncertainty. Only an approved action reaches PayPal.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-sm ${paypal?.configured ? "border-positive/30 bg-positive/5 text-positive" : "border-border text-muted"}`}
        >
          PayPal Sandbox: {paypal ? (paypal.configured ? "connected" : "not configured") : "checking…"}
        </span>
      </header>

      {error && <div className="mb-4 rounded-lg border border-negative/30 bg-negative/5 px-4 py-3 text-sm text-negative">{error}</div>}

      <section className="mb-6 rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {summary.name} <span className="font-normal text-muted">· {summary.planName} · as of {summary.asOfMonth}</span>
          </h2>
          <span className="rounded bg-sim/10 px-2 py-0.5 text-xs font-medium text-sim">Synthetic demo history</span>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Kpi label="Active subscribers" value={summary.active.toLocaleString()} />
          <Kpi label="Monthly recurring revenue" value={money(summary.mrr)} />
          <Kpi label="Churn last month" value={pct(summary.lastMonthChurnRate)} />
          <Kpi label="At-risk subscribers" value={atRisk.active.toLocaleString()} hint={`${pct(atRisk.churn)} monthly churn`} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          {summary.segments.map((s) => (
            <div key={s.id} className="rounded-lg bg-background px-3 py-2">
              <div className="text-muted">{s.label}</div>
              <div>
                {s.active.toLocaleString()} subs · {pct(s.churn)} churn/mo
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-xl border border-border bg-surface p-5">
        <label htmlFor="objective" className="mb-2 block text-lg font-semibold">
          Business objective
        </label>
        <textarea
          id="objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-brand-accent"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={simulate}
            disabled={busy !== null}
            className="rounded-lg bg-brand px-4 py-2 font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            {busy === "simulate" ? "Simulating 1,000 futures…" : "Simulate strategies"}
          </button>
          <span className="text-sm text-muted">{starterStrategies.length} candidate strategies · 1,000 Monte Carlo runs each · 12-month horizon</span>
        </div>
      </section>

      {comparison && (
        <section className="mb-6 rounded-xl border border-border bg-surface p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Scenario comparison</h2>
            <span className="rounded bg-sim/10 px-2 py-0.5 text-xs font-medium text-sim">Simulated, not observed</span>
          </div>
          <ScenarioGrid rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
          <p className="mt-2 text-xs text-muted">
            Value = 12-month gross profit + discounted margin of the subscribers remaining at month 12 (next 24 months, 1%/mo). Differences are paired
            against the baseline under common random numbers.
          </p>
        </section>
      )}

      {selected && baseline && (
        <section className="mb-6 grid gap-6 lg:grid-cols-5">
          <div className="rounded-xl border border-border bg-surface p-5 lg:col-span-3">
            <h2 className="mb-1 text-lg font-semibold">{selected.strategy.name}</h2>
            <p className="mb-4 text-muted">{selected.description}</p>
            <FanChart
              title="Active subscribers"
              format={(v) => Math.round(v).toLocaleString()}
              series={[
                { label: "Do nothing", band: baseline.activeBand, color: "#5b6478" },
                { label: selected.strategy.name, band: selected.activeBand, color: "#6941c6" },
              ]}
            />
          </div>
          <div className="rounded-xl border border-border bg-surface p-5 lg:col-span-2">
            <h3 className="mb-2 font-semibold">What this rests on</h3>
            <ul className="space-y-2 text-sm">
              {Object.entries(summary.provenance).map(([k, p]) => (
                <li key={k} className="flex gap-2">
                  <span
                    className={`mt-0.5 h-fit shrink-0 rounded px-1.5 text-xs font-medium ${p.source === "assumption" ? "bg-amber-100 text-amber-800" : p.source === "observed" ? "bg-observed/10 text-observed" : "bg-brand-accent/10 text-brand-accent"}`}
                  >
                    {p.source}
                  </span>
                  <span className="text-muted">{p.note}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {selected && selected.strategy.id !== comparison?.baselineId && (
        <section className="mb-6 rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-1 text-lg font-semibold">Approval</h2>
          {!executable ? (
            <p className="text-muted">
              This strategy is simulate-only in this build. PayPal route: <span className="font-mono text-sm">{selected.paypalAction}</span>
            </p>
          ) : !proposal ? (
            <>
              <p className="mb-3 text-muted">Prepare the exact PayPal action for review. Nothing is sent to PayPal until you approve it.</p>
              <button
                onClick={propose}
                disabled={busy !== null}
                className="rounded-lg border border-brand px-4 py-2 font-medium text-brand hover:bg-brand/5 disabled:opacity-50"
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
              busy={busy === "execute"}
              onApprove={approve}
              onReject={reject}
            />
          )}
        </section>
      )}

      {report && (
        <section className="mb-6 rounded-xl border border-observed/30 bg-surface p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">PayPal execution: {report.proposal.status.replace("_", " ")}</h2>
            <span className="rounded bg-observed/10 px-2 py-0.5 text-xs font-medium text-observed">Observed from PayPal Sandbox</span>
          </div>
          <table className="w-full text-left text-sm">
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
                  <td className="py-2 font-mono">{o.subscriptionId}</td>
                  <td>{o.httpStatus ?? "—"}</td>
                  <td>{o.observed?.regularPrice ? `$${o.observed.regularPrice}` : "—"}</td>
                  <td>{o.observed?.status ?? o.error}</td>
                  <td className={o.verified ? "text-positive" : "text-negative"}>{o.verified ? "yes" : "no"}</td>
                  <td className="font-mono text-xs">{o.debugId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Pilot cohort in PayPal Sandbox</h2>
          <button onClick={refreshPayPal} className="text-sm text-brand-accent hover:underline">
            Refresh from PayPal
          </button>
        </div>
        {!paypal?.subscriptions.length ? (
          <p className="text-sm text-muted">
            No sandbox subscriptions registered yet. Run <code className="font-mono">npm run paypal:setup</code> and approve the links as a sandbox buyer.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
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
                    {s.reason === "price" && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">price</span>}
                  </td>
                  <td className="font-mono">{s.subscriptionId}</td>
                  <td>{s.live?.status ?? s.error ?? "—"}</td>
                  <td>{s.live ? (s.live.regularPrice ? `$${s.live.regularPrice}${s.live.planOverridden ? " (override)" : ""}` : `$${summary.listPrice.toFixed(2)} (plan)`) : "—"}</td>
                  <td>{s.live?.nextBillingTime?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function ProposalCard({
  proposal,
  paypal,
  confirmed,
  setConfirmed,
  busy,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  paypal: PayPalStatus | null;
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const a = proposal.action;
  const labels = new Map(paypal?.subscriptions.map((s) => [s.subscriptionId, s.label]) ?? []);
  const d = proposal.prediction.vsBaseline.totalValue;
  return (
    <div>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="PayPal operation" value="PATCH /v1/billing/subscriptions/{id} · regular-cycle fixed_price" mono />
        <Field label="Price change" value={`$${a.listPrice} → $${a.newPrice} (${a.discountPct}% off) for ${a.months} month(s)`} />
        <Field label="Targeting" value={`${a.segment.replaceAll("_", " ")} · ${a.reason === "any" ? "any reason" : "price reason"}`} />
        <Field label="Simulated campaign" value={a.campaignMonths === 0 ? "Today's cohort only (0-month campaign)" : `${a.campaignMonths}-month offer enrollment window; each offer lasts ${a.months} month(s)`} />
        <Field label="Targets" value={a.targets.map((t) => `${labels.get(t) ?? ""} ${t}`).join(", ")} />
        <Field label="Simulated Δ value (median, 80% interval)" value={`${money(d.p50)} (${money(d.p10)} … ${money(d.p90)})`} />
        <Field label="Status" value={proposal.status} />
        <Field label="Payload hash" value={proposal.actionHash.slice(0, 16) + "…"} mono />
      </dl>
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
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I approve changing the price of these {a.targets.length} PayPal Sandbox subscription(s).
          </label>
          <div className="flex gap-3">
            <button
              onClick={onApprove}
              disabled={!confirmed || busy || !paypal?.configured}
              className="rounded-lg bg-brand px-4 py-2 font-medium text-white hover:bg-brand/90 disabled:opacity-50"
            >
              {busy ? "Executing in PayPal Sandbox…" : "Approve & execute"}
            </button>
            <button onClick={onReject} disabled={busy} className="rounded-lg border border-border px-4 py-2 hover:bg-background">
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
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}

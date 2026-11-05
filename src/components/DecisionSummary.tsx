import type { AgentEvent, DecisionRules } from "@/agent/contracts";
import type { Proposal } from "@/ledger/proposals";
import type { StrategyResult } from "@/twin/simulate";
import { DEMO_ONLY_MESSAGE } from "@/import/messages";
import { isExecutableIntervention, whyNotExecutable } from "./headline";
import { CornerTicks } from "./art/CornerTicks";

interface Props {
  selected: StrategyResult | null;
  proposal: Proposal | null;
  proposalSource: "manual" | "agent" | null;
  rules: DecisionRules | null;
  stress: Extract<AgentEvent, { type: "stress" }> | null;
  horizonMonths: number | null;
  source: "manual" | "agent" | null;
  busy: boolean;
  /** The selection is the best recommendable strategy within the decision rules (executable for the demo merchant). */
  recommended?: boolean;
  /** No recommendable strategy met the rules; the selection is the highest simulated value, for context. */
  noQualifyingAction?: boolean;
  biggerLevers?: StrategyResult[];
  /** Other executable strategies that also meet the decision rules. */
  alsoExecutable?: StrategyResult[];
  /** An imported merchant (M6): the pick is recommendable but simulate only; nothing is executable. */
  simulateOnly?: boolean;
  onSelect?: (id: string) => void;
}

const signedMoney = (value: number) => `${value < 0 ? "−" : "+"}$${Math.round(Math.abs(value)).toLocaleString()}`;
const money = (value: number) => `$${Math.round(value).toLocaleString()}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const riskTone = (risk: number) => risk <= .1
  ? { label: "Low risk", text: "text-positive", bar: "bg-positive" }
  : risk <= .35 ? { label: "Some risk", text: "text-brand-accent", bar: "bg-brand" } : { label: "High risk", text: "text-negative", bar: "bg-negative" };

/** The 80% range on an axis that always includes zero, with the median marked. */
function RangeBar({ p10, p50, p90 }: { p10: number; p50: number; p90: number }) {
  const low = Math.min(p10, 0);
  const span = Math.max(Math.max(p90, 0) - low, 1);
  const at = (x: number) => `${((x - low) / span) * 100}%`;
  return (
    <div className="relative mt-3 h-2 rounded-full bg-raised" aria-hidden="true">
      <div className="absolute inset-y-0 rounded-full bg-brand" style={{ left: at(p10), width: `${((p90 - p10) / span) * 100}%` }} />
      <div className="absolute -inset-y-1 w-0.5 bg-muted" style={{ left: at(0) }} />
      <div className="absolute -inset-y-1 w-1 rounded-full bg-foreground" style={{ left: at(p50) }} />
    </div>
  );
}

function OptionRows({ title, note, options, scale, busy, onSelect, reason = false }: { title: string; note?: string; options: StrategyResult[]; scale: number; busy: boolean; onSelect?: (id: string) => void; reason?: boolean }) {
  return (
    <div>
      <p className="font-semibold">{title}{note && <span className="font-normal text-muted"> · {note}</span>}</p>
      <ul className="mt-2 space-y-2">
        {options.map((option) => {
          const median = option.vsBaseline.totalValue.p50;
          return (
            <li key={option.strategy.id} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]" title={reason ? whyNotExecutable(option.strategy.intervention) ?? undefined : undefined}>
              <button type="button" disabled={busy || !onSelect} onClick={() => onSelect?.(option.strategy.id)} className="min-w-0 text-left font-medium text-brand-accent underline-offset-2 hover:underline disabled:no-underline">{option.strategy.name}{!reason && option.strategy.intervention.kind === "targeted_discount" && <span className="block text-xs font-normal tabular-nums text-muted">{money(option.metrics.discountCost.mean)} discount cost</span>}</button>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true"><div className={`h-full rounded-full ${median < 0 ? "bg-negative" : reason ? "bg-sim" : "bg-brand"}`} style={{ width: `${Math.max(2, (Math.abs(median) / scale) * 100)}%` }} /></div>
              <span className="tabular-nums sm:text-right">{signedMoney(median)} median</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DecisionSummary({ selected, proposal, proposalSource, rules, stress, horizonMonths, source, busy, recommended = false, noQualifyingAction = false, biggerLevers = [], alsoExecutable = [], simulateOnly = false, onSelect }: Props) {
  const currentProposal = selected && proposal?.strategy?.id === selected.strategy.id ? proposal : null;
  const matchingStress = selected && stress?.strategyId === selected.strategy.id ? stress : null;
  const manualActionAfterAgentComparison = !!currentProposal && proposalSource === "manual" && source === "agent";
  if (!selected) return (
    <section aria-labelledby="decision-title" className="decision-panel engraved-key mb-6 engraved border border-border bg-surface p-6 sm:p-8">
      <CornerTicks />
      <p className="eyebrow">Decision workspace · no comparison yet</p>
      <h1 id="decision-title" className="mt-3 max-w-2xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.5rem]">Simulate before you transact.</h1>
      <p className="mt-3 max-w-2xl text-muted">Run the agent or simulate strategies to compare possible outcomes for your business objective. Recommendations appear only after analysis.</p>
      {busy && <p role="status" className="mt-2 text-sm text-muted">Investigation in progress…</p>}
    </section>
  );

  const value = selected.vsBaseline.totalValue;
  const executable = isExecutableIntervention(selected.strategy.intervention, { simulateOnly });
  const annual = selected.strategy.intervention.kind === "annual_plan";
  const risk = riskTone(selected.probValueBelowBaseline);
  const optionScale = Math.max(1, ...[...alsoExecutable, ...biggerLevers].map((option) => Math.abs(option.vsBaseline.totalValue.p50)));
  const status = currentProposal?.status;
  const label = manualActionAfterAgentComparison ? "Selected scenario" : currentProposal
    ? status === "proposed" ? proposalSource === "agent" ? "Agent proposal" : "Prepared action" : `Action ${status?.replaceAll("_", " ")}`
    : recommended ? (simulateOnly ? "Best within your rules" : "Recommended now") : source === "manual" ? "Manual scenario" : "Selected scenario";
  return (
    <section aria-labelledby="decision-title" className="decision-panel mb-6 min-w-0 engraved border border-border bg-surface p-6 sm:p-8">
      <CornerTicks />
      <p className="eyebrow">{label} · simulated, not observed{simulateOnly ? " · simulate only" : ""}</p>
      <h1 id="decision-title" className="mt-3 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.5rem]">{selected.strategy.name}</h1>
      <div className="mt-6 grid gap-4 border-t border-dotted border-border pt-5 text-sm sm:grid-cols-3">
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <p className="text-muted">Likely value change · {horizonMonths}-month</p>
          <p className={`mt-1 text-3xl font-semibold tabular-nums ${value.p50 < 0 ? "text-negative" : "text-brand-accent"}`}>{signedMoney(value.p50)}</p>
          <RangeBar p10={value.p10} p50={value.p50} p90={value.p90} />
          <p className="mt-1 flex justify-between gap-2 text-xs tabular-nums text-muted"><span>{signedMoney(value.p10)}</span><span>80% range</span><span>{signedMoney(value.p90)}</span></p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <p className="text-muted">Chance of doing worse</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{percent(selected.probValueBelowBaseline)}</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true"><div className={`h-full rounded-full ${risk.bar}`} style={{ width: `${Math.max(1, selected.probValueBelowBaseline * 100)}%` }} /></div>
          <p className={`mt-1 text-xs ${risk.text}`}>{risk.label} · versus doing nothing</p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background p-4">
          <p className="text-muted">Next step</p>
          {!simulateOnly && currentProposal?.status === "proposed"
            ? <a href="#approval" className="mt-2 flex min-h-10 items-center justify-center rounded-lg btn-gold px-4 py-2 text-center font-semibold">Review exact action <span aria-hidden="true" className="ml-2">↓</span></a>
            : executable && !status
              ? <a href="#approval" className="mt-2 flex min-h-10 items-center justify-center rounded-lg btn-gold px-4 py-2 text-center font-semibold">Prepare action <span aria-hidden="true" className="ml-2">↓</span></a>
              : <p className="mt-2 text-lg font-semibold">{status && status !== "proposed" ? `Action ${status.replaceAll("_", " ")}` : "Simulate only"}</p>}
          <p className="mt-2 text-xs text-muted">{annual && !simulateOnly ? "Each customer accepts in PayPal" : executable ? "Nothing changes until you approve" : "No PayPal action for this option"}</p>
        </div>
      </div>
      {!executable && <p className="mt-3 text-sm text-muted">Simulate only: {[simulateOnly ? DEMO_ONLY_MESSAGE : null, whyNotExecutable(selected.strategy.intervention)].filter(Boolean).join(" ") || "this strategy has no executable PayPal action in this build."}</p>}
      {noQualifyingAction && <p className="mt-3 text-sm text-muted">{simulateOnly ? "No strategy meets the decision rules, so nothing is recommended." : "No executable strategy meets the decision rules, so nothing is recommended."} This is the highest simulated value, shown for context.</p>}
      {matchingStress && (
        <p className="mt-3 text-sm">
          Adverse stress: <span className="tabular-nums">{signedMoney(matchingStress.stress.base.vsBaseline.totalValue.p50)} → {signedMoney(matchingStress.stress.stressed.vsBaseline.totalValue.p50)}</span>
          {matchingStress.stress.stressed.vsBaseline.totalValue.p50 < matchingStress.stress.base.vsBaseline.totalValue.p50 && " · worse than the base case"}
        </p>
      )}
      {recommended && (alsoExecutable.length > 0 || biggerLevers.length > 0) && (
        <div className="mt-5 grid gap-4 rounded-lg border border-border bg-background px-4 py-3 text-sm">
          {alsoExecutable.length > 0 && <OptionRows title="Also executable within your rules" options={alsoExecutable} scale={optionScale} busy={busy} onSelect={onSelect} />}
          {biggerLevers.length > 0 && <OptionRows title="Bigger simulated levers" note={simulateOnly ? "not recommended: price response is an assumption" : "simulate only, not executable here"} options={biggerLevers} scale={optionScale} busy={busy} onSelect={onSelect} reason />}
        </div>
      )}
      <details className="mt-4 text-sm">
        <summary className="min-h-10 cursor-pointer pt-2 font-medium text-brand-accent">How this is calculated</summary>
        <p className="mt-2 text-muted">{horizonMonths}-month value = gross profit over the horizon plus discounted margin of the subscribers remaining at month {horizonMonths}. Changes are paired against do nothing.</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><dt className="text-muted">Expected value change</dt><dd className="font-semibold tabular-nums">{signedMoney(value.mean)}</dd></div>
          <div><dt className="text-muted">Median value change</dt><dd className="font-semibold tabular-nums">{signedMoney(value.p50)}</dd></div>
          <div><dt className="text-muted">Mean discount cost</dt><dd className="font-semibold tabular-nums">{money(selected.metrics.discountCost.mean)}</dd></div>
        </dl>
        {manualActionAfterAgentComparison && <p className="mt-3 text-muted">These figures belong to the agent-classified comparison. A separate manual action using canonical estimates is shown in Approval below.</p>}
        {rules && source === "agent" && <p className="mt-3 text-muted">Decision rules: {money(rules.discountBudget)} discount budget · at most {percent(rules.maxProbWorse)} chance worse · {rules.horizonMonths}-month horizon.</p>}
        {annual && !simulateOnly && <p className="mt-3 text-muted">Can be sent as an offer: each customer must agree in PayPal, and the yearly price is charged from their next renewal date. The prepay discount is netted in value and does not count against the retention discount budget.</p>}
        {status && status !== "proposed" && <p className="mt-3 text-muted">This action is {status.replaceAll("_", " ")}; it is not a new recommendation.</p>}
      </details>
    </section>
  );
}

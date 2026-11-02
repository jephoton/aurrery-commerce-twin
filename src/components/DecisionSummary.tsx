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
  const status = currentProposal?.status;
  const label = manualActionAfterAgentComparison ? "Selected scenario" : currentProposal
    ? status === "proposed" ? proposalSource === "agent" ? "Agent proposal" : "Prepared action" : `Action ${status?.replaceAll("_", " ")}`
    : recommended ? (simulateOnly ? "Best within your rules" : "Recommended now") : source === "manual" ? "Manual scenario" : "Selected scenario";
  return (
    <section aria-labelledby="decision-title" className="decision-panel mb-6 min-w-0 engraved border border-border bg-surface p-6 sm:p-8">
      <CornerTicks />
      <p className="eyebrow">{label} · simulated, not observed{simulateOnly ? " · simulate only" : ""}</p>
      <h1 id="decision-title" className="mt-3 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.5rem]">{selected.strategy.name}</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">{horizonMonths}-month value = gross profit over the horizon plus discounted margin of the subscribers remaining at month {horizonMonths}. Changes are paired against do nothing.</p>
      <dl className="mt-6 grid grid-flow-row-dense grid-cols-2 gap-4 border-t border-dotted border-border pt-5 text-sm sm:grid-cols-3 xl:grid-cols-5">
        <div className="col-span-2 sm:col-span-1"><dt className="text-muted">Expected value change</dt><dd className="mt-1 text-3xl font-semibold tabular-nums text-brand-accent">{signedMoney(value.mean)}</dd><small className="text-muted">mean versus baseline</small></div>
        <div><dt className="text-muted">Median value change</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{signedMoney(value.p50)}</dd><small className="text-muted">p50 versus baseline</small></div>
        <div className="col-span-2 xl:col-span-1"><dt className="text-muted">80% value interval</dt><dd className="mt-1 whitespace-nowrap text-lg font-semibold tabular-nums">{signedMoney(value.p10)} … {signedMoney(value.p90)}</dd><small className="text-muted">p10–p90 versus baseline</small></div>
        <div><dt className="text-muted">Chance of worse value</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{percent(selected.probValueBelowBaseline)}</dd><small className="text-muted">versus baseline</small></div>
        <div><dt className="text-muted">Mean discount cost</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{money(selected.metrics.discountCost.mean)}</dd><small className="text-muted">simulated spend</small></div>
      </dl>
      {manualActionAfterAgentComparison && <p className="mt-3 text-sm text-muted">These figures belong to the agent-classified comparison. A separate manual action using canonical estimates is shown in Approval below.</p>}
      {rules && source === "agent" && <p className="mt-3 text-sm text-muted">Decision rules: {money(rules.discountBudget)} discount budget · at most {percent(rules.maxProbWorse)} chance worse · {rules.horizonMonths}-month horizon.</p>}
      {matchingStress && (
        <p className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          Adverse stress under shifted assumptions: median value change {signedMoney(matchingStress.stress.base.vsBaseline.totalValue.p50)} → {signedMoney(matchingStress.stress.stressed.vsBaseline.totalValue.p50)}.
          {matchingStress.stress.stressed.vsBaseline.totalValue.p50 < matchingStress.stress.base.vsBaseline.totalValue.p50 && " Worse than the base case."}
        </p>
      )}
      {noQualifyingAction && <p className="mt-3 text-sm text-muted">{simulateOnly ? "No strategy meets the decision rules, so nothing is recommended." : "No executable strategy meets the decision rules, so nothing is recommended."} This is the highest simulated value, shown for context.</p>}
      {!isExecutableIntervention(selected.strategy.intervention, { simulateOnly }) && <p className="mt-3 text-sm text-muted">Simulate only: {[simulateOnly ? DEMO_ONLY_MESSAGE : null, whyNotExecutable(selected.strategy.intervention)].filter(Boolean).join(" ") || "this strategy has no executable PayPal action in this build."}</p>}
      {!simulateOnly && selected.strategy.intervention.kind === "annual_plan" && <p className="mt-3 text-sm text-muted">Can be sent as an offer: each customer must agree in PayPal, and the yearly price is charged from their next renewal date. The prepay discount is netted in value and does not count against the retention discount budget.</p>}
      {recommended && alsoExecutable.length > 0 && (
        <div className="mt-5 rounded-lg border border-border bg-background px-4 py-3 text-sm">
          <p className="font-semibold">Also executable within your rules</p>
          <ul className="mt-2 space-y-2">
            {alsoExecutable.map((option) => (
              <li key={option.strategy.id}>
                <button type="button" disabled={busy || !onSelect} onClick={() => onSelect?.(option.strategy.id)} className="text-left font-medium text-brand-accent underline-offset-2 hover:underline disabled:no-underline">
                  {option.strategy.name}
                </button>{" "}
                <span className="tabular-nums">{signedMoney(option.vsBaseline.totalValue.p50)} median</span>
                {option.strategy.intervention.kind === "targeted_discount" && <span className="tabular-nums text-muted"> · {money(option.metrics.discountCost.mean)} discount cost</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {recommended && biggerLevers.length > 0 && (
        <div className="mt-5 rounded-lg border border-border bg-background px-4 py-3 text-sm">
          <p className="font-semibold">Bigger simulated levers <span className="font-normal text-muted">· {simulateOnly ? "not recommended: price response is an assumption" : "simulate only, not executable here"}</span></p>
          <ul className="mt-2 space-y-2">
            {biggerLevers.map((lever) => (
              <li key={lever.strategy.id}>
                <button type="button" disabled={busy || !onSelect} onClick={() => onSelect?.(lever.strategy.id)} className="text-left font-medium text-brand-accent underline-offset-2 hover:underline disabled:no-underline">
                  {lever.strategy.name}
                </button>{" "}
                <span className="tabular-nums">{signedMoney(lever.vsBaseline.totalValue.p50)} median</span>
                <span className="block text-muted">{whyNotExecutable(lever.strategy.intervention)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!simulateOnly && currentProposal?.status === "proposed" && <a href="#approval" className="mt-5 inline-flex min-h-10 items-center rounded-lg btn-gold px-5 py-2 font-semibold">Review exact action <span aria-hidden="true" className="ml-2">↗</span></a>}
      {status && status !== "proposed" && <p className="mt-3 text-sm text-muted">This action is {status.replaceAll("_", " ")}; it is not a new recommendation.</p>}
    </section>
  );
}

import type { AgentEvent, DecisionRules } from "@/agent/contracts";
import type { Proposal } from "@/ledger/proposals";
import type { StrategyResult } from "@/twin/simulate";
import { whyNotExecutable } from "./headline";

interface Props {
  selected: StrategyResult | null;
  proposal: Proposal | null;
  proposalSource: "manual" | "agent" | null;
  rules: DecisionRules | null;
  stress: Extract<AgentEvent, { type: "stress" }> | null;
  horizonMonths: number | null;
  source: "manual" | "agent" | null;
  busy: boolean;
  /** The selection is the best executable strategy within the decision rules. */
  recommended?: boolean;
  /** No executable strategy met the rules; the selection is the highest simulated value, for context. */
  noQualifyingAction?: boolean;
  biggerLevers?: StrategyResult[];
  onSelect?: (id: string) => void;
}

const signedMoney = (value: number) => `${value < 0 ? "−" : "+"}$${Math.round(Math.abs(value)).toLocaleString()}`;
const money = (value: number) => `$${Math.round(value).toLocaleString()}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function DecisionSummary({ selected, proposal, proposalSource, rules, stress, horizonMonths, source, busy, recommended = false, noQualifyingAction = false, biggerLevers = [], onSelect }: Props) {
  const currentProposal = selected && proposal?.strategy?.id === selected.strategy.id ? proposal : null;
  const matchingStress = selected && stress?.strategyId === selected.strategy.id ? stress : null;
  const manualActionAfterAgentComparison = !!currentProposal && proposalSource === "manual" && source === "agent";
  if (!selected) return (
    <section aria-labelledby="decision-title" className="decision-panel mb-6 rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <p className="eyebrow">Decision workspace · no comparison yet</p>
      <h1 id="decision-title" className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Simulate before you transact.</h1>
      <p className="mt-3 max-w-2xl text-muted">Run the agent or simulate strategies to compare possible outcomes for your business objective. Recommendations appear only after analysis.</p>
      {busy && <p role="status" className="mt-2 text-sm text-muted">Investigation in progress…</p>}
    </section>
  );

  const value = selected.vsBaseline.totalValue;
  const status = currentProposal?.status;
  const label = manualActionAfterAgentComparison ? "Selected scenario" : currentProposal
    ? status === "proposed" ? proposalSource === "agent" ? "Agent proposal" : "Prepared action" : `Action ${status?.replaceAll("_", " ")}`
    : recommended ? "Recommended now" : source === "manual" ? "Manual scenario" : "Selected scenario";
  return (
    <section aria-labelledby="decision-title" className="decision-panel mb-6 min-w-0 rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <p className="eyebrow">{label} · simulated, not observed</p>
      <h1 id="decision-title" className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{selected.strategy.name}</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">{horizonMonths}-month value = gross profit over the horizon plus discounted margin of the subscribers remaining at month {horizonMonths}. Changes are paired against do nothing.</p>
      <dl className="mt-6 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-1"><dt className="text-muted">Expected value change</dt><dd className="mt-1 text-3xl font-semibold tabular-nums text-brand-accent">{signedMoney(value.mean)}</dd><small className="text-muted">mean versus baseline</small></div>
        <div><dt className="text-muted">Median value change</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{signedMoney(value.p50)}</dd><small className="text-muted">p50 versus baseline</small></div>
        <div><dt className="text-muted">80% value interval</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{signedMoney(value.p10)} … {signedMoney(value.p90)}</dd><small className="text-muted">p10–p90 versus baseline</small></div>
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
      {noQualifyingAction && <p className="mt-3 text-sm text-muted">No executable strategy meets the decision rules, so nothing is recommended. This is the highest simulated value, shown for context.</p>}
      {selected.strategy.intervention.kind !== "targeted_discount" && <p className="mt-3 text-sm text-muted">Simulate only: {whyNotExecutable(selected.strategy.intervention) ?? "this strategy has no executable PayPal action in this build."}</p>}
      {recommended && biggerLevers.length > 0 && (
        <div className="mt-5 rounded-lg border border-border bg-background px-4 py-3 text-sm">
          <p className="font-semibold">Bigger simulated levers <span className="font-normal text-muted">· simulate only, not executable here</span></p>
          <ul className="mt-2 space-y-2">
            {biggerLevers.map((lever) => (
              <li key={lever.strategy.id}>
                <button type="button" disabled={busy || !onSelect} onClick={() => onSelect?.(lever.strategy.id)} className="font-medium text-brand-accent underline-offset-2 hover:underline disabled:no-underline">
                  {lever.strategy.name}
                </button>{" "}
                <span className="tabular-nums">{signedMoney(lever.vsBaseline.totalValue.p50)} median</span>
                <span className="block text-muted">{whyNotExecutable(lever.strategy.intervention)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {currentProposal?.status === "proposed" && <a href="#approval" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-brand px-5 py-2 font-semibold text-background hover:bg-brand-accent">Review exact action <span aria-hidden="true" className="ml-2">↗</span></a>}
      {status && status !== "proposed" && <p className="mt-3 text-sm text-muted">This action is {status.replaceAll("_", " ")}; it is not a new recommendation.</p>}
    </section>
  );
}

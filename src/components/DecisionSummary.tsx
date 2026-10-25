import type { AgentEvent, DecisionRules } from "@/agent/contracts";
import type { Proposal } from "@/ledger/proposals";
import type { StrategyResult } from "@/twin/simulate";

interface Props {
  selected: StrategyResult | null;
  proposal: Proposal | null;
  rules: DecisionRules | null;
  stress: Extract<AgentEvent, { type: "stress" }> | null;
  horizonMonths: number | null;
  source: "manual" | "agent" | null;
  busy: boolean;
}

const signedMoney = (value: number) => `${value < 0 ? "−" : "+"}$${Math.round(Math.abs(value)).toLocaleString()}`;
const money = (value: number) => `$${Math.round(value).toLocaleString()}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function DecisionSummary({ selected, proposal, rules, stress, horizonMonths, source, busy }: Props) {
  const currentProposal = selected && proposal?.strategy.id === selected.strategy.id ? proposal : null;
  const matchingStress = selected && stress?.strategyId === selected.strategy.id ? stress : null;
  if (!selected) return (
    <section aria-labelledby="decision-title" className="mb-6 rounded-xl border border-border bg-surface p-5">
      <h2 id="decision-title" className="text-lg font-semibold">Your decision workspace</h2>
      <p className="mt-2 text-muted">Run the agent or simulate strategies to compare possible outcomes for your business objective.</p>
      {busy && <p role="status" className="mt-2 text-sm text-muted">Investigation in progress…</p>}
    </section>
  );

  const value = selected.vsBaseline.totalValue;
  const status = currentProposal?.status;
  const label = currentProposal
    ? status === "proposed" ? source === "agent" ? "Agent proposal" : "Prepared action" : `Action ${status?.replaceAll("_", " ")}`
    : source === "manual" ? "Manual scenario" : "Selected scenario";
  return (
    <section aria-labelledby="decision-title" className="mb-6 rounded-xl border border-border bg-surface p-5">
      <p className="text-sm font-medium text-brand-accent">{label} · simulated, not observed</p>
      <h2 id="decision-title" className="mt-1 text-xl font-semibold">{selected.strategy.name}</h2>
      <p className="mt-1 text-sm text-muted">{horizonMonths}-month value = gross profit over the horizon plus discounted margin of the subscribers remaining at month {horizonMonths}. Changes are paired against do nothing.</p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <div><dt className="text-muted">Expected value change</dt><dd className="text-xl font-semibold">{signedMoney(value.mean)}</dd><small className="text-muted">mean versus baseline</small></div>
        <div><dt className="text-muted">Median value change</dt><dd className="text-xl font-semibold">{signedMoney(value.p50)}</dd><small className="text-muted">p50 versus baseline</small></div>
        <div><dt className="text-muted">80% value interval</dt><dd className="text-lg font-semibold">{signedMoney(value.p10)} … {signedMoney(value.p90)}</dd><small className="text-muted">p10–p90 versus baseline</small></div>
        <div><dt className="text-muted">Chance of worse value</dt><dd className="text-xl font-semibold">{percent(selected.probValueBelowBaseline)}</dd><small className="text-muted">versus baseline</small></div>
        <div><dt className="text-muted">Mean discount cost</dt><dd className="text-xl font-semibold">{money(selected.metrics.discountCost.mean)}</dd><small className="text-muted">simulated spend</small></div>
      </dl>
      {rules && source === "agent" && <p className="mt-3 text-sm text-muted">Decision rules: {money(rules.discountBudget)} discount budget · at most {percent(rules.maxProbWorse)} chance worse · {rules.horizonMonths}-month horizon.</p>}
      {matchingStress && (
        <p className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          Adverse stress under shifted assumptions: median value change {signedMoney(matchingStress.stress.base.vsBaseline.totalValue.p50)} → {signedMoney(matchingStress.stress.stressed.vsBaseline.totalValue.p50)}.
          {matchingStress.stress.stressed.vsBaseline.totalValue.p50 < matchingStress.stress.base.vsBaseline.totalValue.p50 && " Worse than the base case."}
        </p>
      )}
      {selected.strategy.intervention.kind !== "targeted_discount" && <p className="mt-3 text-sm text-muted">Simulate only: this strategy has no executable PayPal action in this build.</p>}
      {currentProposal?.status === "proposed" && <a href="#approval" className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-brand px-4 py-2 font-medium text-white focus:outline-2 focus:outline-offset-2 focus:outline-brand-accent">Review exact action</a>}
      {status && status !== "proposed" && <p className="mt-3 text-sm text-muted">This action is {status.replaceAll("_", " ")}; it is not a new recommendation.</p>}
    </section>
  );
}

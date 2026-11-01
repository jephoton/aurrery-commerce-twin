import { DEFAULT_DECISION_RULES, type DecisionRules } from "@/agent/contracts";
import type { Intervention } from "@/twin/interventions";
import type { ComparisonResult, StrategyResult } from "@/twin/simulate";

// The headline must be something the app can stand behind and act on: the best strategy this
// build can execute through PayPal within the decision rules. Higher-value strategies it can only
// simulate are disclosed beside it with the reason they are not the recommendation.

/** Keep in step with the executable proposal kinds in `proposeStrategy` (src/execution/annual-proposal.ts). */
export const isExecutableIntervention = (intervention: Intervention) => intervention.kind === "targeted_discount" || intervention.kind === "annual_plan";
export const isExecutable = (r: StrategyResult) => isExecutableIntervention(r.strategy.intervention);

/** The discount budget governs retention discounts only; an annual prepay discount is netted in total value. */
const withinRules = (r: StrategyResult, rules: DecisionRules) =>
  r.probValueBelowBaseline <= rules.maxProbWorse &&
  (r.strategy.intervention.kind !== "targeted_discount" || r.metrics.discountCost.mean <= rules.discountBudget);

export interface Headline {
  selectedId: string | null;
  /** False when no executable strategy meets the rules; the selection is then context only. */
  recommended: boolean;
  /** Simulate-only strategies with a higher median value than the recommendation. */
  biggerLevers: StrategyResult[];
  /** Other executable strategies that also meet the rules, best first. */
  alsoExecutable: StrategyResult[];
}

export function chooseHeadline(comparison: ComparisonResult, rules: DecisionRules = DEFAULT_DECISION_RULES): Headline {
  const ranked = comparison.strategies
    .filter((s) => s.strategy.id !== comparison.baselineId)
    .sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);
  const qualifies = (s: StrategyResult) => isExecutable(s) && withinRules(s, rules);
  const pick = ranked.find(qualifies);
  if (!pick) return { selectedId: ranked[0]?.strategy.id ?? null, recommended: false, biggerLevers: [], alsoExecutable: [] };
  return {
    selectedId: pick.strategy.id,
    recommended: true,
    biggerLevers: ranked.filter((s) => !isExecutable(s) && s.vsBaseline.totalValue.p50 > pick.vsBaseline.totalValue.p50),
    alsoExecutable: ranked.filter((s) => s !== pick && qualifies(s)),
  };
}

export function whyNotExecutable(intervention: Intervention): string | null {
  switch (intervention.kind) {
    case "list_price_change":
      return "It changes the price for every subscriber at once, and how customers react to price is an assumption with no observed evidence. Test it on a small group before rolling it out.";
    case "annual_plan":
    case "baseline":
    case "targeted_discount":
      return null;
  }
}

import { DEFAULT_DECISION_RULES, type DecisionRules } from "@/agent/contracts";
import type { Intervention } from "@/twin/interventions";
import type { ComparisonResult, StrategyResult } from "@/twin/simulate";

// The headline must be something the app can stand behind and act on: the best strategy this
// build can execute through PayPal within the decision rules. Higher-value strategies it can only
// simulate are disclosed beside it with the reason they are not the recommendation.
// An imported merchant (M6) uses the same pick rule, but nothing is executable for it.

/**
 * Kinds the headline may recommend: the kinds with a PayPal action for the demo merchant. List-price changes stay out
 * for every merchant, because price response is an unobserved assumption. Keep in step with the executable proposal
 * kinds in `proposeStrategy` (src/execution/annual-proposal.ts) and the agent's `recommend` tool.
 */
export const isRecommendableIntervention = (intervention: Intervention) => intervention.kind === "targeted_discount" || intervention.kind === "annual_plan";

export interface HeadlineOptions {
  /** An imported merchant: no PayPal action exists, so nothing is executable and the pick is simulate only. */
  simulateOnly?: boolean;
}
/** Executable through PayPal in this build: a recommendable kind, for the demo merchant only. */
export const isExecutableIntervention = (intervention: Intervention, options: HeadlineOptions = {}) => !options.simulateOnly && isRecommendableIntervention(intervention);
export const isExecutable = (r: StrategyResult, options: HeadlineOptions = {}) => isExecutableIntervention(r.strategy.intervention, options);

/** The discount budget governs retention discounts only; an annual prepay discount is netted in total value. */
const withinRules = (r: StrategyResult, rules: DecisionRules) =>
  r.probValueBelowBaseline <= rules.maxProbWorse &&
  (r.strategy.intervention.kind !== "targeted_discount" || r.metrics.discountCost.mean <= rules.discountBudget);

export interface Headline {
  selectedId: string | null;
  /** False when no recommendable strategy meets the rules; the selection is then context only. */
  recommended: boolean;
  /** True for an imported merchant: the pick is a simulate-only recommendation. */
  simulateOnly: boolean;
  /** Strategies the headline may not recommend (list-price changes) with a higher median value than the pick. */
  biggerLevers: StrategyResult[];
  /** Other executable strategies that also meet the rules, best first. Always empty when simulate only. */
  alsoExecutable: StrategyResult[];
}

export function chooseHeadline(comparison: ComparisonResult, rules: DecisionRules = DEFAULT_DECISION_RULES, options: HeadlineOptions = {}): Headline {
  const simulateOnly = options.simulateOnly === true;
  const ranked = comparison.strategies
    .filter((s) => s.strategy.id !== comparison.baselineId)
    .sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50);
  const recommendable = (s: StrategyResult) => isRecommendableIntervention(s.strategy.intervention);
  const qualifies = (s: StrategyResult) => recommendable(s) && withinRules(s, rules);
  const pick = ranked.find(qualifies);
  if (!pick) return { selectedId: ranked[0]?.strategy.id ?? null, recommended: false, simulateOnly, biggerLevers: [], alsoExecutable: [] };
  return {
    selectedId: pick.strategy.id,
    recommended: true,
    simulateOnly,
    biggerLevers: ranked.filter((s) => !recommendable(s) && s.vsBaseline.totalValue.p50 > pick.vsBaseline.totalValue.p50),
    alsoExecutable: simulateOnly ? [] : ranked.filter((s) => s !== pick && qualifies(s)),
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

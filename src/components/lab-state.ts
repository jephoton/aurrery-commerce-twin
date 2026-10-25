import type { AgentEvent, DecisionRules } from "@/agent/contracts";
import type { ExecutionReport } from "@/execution/execute";
import type { Proposal } from "@/ledger/proposals";
import type { ComparisonResult } from "@/twin/simulate";

export interface DashboardState {
  comparison: ComparisonResult | null;
  selectedId: string | null;
  proposal: Proposal | null;
  report: ExecutionReport | null;
  confirmed: boolean;
  evidence: Extract<AgentEvent, { type: "classification" }> | null;
  comparisonSource: "manual" | "agent" | null;
  rules: DecisionRules | null;
  stress: Extract<AgentEvent, { type: "stress" }> | null;
}
export const emptyDashboard: DashboardState = { comparison: null, selectedId: null, proposal: null, report: null, confirmed: false, evidence: null, comparisonSource: null, rules: null, stress: null };
type Action =
  | { type: "reset" }
  | { type: "clear-review" }
  | { type: "objective-edited" }
  | { type: "select"; id: string }
  | { type: "confirmed"; value: boolean }
  | { type: "proposal"; proposal: Proposal }
  | { type: "report"; report: ExecutionReport }
  | { type: "comparison"; comparison: ComparisonResult; source: "manual" | "agent" }
  | { type: "event"; event: AgentEvent };
const clearReview = { proposal: null, report: null, confirmed: false };
export function dashboardReducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "reset": return emptyDashboard;
    case "clear-review":
    case "objective-edited": return { ...state, ...clearReview };
    case "select": return action.id === state.selectedId ? state : { ...state, ...clearReview, selectedId: action.id };
    case "confirmed": return { ...state, confirmed: action.value };
    case "proposal": return { ...state, ...clearReview, proposal: action.proposal };
    case "report": return { ...state, confirmed: false, report: action.report, proposal: action.report.proposal };
    case "comparison": {
      const best = [...action.comparison.strategies].filter(s => s.strategy.id !== action.comparison.baselineId).sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50)[0];
      return { ...state, ...clearReview, comparison: action.comparison, comparisonSource: action.source, selectedId: best?.strategy.id ?? null, rules: action.source === "agent" ? state.rules : null, stress: null };
    }
    case "event": {
      const event = action.event;
      if (event.type === "classification") return { ...state, ...clearReview, evidence: event, comparison: null, selectedId: null, comparisonSource: null, rules: null, stress: null };
      if (event.type === "rules") return { ...state, ...clearReview, comparison: null, selectedId: null, comparisonSource: null, rules: event.rules, stress: null };
      if (event.type === "comparison") return dashboardReducer(state, { type: "comparison", comparison: event.comparison, source: "agent" });
      if (event.type === "stress" && state.comparisonSource === "agent" && event.stress.base.strategy.id === event.strategyId && event.stress.stressed.strategy.id === event.strategyId && state.comparison?.strategies.some(s => s.strategy.id === event.strategyId && s.strategy.id !== state.comparison?.baselineId)) return { ...state, stress: event };
      if (event.type === "proposal" && state.comparison?.strategies.some(s => s.strategy.id === event.proposal.strategy.id)) return { ...state, ...clearReview, selectedId: event.proposal.strategy.id, proposal: event.proposal };
      return state;
    }
  }
}

import type { AgentEvent, DecisionRules } from "@/agent/contracts";
import type { ExecutionReport } from "@/execution/execute";
import type { Proposal } from "@/ledger/proposals";
import type { ComparisonResult } from "@/twin/simulate";
import type { ObservedSnapshot } from "@/merchant/observed-snapshot";

export interface DashboardState {
  comparison: ComparisonResult | null;
  selectedId: string | null;
  proposal: Proposal | null;
  proposalSource: "manual" | "agent" | null;
  report: ExecutionReport | null;
  confirmed: boolean;
  evidence: Extract<AgentEvent, { type: "classification" }> | null;
  comparisonSource: "manual" | "agent" | null;
  rules: DecisionRules | null;
  stress: Extract<AgentEvent, { type: "stress" }> | null;
  observedSnapshot: ObservedSnapshot | null;
}
export const emptyDashboard: DashboardState = { comparison: null, selectedId: null, proposal: null, proposalSource: null, report: null, confirmed: false, evidence: null, comparisonSource: null, rules: null, stress: null, observedSnapshot: null };
type Action =
  | { type: "reset" }
  | { type: "clear-review" }
  | { type: "objective-edited" }
  | { type: "select"; id: string }
  | { type: "confirmed"; value: boolean }
  | { type: "proposal"; proposal: Proposal }
  | { type: "proposal-updated"; proposal: Proposal }
  | { type: "report"; report: ExecutionReport }
  | { type: "comparison"; comparison: ComparisonResult; source: "manual" | "agent"; observedSnapshot?: ObservedSnapshot }
  | { type: "event"; event: AgentEvent };
const clearReview = { proposal: null, proposalSource: null, report: null, confirmed: false };
export function dashboardReducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "reset": return emptyDashboard;
    case "clear-review":
    case "objective-edited": return { ...state, ...clearReview };
    case "select": return action.id === state.selectedId ? state : { ...state, ...clearReview, selectedId: action.id };
    case "confirmed": return { ...state, confirmed: action.value };
    case "proposal": return { ...state, ...clearReview, proposal: action.proposal, proposalSource: "manual" };
    case "proposal-updated": return state.proposal?.id === action.proposal.id ? { ...state, ...clearReview, proposal: action.proposal, proposalSource: state.proposalSource } : state;
    case "report": return { ...state, confirmed: false, report: action.report, proposal: action.report.proposal, proposalSource: state.proposal?.id === action.report.proposal.id ? state.proposalSource : null };
    case "comparison": {
      const best = [...action.comparison.strategies].filter(s => s.strategy.id !== action.comparison.baselineId).sort((a, b) => b.vsBaseline.totalValue.p50 - a.vsBaseline.totalValue.p50)[0];
      return { ...state, ...clearReview, comparison: action.comparison, comparisonSource: action.source, selectedId: best?.strategy.id ?? null, rules: action.source === "agent" ? state.rules : null, stress: null, observedSnapshot: action.source === "manual" ? action.observedSnapshot ?? null : state.observedSnapshot, evidence: action.source === "manual" ? null : state.evidence };
    }
    case "event": {
      const event = action.event;
      if (event.type === "observed_snapshot") return { ...emptyDashboard, observedSnapshot: event.snapshot };
      if (event.type === "classification") return { ...state, ...clearReview, evidence: event, comparison: null, selectedId: null, comparisonSource: null, stress: null, observedSnapshot: state.observedSnapshot ? { ...state.observedSnapshot, provenance: event.provenance } : null };
      if (event.type === "rules") return { ...state, ...clearReview, comparison: null, selectedId: null, comparisonSource: null, rules: event.rules, stress: null };
      if (event.type === "comparison") return dashboardReducer(state, { type: "comparison", comparison: event.comparison, source: "agent" });
      if (event.type === "stress" && state.comparisonSource === "agent" && event.stress.base.strategy.id === event.strategyId && event.stress.stressed.strategy.id === event.strategyId && state.comparison?.strategies.some(s => s.strategy.id === event.strategyId && s.strategy.id !== state.comparison?.baselineId)) return { ...state, stress: event };
      if (event.type === "proposal" && event.proposal.strategy && state.comparison?.strategies.some(s => s.strategy.id === event.proposal.strategy?.id)) return { ...state, ...clearReview, selectedId: event.proposal.strategy.id, proposal: event.proposal, proposalSource: "agent" };
      return state;
    }
  }
}

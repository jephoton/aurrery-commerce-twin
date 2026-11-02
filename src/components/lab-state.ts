import { DEFAULT_DECISION_RULES, type AgentEvent, type DecisionRules } from "@/agent/contracts";
import { chooseHeadline } from "./headline";
import type { ExecutionReport } from "@/execution/execute";
import type { Proposal } from "@/ledger/proposals";
import type { ComparisonResult } from "@/twin/simulate";
import type { ImportPayload } from "@/import/import-payload";
import type { Strategy } from "@/twin/interventions";
import { AnnualEvidenceSchema, type AnnualEvidence, type ObservedSnapshot } from "@/merchant/observed-snapshot";

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
      const { selectedId } = chooseHeadline(action.comparison, (action.source === "agent" ? state.rules : null) ?? DEFAULT_DECISION_RULES);
      return { ...state, ...clearReview, comparison: action.comparison, comparisonSource: action.source, selectedId, rules: action.source === "agent" ? state.rules : null, stress: null, observedSnapshot: action.source === "manual" ? action.observedSnapshot ?? null : state.observedSnapshot, evidence: action.source === "manual" ? null : state.evidence };
    }
    case "event": {
      const event = action.event;
      if (event.type === "observed_snapshot") return { ...emptyDashboard, observedSnapshot: event.snapshot };
      if (event.type === "classification") return { ...state, ...clearReview, evidence: event, comparison: null, selectedId: null, comparisonSource: null, stress: null, observedSnapshot: state.observedSnapshot ? { ...state.observedSnapshot, provenance: event.provenance } : null };
      if (event.type === "rules") return { ...state, ...clearReview, comparison: null, selectedId: null, comparisonSource: null, rules: event.rules, stress: null };
      if (event.type === "comparison") return dashboardReducer(state, { type: "comparison", comparison: event.comparison, source: "agent" });
      if (event.type === "stress" && state.comparisonSource === "agent" && event.stress.base.strategy.id === event.strategyId && event.stress.stressed.strategy.id === event.strategyId && state.comparison?.strategies.some(s => s.strategy.id === event.strategyId && s.strategy.id !== state.comparison?.baselineId)) return { ...state, stress: event };
      if (event.type === "proposal" && event.proposal.strategy && state.comparison?.strategies.some(s => s.strategy.id === event.proposal.strategy?.id)) return { ...state, ...clearReview, selectedId: event.proposal.strategy.id, proposal: event.proposal, proposalSource: "agent" };
      // Imported merchants (M6): a simulate-only recommendation selects the strategy from the agent's own comparison and never creates a proposal.
      if (event.type === "recommendation" && state.comparisonSource === "agent" && state.comparison?.strategies.some(s => s.strategy.id === event.strategy.id && s.strategy.id !== state.comparison?.baselineId)) return { ...state, ...clearReview, selectedId: event.strategy.id };
      return state;
    }
  }
}

/** Current annual-offer evidence from the guarded PayPal status read. `annual` is the evidence itself. It never touches discount evidence or a displayed run. */
export interface LiveAnnual { annual: AnnualEvidence }
/** Reads only `annualEvidence` from a `GET /api/paypal/status` body. A missing or unusable field returns null, so the previous evidence stays. */
export function liveAnnualFromStatus(body: unknown): LiveAnnual | null {
  if (typeof body !== "object" || body === null) return null;
  const parsed = AnnualEvidenceSchema.safeParse((body as { annualEvidence?: unknown }).annualEvidence);
  return parsed.success ? { annual: parsed.data } : null;
}

/**
 * The React key of the workspace (M6): one per merchant and import session, so switching merchants remounts it and drops
 * the comparison, selection, proposal, evidence and any running agent session of the previous twin.
 */
export const workspaceKey = (imported: { id: number } | null) => (imported ? `import-${imported.id}` : "demo");

/** A manual simulation's body. An imported twin is rebuilt server-side from the payload; Ridgeline's body is unchanged. */
export const simulateRequestBody = (strategies: Strategy[], importPayload: ImportPayload | null) =>
  importPayload ? { strategies, import: importPayload } : { strategies };

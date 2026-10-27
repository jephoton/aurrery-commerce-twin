import { expect, it } from "vitest";
import { dashboardReducer, emptyDashboard } from "./lab-state";
import { compareStrategies } from "@/twin/simulate";
import { buildDemoTwin } from "@/merchant/demo";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import type { Proposal } from "@/ledger/proposals";
import type { ExecutionReport } from "@/execution/execute";
import type { AgentEvent } from "@/agent/contracts";
import type { ObservedSnapshot } from "@/merchant/observed-snapshot";

const comparison = compareStrategies(buildDemoTwin().twin, STARTER_STRATEGIES, { runs: 2, horizonMonths: 2 });
const proposal = { id: "p1", strategy: STARTER_STRATEGIES[0] } as Proposal;
it("resets all review, comparison, confirmation and evidence state on a new run or manual simulation", () => {
  const state = { ...emptyDashboard, comparison, proposal, confirmed: true, selectedId: proposal.strategy.id };
  expect(dashboardReducer(state, { type: "reset" })).toEqual(emptyDashboard);
});
it("clears stale proposal, execution and confirmation when another strategy is selected", () => {
  const state = { ...emptyDashboard, comparison, proposal, confirmed: true, selectedId: proposal.strategy.id };
  expect(dashboardReducer(state, { type: "select", id: "different" })).toMatchObject({ proposal: null, report: null, confirmed: false, selectedId: "different" });
});
it("selects the exact proposed strategy and keeps merchant confirmation unchecked", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, confirmed: true }, { type: "event", event: { type: "proposal", proposal, rationale: "Evidence", tradeoffs: "Risk" } });
  expect(state).toMatchObject({ selectedId: proposal.strategy.id, proposal, proposalSource: "agent", confirmed: false });
});
it("tracks a manual action separately from an agent comparison and clears its origin with review state", () => {
  const compared = dashboardReducer({ ...emptyDashboard, comparison, comparisonSource: "agent" }, { type: "proposal", proposal });
  expect(compared).toMatchObject({ comparisonSource: "agent", proposalSource: "manual", proposal });
  expect(dashboardReducer(compared, { type: "clear-review" }).proposalSource).toBeNull();
  expect(dashboardReducer(compared, { type: "select", id: "another" }).proposalSource).toBeNull();
  expect(dashboardReducer(compared, { type: "reset" }).proposalSource).toBeNull();
});
it("keeps matching action origin through a report and drops it for an unrelated report", () => {
  const compared = dashboardReducer({ ...emptyDashboard, comparison }, { type: "proposal", proposal });
  const matching = dashboardReducer(compared, { type: "report", report: { proposal, outcomes: [] } });
  expect(matching.proposalSource).toBe("manual");
  const unrelated = dashboardReducer(compared, { type: "report", report: { proposal: { ...proposal, id: "other" }, outcomes: [] } });
  expect(unrelated.proposalSource).toBeNull();
});
it("preserves an agent proposal's origin when its rejected status is returned", () => {
  const agent = dashboardReducer({ ...emptyDashboard, comparison }, { type: "event", event: { type: "proposal", proposal, rationale: "Evidence", tradeoffs: "Risk" } });
  const rejected = dashboardReducer({ ...agent, confirmed: true }, { type: "proposal-updated", proposal: { ...proposal, status: "rejected" } });
  expect(rejected).toMatchObject({ proposalSource: "agent", proposal: { status: "rejected" }, confirmed: false });
  const unrelated = dashboardReducer(agent, { type: "proposal-updated", proposal: { ...proposal, id: "other", status: "rejected" } });
  expect(unrelated).toBe(agent);
});
it("invalidates an old comparison after a rules revision", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, proposal, confirmed: true }, { type: "event", event: { type: "rules", rules: { horizonMonths: 3, discountBudget: 1000, maxProbWorse: .5 } } });
  expect(state).toMatchObject({ comparison: null, proposal: null, confirmed: false });
});
it("clears review state when manually preparing a new action", () => {
  expect(dashboardReducer({ ...emptyDashboard, proposal, confirmed: true }, { type: "clear-review" })).toMatchObject({ proposal: null, confirmed: false, report: null });
});
it("keeps verbal recommendations separate from actual proposal events", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison }, { type: "event", event: { type: "summary", message: "I recommend a save offer." } });
  expect(state.proposal).toBeNull();
});
it("clears a confirmed proposal and execution report when the objective is edited", () => {
  const report: ExecutionReport = { proposal, outcomes: [] };
  const state = { ...emptyDashboard, comparison, comparisonSource: "agent" as const, proposal, report, confirmed: true, selectedId: proposal.strategy.id };
  const updated = dashboardReducer(state, { type: "objective-edited" });
  expect(updated).toEqual({ ...state, proposal: null, report: null, confirmed: false });
  expect(state.proposal).toBe(proposal);
  expect(state.report).toBe(report);
});

const rulesEvent: Extract<AgentEvent, { type: "rules" }> = { type: "rules", rules: { horizonMonths: 3, discountBudget: 1000, maxProbWorse: .5 } };
const stressEvent: Extract<AgentEvent, { type: "stress" }> = { type: "stress", strategyId: proposal.strategy.id, stress: { base: comparison.strategies[1], stressed: comparison.strategies[1], stressedParams: buildDemoTwin().twin.params, shifted: [] } };
const classificationEvent = { type: "classification", summary: { provider: "gemini", model: "test" }, hitmap: {}, provenance: {} } as Extract<AgentEvent, { type: "classification" }>;
it("keeps one run's counts and changes while classification updates its provenance and revisions", () => {
  const snapshot: ObservedSnapshot = { evidence: { episodes: 1, subscriberMonths: .5, posteriorSubscriberMonths: .5, cancellations: 0, censoredEpisodes: 0, posteriorCancellations: 0, limitation: "Fixture" }, changes: [], provenance: { rr: { source: "observed", note: "Measured" } } };
  const initial = dashboardReducer(emptyDashboard, { type: "event", event: { type: "observed_snapshot", snapshot } });
  const classified = dashboardReducer(initial, { type: "event", event: { ...classificationEvent, provenance: { ...snapshot.provenance, reason: { source: "estimated", note: "Classified" } } } });
  const revised = dashboardReducer(classified, { type: "event", event: rulesEvent });
  expect(revised.observedSnapshot).toEqual({ ...snapshot, provenance: { ...snapshot.provenance, reason: { source: "estimated", note: "Classified" } } });
  const manual = dashboardReducer(revised, { type: "comparison", comparison, source: "manual", observedSnapshot: snapshot });
  expect(manual.observedSnapshot).toEqual(snapshot);
  expect(manual.evidence).toBeNull();
});

it("retains current rules and matching stress until the comparison is replaced", () => {
  const ruled = dashboardReducer(emptyDashboard, { type: "event", event: rulesEvent });
  const compared = dashboardReducer(ruled, { type: "comparison", comparison, source: "agent" });
  const stressed = dashboardReducer(compared, { type: "event", event: stressEvent });
  expect(stressed.rules).toEqual(rulesEvent.rules);
  expect(stressed.stress).toBe(stressEvent);
  expect(dashboardReducer(stressed, { type: "comparison", comparison, source: "agent" }).stress).toBeNull();
});

it("ignores stress for a strategy absent from the current comparison", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, comparisonSource: "agent" }, { type: "event", event: { ...stressEvent, strategyId: "unknown" } });
  expect(state.stress).toBeNull();
});

it("does not attach another strategy's stress result to a matching event ID", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, comparisonSource: "agent" }, { type: "event", event: { ...stressEvent, stress: { ...stressEvent.stress, base: comparison.strategies[2] } } });
  expect(state.stress).toBeNull();
});

it("does not carry agent rules into a replacement manual comparison", () => {
  const state = dashboardReducer({ ...emptyDashboard, comparison, comparisonSource: "agent", rules: rulesEvent.rules, stress: stressEvent }, { type: "comparison", comparison, source: "manual" });
  expect(state).toMatchObject({ rules: null, stress: null, comparisonSource: "manual" });
});

it("invalidates stress on classification and revised rules, and clears both on a new run", () => {
  const state = { ...emptyDashboard, comparison, rules: rulesEvent.rules, stress: stressEvent };
  const revised = dashboardReducer(state, { type: "event", event: rulesEvent });
  expect(revised.stress).toBeNull();
  expect(revised.rules).toEqual(rulesEvent.rules);
  const classified = dashboardReducer(state, { type: "event", event: classificationEvent });
  expect(classified).toMatchObject({ rules: rulesEvent.rules, stress: null, comparison: null });
  expect(dashboardReducer(state, { type: "reset" })).toEqual(emptyDashboard);
});

it("keeps explicit decision rules through refreshed classification and the next agent comparison", () => {
  const ruled = dashboardReducer(emptyDashboard, { type: "event", event: rulesEvent });
  const classified = dashboardReducer(ruled, { type: "event", event: classificationEvent });
  const compared = dashboardReducer(classified, { type: "event", event: { type: "comparison", comparison } });
  expect(classified).toMatchObject({ rules: rulesEvent.rules, evidence: classificationEvent, comparison: null, stress: null });
  expect(compared).toMatchObject({ rules: rulesEvent.rules, comparison, comparisonSource: "agent", stress: null });
});

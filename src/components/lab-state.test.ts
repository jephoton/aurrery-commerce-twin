import { expect, it } from "vitest";
import { dashboardReducer, emptyDashboard } from "./lab-state";
import { compareStrategies } from "@/twin/simulate";
import { buildDemoTwin } from "@/merchant/demo";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import type { Proposal } from "@/ledger/proposals";

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
  expect(state).toMatchObject({ selectedId: proposal.strategy.id, proposal, confirmed: false });
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

import { expect, it, vi } from "vitest";
import { runAgent } from "./run";
import { TOOL_DEFINITIONS } from "./tools";
import { createTokenWindow } from "./limits";
import { emptyMetrics } from "@/signals/providers";
import type { AgentModel, AssistantMessage } from "./model";
import { feedbackCorpus } from "@/signals/corpus";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";
import { ledger } from "@/ledger/db";
import { listProposals, registerSandboxSubscriber } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/setup";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
const candidate = { id: "save", name: "Selective offer", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 10, months: 1, campaignMonths: 0 } };
const call = (id: string, name: string, args: unknown = {}): AssistantMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const analysis = () => [call("state", "get_merchant_state"), call("classify", "classify_feedback"), call("rules", "set_decision_rules", { discountBudget: 1000, maxProbWorse: 1, horizonMonths: 1 }), call("compare", "simulate_strategies", { strategies: [candidate] })];
const recommend = () => call("recommend", "recommend", { strategyId: "save", rationale: "Computed comparison supports this bounded offer", tradeoffs: "Adverse assumptions may remove the gain" });
function modelFor(sequence: AssistantMessage[]) {
  let turn = 0;
  return { respond: vi.fn<AgentModel["respond"]>(async () => ({ message: sequence[turn++] ?? say("No action"), metrics: emptyMetrics() })) };
}
function setup() {
  ledger().exec("DELETE FROM sandbox_subscribers; DELETE FROM proposals;");
  PILOT_COHORT.forEach((pilot, i) => registerSandboxSubscriber({ ...pilot, subscriptionId: `I-FLOW${i}` }));
  return { objective: "Investigate a bounded retention offer", env, window: createTokenWindow(), toolOptions: {
    classify: async () => ({ accepted: feedbackCorpus.map((m) => ({ id: m.id, intent: "cancel" as const, reason: "price" as const, confidence: .9 })), total: 200, cacheHits: 200, unclassified: [], diagnostics: [], schemaValidCount: 200, batches: [], metrics: emptyMetrics(), stopped: false }),
    simulate: (twin: Parameters<typeof compareStrategies>[0], candidates: Parameters<typeof compareStrategies>[1], options: Parameters<typeof compareStrategies>[2]) => compareStrategies(twin, candidates, { ...options, runs: 10 }),
    stress: (twin: Parameters<typeof stressTest>[0], strategy: Parameters<typeof stressTest>[1], options: Parameters<typeof stressTest>[2]) => stressTest(twin, strategy, { ...options, runs: 10 }),
  } };
}
const names = (tools: typeof TOOL_DEFINITIONS) => tools.map((t) => t.function.name);
it("advertises missing prerequisites from actual tool state, then all seven and no tools after proposal", async () => {
  const model = modelFor([...analysis(), call("stress", "stress_test", { strategyId: "save" }), recommend(), say("Proposed only")]);
  const result = await runAgent({ ...setup(), model });
  expect(result.status).toBe("complete");
  expect(names(model.respond.mock.calls[0][1])).toEqual(["get_merchant_state", "classify_feedback", "set_decision_rules"]);
  expect(names(model.respond.mock.calls[2][1])).toEqual(["get_merchant_state", "set_decision_rules"]);
  expect(names(model.respond.mock.calls[3][1])).toEqual(names(TOOL_DEFINITIONS));
  expect(names(model.respond.mock.calls.at(-1)![1])).toEqual([]);
  expect(listProposals()).toHaveLength(1);
  expect(listProposals()[0].status).toBe("proposed");
});
it("also hides an already completed rule prerequisite when classification is still missing", async () => {
  const model = modelFor([analysis()[2], say("Stop before analysis")]);
  expect((await runAgent({ ...setup(), model })).reason).toBe("NO_PROPOSAL");
  expect(names(model.respond.mock.calls[1][1])).toEqual(["get_merchant_state", "classify_feedback"]);
  expect(model.respond).toHaveBeenCalledTimes(2);
});
it.each([{}, { classified: true }, { rulesExplicit: true }])("counts premature analysis calls with prerequisites %j and supplies matched errors without dispatch", async (state) => {
  const dispatch = vi.fn(async () => ({ ok: true as const, data: {} }));
  const model = modelFor([call("early-sim", "simulate_strategies", { strategies: [candidate] }), call("early-stress", "stress_test", { strategyId: "save" }), call("early-draft", "draft_customer_message", { strategyId: "save", message: "Offer" }), recommend(), say("No action")]);
  const result = await runAgent({ ...setup(), model, createTools: () => ({ definitions: TOOL_DEFINITIONS, state, dispatch }) });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 4, executedTools: 4, modelTurns: 5 } });
  expect(dispatch).not.toHaveBeenCalled();
  const replies = result.transcript.filter((m) => m.role === "tool");
  expect(replies.map((m) => m.tool_call_id)).toEqual(["early-sim", "early-stress", "early-draft", "recommend"]);
  expect(replies.every((m) => JSON.parse(m.content).code === "PREREQUISITE")).toBe(true);
  expect(listProposals()).toEqual([]);
});
it("does not clarify before a current comparison, including after rules invalidate a prior comparison", async () => {
  for (const priorComparison of [false, true]) {
    const sequence = priorComparison ? [...analysis(), call("updated-rules", "set_decision_rules", { discountBudget: 500, maxProbWorse: 1, horizonMonths: 1 })] : analysis().slice(0, 3);
    const model = modelFor([...sequence, say("No action.")]);
    const result = await runAgent({ ...setup(), model });
    expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { modelTurns: sequence.length + 1 } });
    expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(1);
  }
});
it("recovers a prose-only recommendation through a real recommend call and final public summary", async () => {
  const model = modelFor([...analysis(), call("stress", "stress_test", { strategyId: "save" }), call("draft", "draft_customer_message", { strategyId: "save", message: "Temporary offer" }), say("I recommend the selective offer."), recommend(), say("Proposed, awaiting merchant approval.")]);
  const result = await runAgent({ ...setup(), model });
  expect(result).toMatchObject({ status: "complete", counters: { requestedTools: 7, executedTools: 7, modelTurns: 9 } });
  expect(model.respond.mock.calls[7][0].at(-1)?.role).toBe("user");
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
  expect(listProposals()).toHaveLength(1);
  expect(listProposals()[0].status).toBe("proposed");
});
it("preserves an intentional decline after one clarification", async () => {
  const model = modelFor([...analysis(), say("I choose no action because the assumptions remain uncertain."), say("Confirmed: keep current pricing; no proposal.")]);
  const result = await runAgent({ ...setup(), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 4, modelTurns: 6 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
  expect(listProposals()).toEqual([]);
});
it("uses at most one clarification even when the model calls another tool before declining", async () => {
  const model = modelFor([...analysis(), say("Analysis complete."), call("reread", "get_merchant_state"), say("No supported proposal.")]);
  const result = await runAgent({ ...setup(), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 5, modelTurns: 7 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
});
it.each([false, true])("does not clarify after the tool allowance is exhausted (separate turns: %s)", async (separateTurns) => {
  const extra = Array.from({ length: 6 }, (_, i) => call(`extra${i}`, "get_merchant_state"));
  const replies = separateTurns ? extra : [{ role: "assistant" as const, content: null, tool_calls: extra.flatMap((m) => m.tool_calls!) }];
  const model = modelFor([...analysis(), ...replies, say("No proposal.")]);
  const result = await runAgent({ ...setup(), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 10, executedTools: 10, modelTurns: separateTurns ? 11 : 6 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(1);
  expect(listProposals()).toEqual([]);
});
it("honors cancellation before dispatching a recommendation returned after clarification", async () => {
  const controller = new AbortController();
  const model = modelFor([...analysis(), say("I recommend an offer"), recommend()]);
  const respond = model.respond;
  model.respond = vi.fn(async (...args) => { const result = await respond(...args); if (respond.mock.calls.length === 6) controller.abort(); return result; });
  const result = await runAgent({ ...setup(), model, signal: controller.signal });
  expect(result).toMatchObject({ reason: "CANCELLED", counters: { requestedTools: 4, modelTurns: 6 } });
  expect(listProposals()).toEqual([]);
});
it.each([150, 33000])("charges clarification HTTP usage and respects the existing token cap: %i", async (secondUsage) => {
  let requests = 0;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "No action" } }], usage: { total_tokens: ++requests === 1 ? 150 : secondUsage } })));
  const result = await runAgent({ ...setup(), fetch: fetcher, createTools: () => ({ definitions: TOOL_DEFINITIONS, state: { classified: true, rulesExplicit: true, comparison: { baselineId: "baseline" } }, dispatch: vi.fn() }) });
  expect(result.reason).toBe(secondUsage === 150 ? "NO_PROPOSAL" : "TOKEN_LIMIT");
  expect(result.counters).toMatchObject({ modelTurns: 2, httpRequests: 2, reportedTokens: 150 + secondUsage });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

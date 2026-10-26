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
async function setup() {
  ledger().exec("DELETE FROM sandbox_subscribers; DELETE FROM proposals;");
  for (const [i, pilot] of PILOT_COHORT.entries()) await registerSandboxSubscriber({ ...pilot, subscriptionId: `I-FLOW${i}` });
  return { objective: "Investigate a bounded retention offer", env, window: createTokenWindow(), toolOptions: {
    classify: async () => ({ accepted: feedbackCorpus.map((m) => ({ id: m.id, intent: "cancel" as const, reason: "price" as const, confidence: .9 })), total: 200, cacheHits: 200, unclassified: [], diagnostics: [], schemaValidCount: 200, batches: [], metrics: emptyMetrics(), stopped: false }),
    simulate: (twin: Parameters<typeof compareStrategies>[0], candidates: Parameters<typeof compareStrategies>[1], options: Parameters<typeof compareStrategies>[2]) => compareStrategies(twin, candidates, { ...options, runs: 10 }),
    stress: (twin: Parameters<typeof stressTest>[0], strategy: Parameters<typeof stressTest>[1], options: Parameters<typeof stressTest>[2]) => stressTest(twin, strategy, { ...options, runs: 10 }),
  } };
}
const names = (tools: typeof TOOL_DEFINITIONS) => tools.map((t) => t.function.name);
it("requires preparation tools for a model that otherwise stops before completing prerequisites", async () => {
  let readState = false;
  const afterPreparation = [analysis()[3], call("stress", "stress_test", { strategyId: "save" }), call("draft", "draft_customer_message", { strategyId: "save", message: "Temporary offer" }), recommend(), say("Proposed only")];
  const model = { respond: vi.fn<AgentModel["respond"]>(async (messages, definitions, options) => {
    const available = names(definitions);
    let message: AssistantMessage;
    if (options?.requireTool) {
      if (!readState) { readState = true; message = analysis()[0]; }
      else if (!messages.some((m) => m.role === "tool" && m.tool_call_id === "classify" && JSON.parse(m.content).ok)) message = analysis()[1];
      else message = analysis()[2];
    } else message = available.includes("simulate_strategies") || options?.final ? afterPreparation.shift()! : say("Analysis tools are unavailable.");
    return { message, metrics: emptyMetrics() };
  }) };
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ status: "complete", counters: { requestedTools: 7, executedTools: 7, modelTurns: 8 } });
  expect(model.respond.mock.calls.map((args) => args[2]?.requireTool)).toEqual([true, true, true, false, false, false, false, false]);
  expect(model.respond.mock.calls.at(-1)?.[2]).toMatchObject({ final: true, requireTool: false });
  const preparation = result.transcript.flatMap((m) => m.role === "system" && m.content.startsWith("Runner preparation:") ? [m.content] : []);
  expect(preparation).toHaveLength(3);
  expect(preparation.every((content) => content.length <= 400)).toBe(true);
  expect(preparation[0]).toContain("classify_feedback");
  expect(preparation[0]).toContain("set_decision_rules");
  expect(preparation[2]).not.toContain("classify_feedback");
  expect(preparation[2]).toContain("set_decision_rules");
  expect(result.transcript.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["state", "classify", "rules", "compare", "stress", "draft", "recommend"]);
  expect((await listProposals())[0].status).toBe("proposed");
});
it("retains strict call and turn caps when a model repeatedly uses a preparation tool", async () => {
  const model = modelFor(Array.from({ length: 11 }, (_, i) => call(`repeat${i}`, "get_merchant_state")));
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ reason: "TOOL_LIMIT", counters: { requestedTools: 11, executedTools: 10, modelTurns: 11 } });
  expect(model.respond.mock.calls.every((args) => args[2]?.requireTool === true)).toBe(true);
  expect(result.transcript.filter((m) => m.role === "system" && m.content.startsWith("Runner preparation:"))).toHaveLength(11);
  expect(await listProposals()).toEqual([]);
});
it("stops safely on a preparation-mode HTTP 400 without retrying or exposing its body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"error":"RAW_PRIVATE_PROVIDER_DETAILS"}', { status: 400 }));
  const result = await runAgent({ ...(await setup()), fetch: fetcher });
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body).toMatchObject({ tool_choice: "required" });
  expect(result).toMatchObject({ status: "incomplete", reason: "PROVIDER_FAILED", counters: { modelTurns: 1, httpRequests: 1, requestedTools: 0 } });
  expect(result.requests[0].status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("RAW_PRIVATE_PROVIDER_DETAILS");
  expect(await listProposals()).toEqual([]);
});
it("keeps all seven tools advertised throughout nonfinal turns and no tools after proposal", async () => {
  const model = modelFor([...analysis(), call("stress", "stress_test", { strategyId: "save" }), recommend(), say("Proposed only")]);
  const result = await runAgent({ ...(await setup()), model });
  expect(result.status).toBe("complete");
  expect(model.respond.mock.calls.slice(0, -1).map((args) => names(args[1]))).toEqual(Array(6).fill(names(TOOL_DEFINITIONS)));
  expect(names(model.respond.mock.calls.at(-1)![1])).toEqual([]);
  expect(await listProposals()).toHaveLength(1);
  expect((await listProposals())[0].status).toBe("proposed");
});
it("retains the stable catalog when rules are explicit but classification is still missing", async () => {
  const model = modelFor([analysis()[2], say("Stop before analysis")]);
  expect((await runAgent({ ...(await setup()), model })).reason).toBe("NO_PROPOSAL");
  expect(names(model.respond.mock.calls[1][1])).toEqual(names(TOOL_DEFINITIONS));
  expect(model.respond).toHaveBeenCalledTimes(2);
});
it("lets a provider accept a known premature analysis call, then matches its prerequisite reply and recovers", async () => {
  const messages = [analysis()[0], analysis()[1], call("premature", "simulate_strategies", { strategies: [candidate] }), analysis()[2], analysis()[3], call("stress", "stress_test", { strategyId: "save" }), call("draft", "draft_customer_message", { strategyId: "save", message: "Temporary offer" }), recommend(), say("Proposed only")];
  const options = await setup();
  const simulate = vi.fn(options.toolOptions.simulate);
  let turn = 0;
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(init!.body as string);
    const message = messages[turn++];
    const advertised = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
    if (message.tool_calls?.some((call) => !advertised.includes(call.function.name))) return new Response('{"error":{"code":"tool_use_failed"}}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 100 } }));
  });
  const result = await runAgent({ ...options, fetch: fetcher, toolOptions: { ...options.toolOptions, simulate } });
  expect(result).toMatchObject({ status: "complete", counters: { requestedTools: 8, executedTools: 8, modelTurns: 9, httpRequests: 9 } });
  expect(simulate).toHaveBeenCalledTimes(1);
  const preparationReply = result.transcript.find((m) => m.role === "tool" && m.tool_call_id === "premature");
  expect(preparationReply?.role === "tool" && JSON.parse(preparationReply.content)).toMatchObject({ ok: false, code: "PREREQUISITE" });
  const nextBody = JSON.parse(fetcher.mock.calls[3][1]!.body as string);
  expect(nextBody.messages).toContainEqual(preparationReply);
  expect(await listProposals()).toHaveLength(1);
  expect((await listProposals())[0].status).toBe("proposed");
});
it.each([{}, { classified: true }, { rulesExplicit: true }])("counts premature analysis calls with prerequisites %j and supplies matched errors without dispatch", async (state) => {
  const dispatch = vi.fn(async () => ({ ok: true as const, data: {} }));
  const model = modelFor([call("early-sim", "simulate_strategies", { strategies: [candidate] }), call("early-stress", "stress_test", { strategyId: "save" }), call("early-draft", "draft_customer_message", { strategyId: "save", message: "Offer" }), recommend(), say("No action")]);
  const result = await runAgent({ ...(await setup()), model, createTools: () => ({ definitions: TOOL_DEFINITIONS, state, dispatch }) });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 4, executedTools: 4, modelTurns: 5 } });
  expect(dispatch).not.toHaveBeenCalled();
  const replies = result.transcript.filter((m) => m.role === "tool");
  expect(replies.map((m) => m.tool_call_id)).toEqual(["early-sim", "early-stress", "early-draft", "recommend"]);
  expect(replies.every((m) => JSON.parse(m.content).code === "PREREQUISITE")).toBe(true);
  expect(await listProposals()).toEqual([]);
});
it("does not clarify before a current comparison, including after rules invalidate a prior comparison", async () => {
  for (const priorComparison of [false, true]) {
    const sequence = priorComparison ? [...analysis(), call("updated-rules", "set_decision_rules", { discountBudget: 500, maxProbWorse: 1, horizonMonths: 1 })] : analysis().slice(0, 3);
    const model = modelFor([...sequence, say("No action.")]);
    const result = await runAgent({ ...(await setup()), model });
    expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { modelTurns: sequence.length + 1 } });
    expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(1);
  }
});
it("recovers a prose-only recommendation through a real recommend call and final public summary", async () => {
  const model = modelFor([...analysis(), call("stress", "stress_test", { strategyId: "save" }), call("draft", "draft_customer_message", { strategyId: "save", message: "Temporary offer" }), say("I recommend the selective offer."), recommend(), say("Proposed, awaiting merchant approval.")]);
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ status: "complete", counters: { requestedTools: 7, executedTools: 7, modelTurns: 9 } });
  expect(model.respond.mock.calls[7][0].at(-1)?.role).toBe("user");
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
  expect(await listProposals()).toHaveLength(1);
  expect((await listProposals())[0].status).toBe("proposed");
});
it("preserves an intentional decline after one clarification", async () => {
  const model = modelFor([...analysis(), say("I choose no action because the assumptions remain uncertain."), say("Confirmed: keep current pricing; no proposal.")]);
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 4, modelTurns: 6 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
  expect(model.respond.mock.calls.slice(4).every((args) => args[2]?.requireTool === false)).toBe(true);
  expect(await listProposals()).toEqual([]);
});
it("uses at most one clarification even when the model calls another tool before declining", async () => {
  const model = modelFor([...analysis(), say("Analysis complete."), call("reread", "get_merchant_state"), say("No supported proposal.")]);
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 5, modelTurns: 7 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(2);
});
it.each([false, true])("does not clarify after the tool allowance is exhausted (separate turns: %s)", async (separateTurns) => {
  const extra = Array.from({ length: 6 }, (_, i) => call(`extra${i}`, "get_merchant_state"));
  const replies = separateTurns ? extra : [{ role: "assistant" as const, content: null, tool_calls: extra.flatMap((m) => m.tool_calls!) }];
  const model = modelFor([...analysis(), ...replies, say("No proposal.")]);
  const result = await runAgent({ ...(await setup()), model });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { requestedTools: 10, executedTools: 10, modelTurns: separateTurns ? 11 : 6 } });
  expect(result.transcript.filter((m) => m.role === "user")).toHaveLength(1);
  expect(await listProposals()).toEqual([]);
});
it("honors cancellation before dispatching a recommendation returned after clarification", async () => {
  const controller = new AbortController();
  const model = modelFor([...analysis(), say("I recommend an offer"), recommend()]);
  const respond = model.respond;
  model.respond = vi.fn(async (...args) => { const result = await respond(...args); if (respond.mock.calls.length === 6) controller.abort(); return result; });
  const result = await runAgent({ ...(await setup()), model, signal: controller.signal });
  expect(result).toMatchObject({ reason: "CANCELLED", counters: { requestedTools: 4, modelTurns: 6 } });
  expect(await listProposals()).toEqual([]);
});
it.each([150, 33000])("charges clarification HTTP usage and respects the existing token cap: %i", async (secondUsage) => {
  let requests = 0;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "No action" } }], usage: { total_tokens: ++requests === 1 ? 150 : secondUsage } })));
  const result = await runAgent({ ...(await setup()), fetch: fetcher, createTools: () => ({ definitions: TOOL_DEFINITIONS, state: { classified: true, rulesExplicit: true, comparison: { baselineId: "baseline" } }, dispatch: vi.fn() }) });
  expect(result.reason).toBe(secondUsage === 150 ? "NO_PROPOSAL" : "TOKEN_LIMIT");
  expect(result.counters).toMatchObject({ modelTurns: 2, httpRequests: 2, reportedTokens: 150 + secondUsage });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

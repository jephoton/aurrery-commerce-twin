import { expect, it, vi } from "vitest";
import { runAgent } from "./run";
import { createTokenWindow } from "./limits";
import { emptyMetrics } from "@/signals/providers";
import type { AgentModel } from "./model";
import { feedbackCorpus } from "@/signals/corpus";
import { ledger } from "@/ledger/db";
import { listProposals, listSandboxSubscribers, registerSandboxSubscriber } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/setup";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
const candidate = { id: "save", name: "Selective save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 10, months: 1, campaignMonths: 0 } };
const steps: [string, unknown][] = [["get_merchant_state", {}], ["classify_feedback", {}], ["set_decision_rules", { discountBudget: 1000, maxProbWorse: .5, horizonMonths: 12 }], ["simulate_strategies", { strategies: [candidate] }], ["stress_test", { strategyId: "save" }], ["draft_customer_message", { strategyId: "save", message: "A temporary offer" }], ["recommend", { strategyId: "save", rationale: "Supported base result", tradeoffs: "Stress and uncertainty remain" }]];
function fakeModel(sequence: [string, unknown][], summary = true) {
  let index = 0;
  return { respond: vi.fn<AgentModel["respond"]>(async () => {
    const step = sequence[index++];
    return { message: step ? { role: "assistant" as const, content: null, tool_calls: [{ id: `call:/opaque=${index}`, type: "function" as const, function: { name: step[0], arguments: typeof step[1] === "string" ? step[1] : JSON.stringify(step[1]) } }] } : { role: "assistant" as const, content: summary ? "Proposed only. Review uncertainty before merchant approval." : null }, metrics: emptyMetrics() };
  }) };
}
function toolOptions() {
  ledger().exec("DELETE FROM sandbox_subscribers; DELETE FROM proposals;");
  PILOT_COHORT.forEach((pilot, i) => registerSandboxSubscriber({ ...pilot, subscriptionId: `I-RUN${i}` }));
  return { classify: async () => ({ accepted: feedbackCorpus.map((m) => ({ id: m.id, intent: "cancel" as const, reason: "price" as const, confidence: .9 })), total: 200, cacheHits: 200, unclassified: [], diagnostics: [], schemaValidCount: 200, batches: [], metrics: emptyMetrics(), stopped: false }) };
}
const base = () => ({ env, window: createTokenWindow(), toolOptions: toolOptions() });
it("completes the real seven-tool flow, matches opaque IDs and forces a final public summary", async () => {
  const model = fakeModel(steps);
  const result = await runAgent({ ...base(), objective: "Investigate broad retention", model });
  expect(result.status).toBe("complete");
  expect(result.counters.requestedTools).toBe(7);
  expect(result.counters.modelTurns).toBe(8);
  expect(listProposals()).toHaveLength(1);
  expect(listProposals()[0].status).toBe("proposed");
  expect(result.transcript.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(steps.map((_, i) => `call:/opaque=${i + 1}`));
  expect(JSON.stringify(result.transcript)).not.toContain('"params"');
  expect(model.respond.mock.calls.at(-1)?.[2]).toMatchObject({ final: true });
});
it("counts malformed and unknown calls toward the ten requested-tool cap, with no execute capability", async () => {
  const result = await runAgent({ ...base(), objective: "Investigate", model: fakeModel(Array.from({ length: 11 }, (_, i) => [i % 2 ? "execute" : "get_merchant_state", i % 2 ? {} : "{broken"] as [string, unknown])) });
  expect(result).toMatchObject({ status: "incomplete", reason: "TOOL_LIMIT", counters: { requestedTools: 11, executedTools: 10, modelTurns: 11 } });
  expect(result.transcript.filter((m) => m.role === "tool")).toHaveLength(10);
  expect(listProposals()).toEqual([]);
});
it("surfaces prerequisites and ends incomplete without a valid recommendation", async () => {
  const result = await runAgent({ ...base(), objective: "Investigate", model: fakeModel([steps[6]]) });
  expect(result).toMatchObject({ status: "incomplete", reason: "NO_PROPOSAL" });
  expect(JSON.stringify(result.transcript)).toContain("PREREQUISITE");
});
it("stops on terminal classification errors without another model request", async () => {
  const model = fakeModel([["classify_feedback", {}]]);
  const result = await runAgent({ ...base(), objective: "Investigate", model, createTools: () => ({ definitions: [], state: {}, dispatch: async () => ({ ok: false as const, code: "CLASSIFICATION_FAILED", message: "Safe", terminal: true as const, failure: { category: "quota", status: 429 } }) }) });
  expect(result).toMatchObject({ status: "incomplete", reason: "QUOTA" });
  expect(model.respond).toHaveBeenCalledTimes(1);
});
it("retains a proposed row if final provider summary fails", async () => {
  const model = fakeModel(steps);
  const original = model.respond;
  model.respond = vi.fn(async (...args) => model.respond.mock.calls.length > steps.length ? { error: { category: "quota" }, metrics: emptyMetrics() } : original(...args));
  const result = await runAgent({ ...base(), objective: "Investigate", model });
  expect(result).toMatchObject({ status: "incomplete", reason: "QUOTA", proposalId: expect.any(String) });
  expect(listProposals()[0].status).toBe("proposed");
});
it("cancels before any proposed side effect and releases the lease", async () => {
  const controller = new AbortController();
  const result = await runAgent({ ...base(), objective: "Investigate", signal: controller.signal, model: { respond: async () => { controller.abort(); return { message: { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "recommend", arguments: "{}" } }] }, metrics: emptyMetrics() }; } } });
  expect(result).toMatchObject({ status: "cancelled", reason: "CANCELLED" });
  expect(listProposals()).toEqual([]);
  expect((await runAgent({ ...base(), objective: "Investigate", model: fakeModel([]) })).reason).toBe("NO_PROPOSAL");
});
it("stops duplicate IDs and extra requested tools even in one provider response", async () => {
  const response = { message: { role: "assistant" as const, content: null, tool_calls: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, type: "function" as const, function: { name: "get_merchant_state", arguments: "{}" } })) }, metrics: emptyMetrics() };
  const result = await runAgent({ ...base(), objective: "Investigate", model: { respond: async () => response } });
  expect(result.reason).toBe("TOOL_LIMIT");
  expect(result.counters.requestedTools).toBe(11);
  expect(result.counters.executedTools).toBe(10);
  response.message.tool_calls[1].id = "a0";
  expect((await runAgent({ ...base(), objective: "Investigate", model: { respond: async () => response } })).reason).toBe("PROTOCOL");
});
it("bounds model turns, wall time and tokens using injected dependencies", async () => {
  let now = 0;
  const timeout = await runAgent({ ...base(), objective: "Investigate", now: () => now, model: { respond: async () => { now = 600001; return { message: { role: "assistant", content: "late" }, metrics: emptyMetrics() }; } } });
  expect(timeout.reason).toBe("DEADLINE");
  const tokens = await runAgent({ ...base(), objective: "Investigate", maxTokens: 100, fetch: vi.fn() });
  expect(tokens.reason).toBe("TOKEN_LIMIT");
});
it("checks the wall deadline immediately at proposal persistence", async () => {
  let now = 0, reads = 0;
  const options = base();
  const result = await runAgent({ ...options, objective: "Investigate", now: () => now, model: fakeModel(steps), toolOptions: { ...options.toolOptions, registry: () => { if (++reads === 2) now = 600001; return listSandboxSubscribers(); } } });
  expect(result.reason).toBe("DEADLINE");
  expect(listProposals()).toHaveLength(0);
});

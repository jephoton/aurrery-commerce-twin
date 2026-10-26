import { expect, it, vi } from "vitest";
import { ledger } from "@/ledger/db";
import { listProposals, registerSandboxSubscriber } from "@/ledger/proposals";
import { currentMerchant } from "@/merchant";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { PILOT_COHORT } from "@/paypal/setup";
import { createPredictionCache } from "@/signals/cache";
import { feedbackCorpus, toModelInput } from "@/signals/corpus";
import { emptyMetrics } from "@/signals/providers";
import type { AgentEvent } from "./contracts";
import { budgetedFetch, createRunBudget, createTokenWindow } from "./limits";
import { runAgent } from "./run";
import { readAgentStream } from "./stream";
import { createToolContext } from "./tools";

const env = { AI_PROVIDER: "gemini", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_API_KEY: "fake-key" };
const predictions = feedbackCorpus.map((message) => ({ id: message.id, intent: message.pilotIndex === 2 || message.pilotIndex === 3 ? "stay" : "cancel", reason: message.pilotIndex === 2 || message.pilotIndex === 3 ? "other" : "price", confidence: .9 }));
const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
const modelResponse = (parts: unknown[], usage = 150) => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 80, totalTokenCount: usage } }));

it("uses Gemini output reservations, classification attribution and total usage including thinking", async () => {
  const budget = createRunBudget({ window: createTokenWindow() });
  const fetcher = budgetedFetch(async () => modelResponse([{ text: "Done" }], 7000), budget);
  await (await fetcher("https://example.test", { body: JSON.stringify({ contents: [], generationConfig: { maxOutputTokens: 1024, responseFormat: { text: { mimeType: "APPLICATION_JSON" } } } }) })).text();
  expect(budget.requests).toMatchObject([{ kind: "classification", reportedTokens: 7000 }]);
  expect(budget.requests[0].reservation).toBeLessThan(1300);
  expect(budget.counters()).toMatchObject({ reportedTokens: 7000, accountedTokens: 7000, httpRequests: 1 });
  budget.close();
});

it("keeps unknown Gemini totals reserved and recognizes classification structurally rather than inside user text", async () => {
  const budget = createRunBudget({ window: createTokenWindow() });
  const fetcher = budgetedFetch(async () => new Response('{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"thoughtsTokenCount":200}}'), budget);
  await (await fetcher("https://example.test", { body: JSON.stringify({ contents: [{ role: "user", parts: [{ functionResponse: { name: "get_merchant_state", response: { responseFormat: "ordinary tool data" } } }] }], generationConfig: { maxOutputTokens: 1024 } }) })).text();
  expect(budget.requests[0].kind).toBe("model");
  expect(budget.counters()).toMatchObject({ reportedTokens: 0, accountedTokens: budget.requests[0].reservation });
  budget.close();
});

it("rejects missing or unsupported selected settings before HTTP and never falls back", async () => {
  for (const bad of [{ ...env, AI_PROVIDER: "unsupported", GROQ_API_KEY: "fake", GROQ_MODEL: "valid" }, { ...env, GEMINI_MODEL: "" }, { ...env, GEMINI_API_KEY: "" }]) {
    const fetcher = vi.fn();
    expect((await runAgent({ objective: "Investigate", env: bad, fetch: fetcher, window: createTokenWindow() })).reason).toBe("CONFIGURATION");
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("runs Gemini HTTP through fresh classification, cache, real tools, pacing and a single unapproved A/B proposal", async () => {
  const db = ledger();
  createPredictionCache();
  db.exec("DELETE FROM feedback_prediction_cache; DELETE FROM executions; DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM audit_events;");
  for (const [index, pilot] of PILOT_COHORT.entries()) await registerSandboxSubscriber({ ...pilot, subscriptionId: `I-GEMINI${"ABCD"[index]}` });
  const original = structuredClone(currentMerchant().twin);
  const candidate = STARTER_STRATEGIES[1];
  const steps: [string, unknown][] = [["get_merchant_state", {}], ["classify_feedback", {}], ["set_decision_rules", { discountBudget: 1000, maxProbWorse: .5, horizonMonths: 12 }], ["simulate_strategies", { strategies: STARTER_STRATEGIES.slice(0, 3) }], ["stress_test", { strategyId: candidate.id }], ["draft_customer_message", { strategyId: candidate.id, message: "A temporary offer for your review" }], ["recommend", { strategyId: candidate.id, rationale: "Supported by computed evidence", tradeoffs: "Costs and uncertainty remain" }]];
  let turn = 0, now = 0;
  const events: AgentEvent[] = [];
  const sleeps: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty("messages");
    if (body.generationConfig.responseFormat) {
      const inputs = JSON.parse(body.contents[0].parts[0].text) as { id: string }[];
      return modelResponse([{ text: JSON.stringify({ items: inputs.map(({ id }) => byId.get(id)) }) }]);
    }
    const step = steps[turn++];
    if (!step) { expect(body).not.toHaveProperty("tools"); expect(body.toolConfig.functionCallingConfig.mode).toBe("NONE"); return modelResponse([{ text: "Proposed only. Separate merchant approval is required." }]); }
    return modelResponse([{ text: "PRIVATE_THOUGHT", thought: true, thoughtSignature: "PRIVATE_SIGNATURE" }, { functionCall: { name: step[0], args: step[1], ...(turn % 2 ? { id: `provider-${turn}` } : {}) }, thoughtSignature: "PRIVATE_CALL_SIGNATURE" }]);
  });
  const result = await runAgent({ objective: "Investigate broad and selective retention and annual prepay honestly", env, fetch: fetcher, window: createTokenWindow(), now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, emit: (event) => events.push(event) });
  expect(result).toMatchObject({ reason: "COMPLETE", status: "complete", counters: { requestedTools: 7, executedTools: 7, modelTurns: 8, httpRequests: 18, reportedTokens: 2700, accountedTokens: 2700 } });
  expect(result.requests.filter((request) => request.kind === "classification")).toHaveLength(10);
  expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("gemini-3.5-flash-lite") }));
  expect(events.filter((event) => event.type === "classification").map((event) => event.summary)).toMatchObject([{ provider: "gemini", model: env.GEMINI_MODEL, accepted: 200, cacheHits: 0, eligiblePilotCount: 2 }]);
  expect(sleeps.filter((ms) => ms === 30000).length).toBeGreaterThanOrEqual(9);
  expect(events.filter((event) => event.type === "status" && event.message === "Pacing fresh classification batches for 30 seconds.")).toHaveLength(9);
  const proposals = await listProposals();
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ id: result.proposalId, status: "proposed", approvedAt: null, approvedBy: null, action: { newPrice: "18.00", targets: ["I-GEMINIA", "I-GEMINIB"] } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM executions").get()?.n).toBe(0);
  expect(db.prepare("SELECT kind FROM audit_events").all()).toEqual([{ kind: "proposal.created" }]);
  expect(currentMerchant().twin).toEqual(original);
  expect(JSON.stringify({ result, events })).not.toMatch(/PRIVATE|thoughtSignature|thoughtsTokenCount/);
  const cache = createPredictionCache();
  expect(cache.get(toModelInput(feedbackCorpus[0]), { provider: "gemini", model: env.GEMINI_MODEL })).toEqual(predictions[0]);
  expect(cache.get(toModelInput(feedbackCorpus[0]), { provider: "groq", model: env.GEMINI_MODEL })).toBeUndefined();
  const network = vi.fn<typeof fetch>(async () => { throw new Error("Cache should avoid HTTP"); });
  const ctx = createToolContext({ env, provider: { provider: "gemini", model: env.GEMINI_MODEL, classify: network as never } });
  expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: true, data: { provider: "gemini", cacheHits: 200 } });
  expect(network).not.toHaveBeenCalled();
  const classification = events.find((event) => event.type === "classification")!;
  const decoded: AgentEvent[] = [];
  const frames = [classification, { type: "done", status: "complete" }].map((event, index) => JSON.stringify({ runId: "gemini", seq: index + 1, event })).join("\n") + "\n";
  await readAgentStream(new Response(frames), { onEvent: (event) => decoded.push(event) });
  expect(decoded[0]).toEqual(classification);
  const forged = structuredClone(classification);
  if (forged.type === "classification") Object.assign(forged.summary, { provider: "unsupported" });
  await expect(readAgentStream(new Response(JSON.stringify({ runId: "gemini", seq: 1, event: forged }) + "\n"), { onEvent() {} })).rejects.toThrow(/stream/i);
}, 30000);

it.each([401, 429])("stops Gemini classifier HTTP %s with no fallback, proposal or subsequent turn", async (status) => {
  let now = 0;
  const model = `${env.GEMINI_MODEL}-failure-${status}`;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return body.generationConfig.responseFormat ? new Response('{"error":"PRIVATE"}', { status }) : modelResponse([{ functionCall: { name: "classify_feedback", args: {} } }]);
  });
  const events: AgentEvent[] = [];
  const result = await runAgent({ objective: "Investigate", env: { ...env, GEMINI_MODEL: model }, fetch: fetcher, window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; }, emit: (event) => events.push(event) });
  expect(result).toMatchObject({ reason: status === 429 ? "QUOTA" : "CLASSIFICATION_FAILED", counters: { modelTurns: 1, httpRequests: 2 } });
  expect(result.proposalId).toBeUndefined();
  expect(events.filter((event) => event.type === "classification").map((event) => event.summary)).toMatchObject([{ provider: "gemini", model, accepted: 0 }]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("counts both transient classifier HTTP attempts inside the shared run boundary", async () => {
  let now = 0, classifications = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (!body.generationConfig.responseFormat) return modelResponse([{ functionCall: { name: "classify_feedback", args: {} } }]);
    return new Response("{}", { status: ++classifications === 1 ? 503 : 429 });
  });
  const result = await runAgent({ objective: "Investigate", env: { ...env, GEMINI_MODEL: "classifier-retry" }, fetch: fetcher, window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; } });
  expect(result).toMatchObject({ reason: "QUOTA", counters: { modelTurns: 1, httpRequests: 3, reportedTokens: 150 } });
  expect(result.requests.map((request) => request.kind)).toEqual(["model", "classification", "classification"]);
  expect(result.counters.accountedTokens).toBe(150 + result.requests.slice(1).reduce((sum, request) => sum + request.reservation, 0));
});

it("cancels Gemini preflight pacing and stalled body reads without further requests", async () => {
  const pacing = new AbortController();
  const window = createTokenWindow();
  window.entries.push({ at: Date.now(), tokens: 8000 });
  const network = vi.fn<typeof fetch>();
  expect((await runAgent({ objective: "Investigate", env, fetch: network, window, signal: pacing.signal, sleep: async () => { pacing.abort(); } })).reason).toBe("CANCELLED");
  expect(network).not.toHaveBeenCalled();
  const controller = new AbortController();
  const cancelled = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); }, cancel: cancelled })));
  expect((await runAgent({ objective: "Investigate", env, fetch: fetcher, window: createTokenWindow(), signal: controller.signal })).reason).toBe("CANCELLED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancelled).toHaveBeenCalled();
});

it("stops before dispatch when Gemini total usage exceeds the unchanged total token cap", async () => {
  const dispatch = vi.fn();
  const result = await runAgent({ objective: "Investigate", env, window: createTokenWindow(), fetch: async () => modelResponse([{ functionCall: { name: "get_merchant_state", args: {} } }], 33000), createTools: () => ({ definitions: [], state: {}, dispatch }) });
  expect(result.reason).toBe("TOKEN_LIMIT");
  expect(dispatch).not.toHaveBeenCalled();
});

it("retains unknown-usage retry reservations and safe provider-neutral pacing", async () => {
  let now = 0;
  const window = createTokenWindow();
  window.entries.push({ at: now, tokens: 8000 });
  const events: AgentEvent[] = [];
  const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? new Response("{}", { status: 503 }) : new Response("{}", { status: 429 }));
  const result = await runAgent({ objective: "Investigate", env, fetch: fetcher, window, now: () => now, sleep: async (ms) => { now += ms; }, emit: (event) => events.push(event) });
  expect(result).toMatchObject({ reason: "QUOTA", counters: { httpRequests: 2, reportedTokens: 0 } });
  expect(result.counters.accountedTokens).toBe(result.requests.reduce((sum, request) => sum + request.reservation, 0));
  expect(events.some((event) => event.type === "wait")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("Groq");
});

it("rejects unconfigured direct tools and invalid classifier identity instead of mislabelling provenance", async () => {
  const missing = createToolContext({ env: {} });
  expect(await missing.dispatch("classify_feedback", {})).toMatchObject({ ok: false, terminal: true, code: "CONFIGURATION" });
  const invalid = createToolContext({ provider: { provider: "other" as "gemini", model: "valid", classify: vi.fn() } });
  expect(await invalid.dispatch("classify_feedback", {})).toMatchObject({ ok: false, terminal: true, code: "CONFIGURATION" });
});

it("uses explicit selected settings for a direct tool context and attributes its result honestly", async () => {
  const ctx = createToolContext({ env, classify: async (_inputs, { provider }) => {
    expect(provider).toMatchObject({ provider: "gemini", model: env.GEMINI_MODEL });
    return { accepted: [], unclassified: [], diagnostics: [], total: 200, cacheHits: 0, schemaValidCount: 0, batches: [], metrics: emptyMetrics(), stopped: false };
  } });
  expect(await ctx.dispatch("classify_feedback", {})).toMatchObject({ ok: false, code: "NO_ACCEPTED_EVIDENCE" });
  expect(ctx.state.classification).toMatchObject({ provider: "gemini", model: env.GEMINI_MODEL });
});

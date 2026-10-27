import { afterEach, expect, it, vi } from "vitest";
import { ledger } from "@/ledger/db";
import { hashAction, listProposals, listSandboxSubscribers, registerSandboxSubscriber } from "@/ledger/proposals";
import { currentMerchant } from "@/merchant";
import { PILOT_COHORT } from "@/paypal/setup";
import { createPredictionCache } from "@/signals/cache";
import { PredictionSchema } from "@/signals/contracts";
import { feedbackCorpus, toModelInput } from "@/signals/corpus";
import { pilotEligibility } from "@/signals/evidence";
import { emptyMetrics } from "@/signals/providers";
import type { Summary } from "@/twin/types";
import type { AgentEvent } from "./contracts";
import recording from "./fixtures/m3-recorded-groq.json";
import geminiRecording from "./fixtures/m3-recorded-gemini.json";
import { createTokenWindow } from "./limits";
import { publicAssistant, type AgentModel } from "./model";
import { runAgent } from "./run";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function expectSummary(actual: Summary & { probPositive: number }, expected: Summary & { probPositive: number }) {
  for (const key of ["mean", "p10", "p50", "p90", "probPositive"] as const) {
    expect(actual[key], key).toBeCloseTo(expected[key], 8);
  }
}

it.each([recording, geminiRecording])("replays the genuine $provider run through cached classification, paired simulation, stress and proposed-only ledger", async (recording) => {
  const network = vi.fn<typeof fetch>(async () => { throw new Error("Network is forbidden in recorded replay"); });
  vi.stubGlobal("fetch", network);
  const db = ledger();
  db.exec("DELETE FROM executions; DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM audit_events;");
  for (const [index, pilot] of PILOT_COHORT.entries()) await registerSandboxSubscriber({ ...pilot, subscriptionId: `I-REPLAY${"ABCD"[index]}` });
  const cache = createPredictionCache();
  db.exec("DELETE FROM feedback_prediction_cache;");
  const predictions = recording.predictions.map((prediction) => PredictionSchema.parse(prediction));
  expect(predictions).toHaveLength(200);
  for (const input of feedbackCorpus.map(toModelInput)) {
    const prediction = predictions.find(({ id }) => id === input.id);
    expect(prediction, input.id).toBeDefined();
    await cache.set(input, { provider: recording.provider as "groq" | "gemini", model: recording.model }, prediction!);
  }
  const original = structuredClone(currentMerchant().twin);
  const events: AgentEvent[] = [];
  let turn = 0;
  const model: AgentModel = { respond: vi.fn<AgentModel["respond"]>(async (_history, definitions) => {
    const message = publicAssistant(recording.modelResponses[turn++]);
    expect(message).toBeDefined();
    for (const call of message?.tool_calls ?? []) {
      expect(definitions.map((tool) => tool.function.name)).toContain(call.function.name);
    }
    return { message, metrics: emptyMetrics() };
  }) };
  const result = await runAgent({
    objective: recording.objective, model, fetch: network, window: createTokenWindow(),
    env: recording.provider === "groq"
      ? { AI_PROVIDER: "groq", GROQ_MODEL: recording.model, GROQ_API_KEY: "replay-placeholder" }
      : { AI_PROVIDER: "gemini", GEMINI_MODEL: recording.model, GEMINI_API_KEY: "replay-placeholder" },
    emit: (event) => events.push(event),
  });
  expect(result).toMatchObject({ status: "complete", reason: "COMPLETE", counters: {
    requestedTools: recording.expected.counters.requestedTools,
    executedTools: recording.expected.counters.executedTools,
    modelTurns: recording.expected.counters.modelTurns,
    // Recorded live usage stays in the fixture; replay makes no HTTP requests.
    httpRequests: 0, reportedTokens: 0, accountedTokens: 0,
  } });
  expect(turn).toBe(8);
  expect(network).not.toHaveBeenCalled();
  expect(result.requests).toEqual([]);
  expect(events.flatMap((event) => event.type === "tool_started" ? [event.name] : [])).toEqual(recording.expected.toolSequence);
  const replies = result.transcript.filter((message) => message.role === "tool");
  const calls = recording.modelResponses.flatMap((message) => "tool_calls" in message ? message.tool_calls ?? [] : []);
  expect(replies.map((reply) => reply.tool_call_id)).toEqual(calls.map((call) => call.id));
  expect(replies.every((reply) => JSON.parse(reply.content).ok === true)).toBe(true);
  expect(result.transcript.filter((message) => message.role === "assistant")).toEqual(recording.modelResponses);
  // No prose repair or synthetic winning calls were inserted into the recording.
  expect(result.transcript.filter((message) => message.role === "user")).toHaveLength(1);
  expect(events.filter((event) => event.type === "classification").map((event) => event.summary)).toEqual([recording.expected.classification]);
  expect(events.filter((event) => event.type === "rules").map((event) => event.rules)).toEqual([recording.expected.rules]);
  const eligibility = pilotEligibility(feedbackCorpus, predictions, await listSandboxSubscribers(), PILOT_COHORT.map(({ label }) => label));
  expect(eligibility.issues).toEqual([]);
  expect(eligibility.eligibleSubscriptionIds).toEqual(["I-REPLAYA", "I-REPLAYB"]);
  expect(eligibility.pilots.map(({ eligible }) => eligible)).toEqual([true, true, false, false]);

  const comparisons = events.filter((event) => event.type === "comparison");
  expect(comparisons).toHaveLength(1);
  expect(comparisons[0].comparison.options).toEqual({ runs: 1000, seed: 20261113, horizonMonths: 12 });
  const computed = comparisons[0].comparison.strategies;
  expect(computed.map(({ strategy }) => strategy)).toEqual(recording.expected.comparisons.map(({ strategy }) => strategy));
  for (const [index, expected] of recording.expected.comparisons.entries()) {
    expectSummary(computed[index].vsBaseline.totalValue, expected.totalValueDelta);
    expect(computed[index].probValueBelowBaseline).toBeCloseTo(expected.chanceWorse, 8);
    expect(computed[index].metrics.discountCost.mean).toBeCloseTo(expected.meanDiscountCost, 8);
  }
  const stresses = events.filter((event) => event.type === "stress");
  expect(stresses).toHaveLength(1);
  expect(stresses[0].strategyId).toBe(recording.expected.stress.strategyId);
  expectSummary(stresses[0].stress.base.vsBaseline.totalValue, recording.expected.stress.base);
  expectSummary(stresses[0].stress.stressed.vsBaseline.totalValue, recording.expected.stress.stressed);
  expect(stresses[0].stress.stressed.probValueBelowBaseline).toBeCloseTo(recording.expected.stress.stressedChanceWorse, 8);
  const draftCall = calls.find((call) => call.function.name === "draft_customer_message")!;
  expect(events.filter((event) => event.type === "draft")).toEqual([{ type: "draft", ...JSON.parse(draftCall.function.arguments), displayOnly: true }]);
  const proposals = await listProposals();
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    id: result.proposalId, objective: recording.objective, action: recording.expected.action,
    status: recording.expected.status, approvedAt: null, approvedBy: null, completedAt: null, revertAfter: null,
  });
  expect(proposals[0].actionHash).toBe(hashAction(proposals[0].action));
  expect(proposals[0].prediction).toEqual({ metrics: computed[2].metrics, vsBaseline: computed[2].vsBaseline, probValueBelowBaseline: computed[2].probValueBelowBaseline });
  expect(db.prepare("SELECT COUNT(*) AS n FROM executions").get()?.n).toBe(0);
  expect(db.prepare("SELECT kind FROM audit_events").all()).toEqual([{ kind: "proposal.created" }]);
  expect(currentMerchant().twin).toEqual(original);

  for (const message of result.transcript.filter((message) => message.role === "assistant")) {
    expect(Object.keys(message).sort()).toEqual(message.tool_calls ? ["content", "role", "tool_calls"] : ["content", "role"]);
  }
  expect(JSON.stringify(result.transcript)).not.toMatch(/"(?:params|groundTruth|trueIntent|trueReason|reasoning|reasoning_content|api_key)"/);
  expect(JSON.stringify(recording)).not.toMatch(/(?:C:\\\\Users\\\\|I-(?!REPLAY)[A-Z0-9]{8,}|prop_[0-9a-f]{8}-)/);
}, 30000);

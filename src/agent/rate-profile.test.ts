import { expect, it, vi } from "vitest";
import { toModelInput, feedbackCorpus } from "@/signals/corpus";
import { budgetedFetch, createRunBudget, createTokenWindow, selectedAgentRateProfile } from "./limits";
import { runAgent } from "./run";
import { TOOL_DEFINITIONS } from "./tools";

const gemini = { AI_PROVIDER: "gemini", GEMINI_MODEL: "rate-profile-test", GEMINI_API_KEY: "fake" };
const groq = { AI_PROVIDER: "groq", GROQ_MODEL: "rate-profile-test", GROQ_API_KEY: "fake" };
const profile = { tokensPerMinute: 100000, requestsPerMinute: 12 };
const body = { generationConfig: { maxOutputTokens: 1 } };

it("defaults unknown-account Gemini to 8000 TPM/five RPM, accepts bounded opt-in settings and leaves Groq fixed", () => {
  expect(selectedAgentRateProfile("gemini", {})).toEqual({ tokensPerMinute: 8000, requestsPerMinute: 5 });
  expect(selectedAgentRateProfile("gemini", { GEMINI_AGENT_TPM: "250000", GEMINI_AGENT_RPM: "15" })).toEqual({ tokensPerMinute: 250000, requestsPerMinute: 15 });
  expect(selectedAgentRateProfile("gemini", { GEMINI_AGENT_RPM: "12" })).toEqual({ tokensPerMinute: 8000, requestsPerMinute: 12 });
  expect(selectedAgentRateProfile("groq", { GEMINI_AGENT_TPM: "250000", GEMINI_AGENT_RPM: "15" })).toEqual({ tokensPerMinute: 8000 });
});

it("allows twelve actual unknown-usage HTTP attempts then paces the thirteenth without counting preflights", async () => {
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const window = createTokenWindow();
  const budget = createRunBudget({ window, now: () => now, sleep, rateProfile: profile });
  const fetcher = vi.fn(async () => new Response("{}"));
  const request = budgetedFetch(fetcher, budget);
  for (let index = 0; index < 12; index++) {
    await budget.prepare(body);
    await budget.prepare(body);
    expect(budget.counters().httpRequests).toBe(index);
    await (await request("https://example.test", { body: JSON.stringify(body) })).text();
  }
  expect(sleep).not.toHaveBeenCalled();
  expect(budget.counters()).toMatchObject({ httpRequests: 12, reportedTokens: 0 });
  await budget.prepare(body);
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(now).toBe(60000);
  expect(fetcher).toHaveBeenCalledTimes(12);
  await (await request("https://example.test", { body: JSON.stringify(body) })).text();
  expect(fetcher).toHaveBeenCalledTimes(13);
  expect(budget.counters().httpRequests).toBe(13);
  expect(budget.counters().accountedTokens).toBe(budget.requests.reduce((sum, request) => sum + request.reservation, 0));
  budget.close();
});

it("waits once until enough entries expire to satisfy both token and request limits", async () => {
  let now = 20000;
  const window = createTokenWindow();
  window.entries.push({ at: 0, tokens: 1000 }, { at: 10000, tokens: 5000 }, { at: 20000, tokens: 1000 });
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const budget = createRunBudget({ window, now: () => now, sleep, rateProfile: { tokensPerMinute: 8000, requestsPerMinute: 3 } });
  await budget.reserve(4000);
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledWith(50000, expect.any(AbortSignal));
  expect(window.entries).toEqual([{ at: 20000, tokens: 1000 }, { at: 70000, tokens: 4000 }]);
  budget.close();
});

it("raises only the configured rolling TPM rate, preserving the 32000 total cap and default 8000 rate", async () => {
  const defaults = createRunBudget({ window: createTokenWindow() });
  await expect(defaults.reserve(8001)).rejects.toThrow("TOKEN_LIMIT");
  defaults.close();
  const budget = createRunBudget({ window: createTokenWindow(), maxTokens: 100000, rateProfile: profile });
  await budget.reserve(20000);
  await expect(budget.reserve(12001)).rejects.toThrow("TOKEN_LIMIT");
  expect(budget.counters()).toMatchObject({ accountedTokens: 20000, httpRequests: 1 });
  budget.close();
});

it.each(["cancel", "deadline"])("honors %s during request-rate waits before the next reservation", async (mode) => {
  const controller = new AbortController();
  let now = 0;
  const sleep = vi.fn(async () => { controller.abort(); });
  const budget = createRunBudget({ signal: controller.signal, window: createTokenWindow(), now: () => now, sleep, maxDurationMs: mode === "deadline" ? 60000 : 600000, rateProfile: { tokensPerMinute: 100000, requestsPerMinute: 1 } });
  await budget.reserve(1);
  now = 1;
  await expect(budget.reserve(1)).rejects.toThrow(mode === "deadline" ? "DEADLINE" : "CANCELLED");
  expect(budget.counters().httpRequests).toBe(1);
  expect(sleep).toHaveBeenCalledTimes(mode === "deadline" ? 0 : 1);
  budget.close();
});

async function repeatedRun(env: Record<string, string | undefined>) {
  let now = 0, calls = 0;
  const at: number[] = [];
  const result = await runAgent({ objective: "Inspect", env, window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; },
    createTools: () => ({ definitions: TOOL_DEFINITIONS, state: {}, dispatch: async () => ({ ok: true, data: {} }) }),
    fetch: async () => {
      at.push(now);
      const tool = ++calls < 11;
      return new Response(JSON.stringify(env.AI_PROVIDER === "gemini"
        ? { candidates: [{ content: { role: "model", parts: tool ? [{ functionCall: { name: "get_merchant_state", args: {}, id: `call-${calls}` } }] : [{ text: "No action" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 1 } }
        : { choices: [{ message: tool ? { content: null, tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "get_merchant_state", arguments: "{}" } }] } : { content: "No action" } }], usage: { total_tokens: 1 } }));
    },
  });
  return { result, at };
}

it("defaults selected Gemini to five RPM and uses the opt-in twelve RPM while Groq ignores Gemini settings", async () => {
  const defaults = await repeatedRun(gemini);
  expect(defaults.result.reason).toBe("NO_PROPOSAL");
  expect(defaults.at).toEqual([0, 0, 0, 0, 0, 60000, 60000, 60000, 60000, 60000, 120000]);
  const configured = await repeatedRun({ ...gemini, GEMINI_AGENT_TPM: "100000", GEMINI_AGENT_RPM: "12" });
  expect(configured.result.reason).toBe("NO_PROPOSAL");
  expect(configured.at).toEqual(Array(11).fill(0));
  const groqRun = await repeatedRun({ ...groq, GEMINI_AGENT_TPM: "invalid-private-value", GEMINI_AGENT_RPM: "invalid-private-value" });
  expect(groqRun.result.reason).toBe("NO_PROPOSAL");
  expect(groqRun.at).toEqual(Array(11).fill(0));
});

it.each([
  ["GEMINI_AGENT_TPM", "0"], ["GEMINI_AGENT_TPM", "250001"], ["GEMINI_AGENT_TPM", "1.5"], ["GEMINI_AGENT_TPM", "1e5"], ["GEMINI_AGENT_TPM", ""],
  ["GEMINI_AGENT_RPM", "0"], ["GEMINI_AGENT_RPM", "16"], ["GEMINI_AGENT_RPM", "1.5"], ["GEMINI_AGENT_RPM", ""], ["GEMINI_AGENT_RPM", "invalid-private-value"],
])("rejects invalid selected Gemini %s configuration safely before HTTP", async (key, value) => {
  const fetcher = vi.fn(async () => new Response("{}"));
  const result = await runAgent({ objective: "Inspect", env: { ...gemini, [key]: value }, fetch: fetcher, window: createTokenWindow() });
  expect(result.reason).toBe("CONFIGURATION");
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("invalid-private-value");
});

it("applies the selected profile before fresh-classifier timers and counts its transient retry once per HTTP attempt", async () => {
  let now = 0, classifications = 0;
  const at: number[] = [];
  const result = await runAgent({ objective: "Inspect", env: { ...gemini, GEMINI_AGENT_TPM: "100000", GEMINI_AGENT_RPM: "1" }, window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; },
    fetch: async (_url, init) => {
      at.push(now);
      const request = JSON.parse(init!.body as string);
      if (!request.generationConfig.responseFormat) return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "classify_feedback", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 1 } }));
      expect(JSON.parse(request.contents[0].parts[0].text)).toEqual(feedbackCorpus.slice(0, 20).map(toModelInput));
      return new Response("{}", { status: ++classifications === 1 ? 503 : 429 });
    },
  });
  expect(result).toMatchObject({ reason: "QUOTA", counters: { modelTurns: 1, httpRequests: 3 } });
  expect(result.requests.map((request) => request.kind)).toEqual(["model", "classification", "classification"]);
  expect(at).toEqual([0, 60000, 120000]);
});

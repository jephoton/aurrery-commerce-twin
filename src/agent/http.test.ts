import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "./run";
import { acquireAgentLease, createTokenWindow } from "./limits";
import { createAgentModel } from "./model";
import { emptyMetrics } from "@/signals/transport";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
function response(message: unknown, usage: unknown = { total_tokens: 150 }, finish_reason = "stop") {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason }], ...(usage ? { usage } : {}) }));
}
const call = (id: string, name = "get_merchant_state") => ({ role: "assistant", content: null, reasoning: "PRIVATE_REASONING", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] });
const base = () => ({ objective: "Investigate retention", env, window: createTokenWindow() });
afterEach(() => vi.useRealTimers());

it("waits outside the attempt timeout, then makes one successful request", async () => {
  vi.useFakeTimers();
  const window = createTokenWindow();
  window.entries.push({ at: Date.now(), tokens: 8000 });
  const fetcher = vi.fn(async () => response({ content: "No recommendation" }));
  const promise = runAgent({ ...base(), window, fetch: fetcher, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  await vi.advanceTimersByTimeAsync(59999);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(await promise).toMatchObject({ reason: "NO_PROPOSAL", counters: { httpRequests: 1, reportedTokens: 150 } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("includes cold classification requests in run pacing and accounting", async () => {
  let now = 0;
  const events: unknown[] = [];
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (body.response_format) {
      const inputs = JSON.parse(body.messages[1].content);
      return response({ content: JSON.stringify({ items: inputs.map((m: { id: string }) => ({ id: m.id, intent: "cancel", reason: "price", confidence: .9 })) }) });
    }
    return fetcher.mock.calls.length === 1 ? response(call("classify", "classify_feedback")) : response({ content: "Evidence inspected" });
  });
  const result = await runAgent({ ...base(), env: { ...env, GROQ_MODEL: "cold-test-only-model" }, now: () => now, sleep: async (ms) => { now += ms; }, fetch: fetcher, emit: (event) => events.push(event) });
  expect(result).toMatchObject({ reason: "NO_PROPOSAL", counters: { httpRequests: 12, reportedTokens: 1800, modelTurns: 2 } });
  expect(events.filter((e) => (e as { type: string }).type === "classification")).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("30 seconds") }));
  const cached = await runAgent({ ...base(), env: { ...env, GROQ_MODEL: "cold-test-only-model" }, now: () => now, sleep: async (ms) => { now += ms; }, fetch: async (_input, init) => {
    expect(JSON.parse(init!.body as string)).not.toHaveProperty("response_format");
    return response(call("cache", "classify_feedback"));
  } });
  expect(cached.counters.httpRequests).toBeLessThanOrEqual(2); // repeated opaque ID stops the protocol
});
it("charges each unknown-usage retry and terminates a received 429 without retry", async () => {
  let now = 0;
  const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? new Response("{}", { status: 503 }) : new Response("RAW_SECRET", { status: 429 }));
  const result = await runAgent({ ...base(), fetch: fetcher, now: () => now, sleep: async (ms) => { now += ms; } });
  expect(result).toMatchObject({ reason: "QUOTA", counters: { httpRequests: 2, reportedTokens: 0 } });
  expect(result.counters.accountedTokens).toBeGreaterThan(3000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain("RAW_SECRET");
});
it("cancels both fetch and stalled body reads without further outbound attempts", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const fetcher = vi.fn(async () => {
    const body = new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); }, cancel() { bodyCancelled = true; } });
    return new Response(body);
  });
  const result = await runAgent({ ...base(), fetch: fetcher, signal: controller.signal });
  expect(result.reason).toBe("CANCELLED");
  expect(bodyCancelled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("stops tools when reported usage exceeds the total run limit", async () => {
  const dispatch = vi.fn();
  const result = await runAgent({ ...base(), fetch: async () => response(call("a"), { total_tokens: 33000 }), createTools: () => ({ state: {}, definitions: [], dispatch }) });
  expect(result.reason).toBe("TOKEN_LIMIT");
  expect(dispatch).not.toHaveBeenCalled();
});
it("rejects truncated final content as an incomplete protocol", async () => {
  const result = await createAgentModel({ env, fetch: async () => response({ content: "Partial recommendation" }, undefined, "length") }).respond([], []);
  expect(result.error?.category).toBe("envelope");
});
it("returns busy before streaming and releases an explicitly reserved API lease", async () => {
  const lease = acquireAgentLease();
  expect((await runAgent({ ...base() })).reason).toBe("BUSY");
  const result = await runAgent({ ...base(), lease, model: { respond: async () => ({ message: { role: "assistant", content: "No proposal" }, metrics: emptyMetrics() }) } });
  expect(result.reason).toBe("NO_PROPOSAL");
  expect(lease.active).toBe(false);
});
it("rejects reuse of a reserved lease while its first runner owns it", async () => {
  const lease = acquireAgentLease();
  let release!: () => void;
  const first = runAgent({ ...base(), lease, model: { respond: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { message: { role: "assistant", content: "No proposal" }, metrics: emptyMetrics() }; } } });
  const second = await runAgent({ ...base(), lease, model: { respond: vi.fn() } });
  expect(second.reason).toBe("BUSY");
  expect(lease.active).toBe(true);
  release(); await first;
});

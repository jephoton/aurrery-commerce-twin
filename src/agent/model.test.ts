import { expect, it, vi } from "vitest";
import { createAgentModel } from "./model";
import { TOOL_DEFINITIONS } from "./tools";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
const envelope = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
it("uses normal Groq tool calling and retains only public content, opaque IDs, calls and usage", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => envelope({ role: "assistant", content: null, reasoning: "PRIVATE", reasoning_content: "PRIVATE", tool_calls: [{ id: "opaque:/call==", type: "function", function: { name: "get_merchant_state", arguments: "{}" }, private: "PRIVATE" }] }));
  const model = createAgentModel({ env, fetch: fetcher });
  const result = await model.respond([{ role: "user", content: "Investigate" }], TOOL_DEFINITIONS);
  expect(result.message).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "opaque:/call==", type: "function", function: { name: "get_merchant_state", arguments: "{}" } }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.metrics.usage.totalTokens).toBe(120);
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body).toMatchObject({ parallel_tool_calls: false, max_completion_tokens: 1024, reasoning_effort: "low" });
  expect(body).not.toHaveProperty("response_format");
  expect(body.tools[0].function).not.toHaveProperty("strict");
});
it.each([
  { content: null, tool_calls: [{ id: "same", type: "function", function: { name: "x", arguments: "{}" } }, { id: "same", type: "function", function: { name: "x", arguments: "{}" } }] },
  { content: null, tool_calls: [{ id: "", type: "function", function: { name: "x", arguments: "{}" } }] },
  { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: {} } }] },
  { content: null },
])("rejects invalid call envelopes safely: %j", async (message) => {
  const model = createAgentModel({ env, fetch: async () => envelope(message) });
  expect(await model.respond([], TOOL_DEFINITIONS)).toMatchObject({ error: { category: "envelope" } });
});
it("returns safe quota evidence without retry or raw errors", async () => {
  const fetcher = vi.fn(async () => new Response('{"error":"secret raw request"}', { status: 429 }));
  const result = await createAgentModel({ env, fetch: fetcher }).respond([], []);
  expect(result.error).toMatchObject({ category: "quota", status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("secret");
});
it.each([{ ...env, AI_PROVIDER: "gemini" }, { ...env, GROQ_MODEL: "" }, { ...env, GROQ_API_KEY: "" }])("requires explicit selected provider, model and key", async (badEnv) => {
  const fetcher = vi.fn();
  expect(() => createAgentModel({ env: badEnv, fetch: fetcher })).toThrow("configuration");
  expect(fetcher).not.toHaveBeenCalled();
});

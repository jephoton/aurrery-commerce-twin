import { describe, expect, it } from "vitest";
import { toolSmoke } from "./tool-smoke";
import type { ProviderConfig, ProviderName } from "./providers";

const state = { merchant: "Evaluation Roasters", listPrice: 31.73 };
const call = (provider: ProviderName, changes: Record<string, unknown> = {}) => provider === "gemini"
  ? { candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "opaque-signature", functionCall: { id: "call-1", name: "get_merchant_state", args: {}, ...changes } }] } }] }
  : { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "get_merchant_state", arguments: "{}", ...changes } }] } }] };
const final = (provider: ProviderName, value: unknown = state) => provider === "gemini"
  ? { candidates: [{ content: { role: "model", parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] } }] }
  : { choices: [{ message: { role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) } }] };
function fake(provider: ProviderName, responses: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const config: ProviderConfig = { provider, env: { GEMINI_API_KEY: "secret-test-key", GROQ_API_KEY: "secret-test-key" }, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const payload = responses[bodies.length - 1];
    return payload instanceof Response ? payload : new Response(JSON.stringify({ ...payload as object, usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }));
  } };
  return { config, bodies };
}
describe.each(["gemini", "groq"] as const)("%s read-only tool smoke", (provider) => {
  it("requires the call, returns unseen state, consumes it and sums both requests", async () => {
    const { config, bodies } = fake(provider, [call(provider), final(provider)]);
    const result = await toolSmoke(config);
    expect(result.passed).toBe(true);
    expect(result.observedState).toEqual(state);
    expect(result.metrics.usage.totalTokens).toBe(10);
    expect(result.metrics.attempts).toHaveLength(2);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0])).not.toContain(state.merchant);
    expect(JSON.stringify(bodies[0])).not.toContain(String(state.listPrice));
    expect(JSON.stringify(bodies)).not.toContain("response_format");
    expect(JSON.stringify(bodies)).not.toContain("responseFormat");
    const parameters = { type: "object", properties: {}, required: [], additionalProperties: false };
    for (const body of bodies) {
      expect(body.tools).toEqual(provider === "gemini"
        ? [{ functionDeclarations: [{ name: "get_merchant_state", description: "Read synthetic merchant state for this evaluation.", parametersJsonSchema: parameters }] }]
        : [{ type: "function", function: { name: "get_merchant_state", description: "Read synthetic merchant state for this evaluation.", parameters } }]);
    }
    if (provider === "gemini") {
      expect(bodies[0].toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_merchant_state"] } });
      const contents = bodies[1].contents as unknown[];
      expect(contents[1]).toEqual((call(provider) as { candidates: { content: unknown }[] }).candidates[0].content);
      expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "call-1", name: "get_merchant_state", response: state } }] });
      expect(bodies[1].toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    } else {
      expect(bodies[0].tool_choice).toEqual({ type: "function", function: { name: "get_merchant_state" } });
      expect((bodies[1].messages as unknown[])[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: JSON.stringify(state) });
      expect(bodies[1].tool_choice).toBe("none");
    }
  });
  it.each(["name", "args", "missing", "multiple"])("rejects %s mistakes before a second request", async (kind) => {
    const changes = kind === "name" ? { name: "execute_payment" } : kind === "args" ? provider === "gemini" ? { args: { price: 1 } } : { arguments: '{"price":1}' } : {};
    let payload: unknown = call(provider, changes);
    if (kind === "missing") payload = final(provider, "I refuse");
    if (kind === "multiple") {
      if (provider === "gemini") { const p = payload as { candidates: { content: { parts: unknown[] } }[] }; p.candidates[0].content.parts.push(...p.candidates[0].content.parts); }
      else { const p = payload as { choices: { message: { tool_calls: unknown[] } }[] }; p.choices[0].message.tool_calls.push(...p.choices[0].message.tool_calls); }
    }
    const { config, bodies } = fake(provider, [payload]);
    const result = await toolSmoke(config);
    expect(result).toMatchObject({ passed: false, reason: "invalid_tool_call" });
    expect(bodies).toHaveLength(1);
  });
  it.each([{ merchant: "Invented", listPrice: 31.73 }, { merchant: state.merchant }, "not JSON"])("rejects incorrect or absent state %j", async (value) => {
    const { config } = fake(provider, [call(provider), final(provider, value)]);
    expect(await toolSmoke(config)).toMatchObject({ passed: false, reason: "invalid_tool_result" });
  });
  it("rejects additional final tools", async () => {
    const { config } = fake(provider, [call(provider), call(provider)]);
    expect(await toolSmoke(config)).toMatchObject({ passed: false, reason: "invalid_tool_result" });
  });
  it("retains safe quota failure and stops immediately", async () => {
    const { config, bodies } = fake(provider, [new Response("secret-test-key request headers", { status: 429, headers: { "x-ratelimit-remaining-requests": "0" } })]);
    const result = await toolSmoke(config);
    expect(result).toMatchObject({ passed: false, reason: "provider_error", error: { category: "quota", quota: { "x-ratelimit-remaining-requests": "0" } } });
    expect(result.metrics.attempts).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
});
it("completes Gemini smoke when the endpoint rejects JSON Schema in parameters", async () => {
  const bodies: Record<string, unknown>[] = [];
  const config: ProviderConfig = { provider: "gemini", env: { GEMINI_API_KEY: "secret-test-key" }, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const declaration = body.tools[0].functionDeclarations[0];
    if (declaration.parameters?.additionalProperties !== undefined) {
      return new Response(JSON.stringify({ error: { message: "Unknown name additionalProperties at parameters" } }), { status: 400 });
    }
    return new Response(JSON.stringify(bodies.length === 1 ? call("gemini") : final("gemini")));
  } };
  const result = await toolSmoke(config);
  expect(result.passed).toBe(true);
  expect(result.observedState).toEqual(state);
  expect(result.metrics.attempts.map((attempt) => attempt.status)).toEqual([200, 200]);
  expect(result.metrics.retries).toBe(0);
  expect(bodies).toHaveLength(2);
});
it("requires a nonempty Groq call ID", async () => {
  const payload = { choices: [{ message: { role: "assistant", tool_calls: [{ type: "function", function: { name: "get_merchant_state", arguments: "{}" } }] } }] };
  const { config, bodies } = fake("groq", [payload]);
  expect(await toolSmoke(config)).toMatchObject({ passed: false, reason: "invalid_tool_call" });
  expect(bodies).toHaveLength(1);
});

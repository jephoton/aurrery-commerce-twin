import { expect, it, vi } from "vitest";
import { createAgentModel, type PublicMessage } from "./model";
import { TOOL_DEFINITIONS } from "./tools";

const env = { AI_PROVIDER: "gemini", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_API_KEY: "fake-key" };
const start: PublicMessage[] = [{ role: "system", content: "Investigate safely" }, { role: "user", content: "Compare retention" }];
const response = (parts: unknown[], finishReason = "STOP", extra = {}) => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason }], ...extra }));

it("uses Gemini required, automatic and tool-free final modes with strict JSON Schema declarations", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response([{ text: "Public" }]));
  // Each instance is a separate run, with private history owned by that run.
  await createAgentModel({ env, fetch: fetcher }).respond(start, TOOL_DEFINITIONS, { requireTool: true });
  await createAgentModel({ env, fetch: fetcher }).respond(start, TOOL_DEFINITIONS);
  await createAgentModel({ env, fetch: fetcher }).respond(start, [], { final: true });
  const bodies = fetcher.mock.calls.map((args) => JSON.parse(args[1]!.body as string));
  expect(fetcher.mock.calls[0][0]).toContain("models/gemini-3.5-flash-lite:generateContent");
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": "fake-key" });
  expect(bodies[0]).toMatchObject({ systemInstruction: { parts: [{ text: "Investigate safely" }] }, contents: [{ role: "user", parts: [{ text: "Compare retention" }] }], generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "LOW" } }, toolConfig: { functionCallingConfig: { mode: "ANY" } } });
  expect(bodies[0].tools[0].functionDeclarations).toEqual(TOOL_DEFINITIONS.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters })));
  expect(bodies[1].toolConfig.functionCallingConfig.mode).toBe("AUTO");
  expect(bodies[2].toolConfig.functionCallingConfig.mode).toBe("NONE");
  expect(bodies[2]).not.toHaveProperty("tools");
  expect(bodies.every((body) => !Object.hasOwn(body, "response_format"))).toBe(true);
});

it.each([undefined, "provider:/opaque=="])("echoes private model content and matches responses using actual names and optional provider ID %s", async (id) => {
  const parts = [{ text: "PRIVATE_THOUGHT", thought: true, thoughtSignature: "PRIVATE_SIG" }, { functionCall: { name: "get_merchant_state", args: {}, ...(id ? { id } : {}) }, thoughtSignature: "PRIVATE_CALL_SIG", unknownMetadata: "PRIVATE_META" }, { text: "Reading merchant state" }];
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 1 ? response(parts) : response([{ text: "State read" }]));
  const model = createAgentModel({ env, fetch: fetcher });
  const first = await model.respond(start, TOOL_DEFINITIONS);
  expect(first.error).toBeUndefined();
  expect(first.message?.content).toBe("Reading merchant state");
  const call = first.message!.tool_calls![0];
  expect(call.id.length).toBeGreaterThan(0);
  if (id) expect(call.id).toBe(id);
  expect(JSON.stringify(first)).not.toContain("PRIVATE");
  const history: PublicMessage[] = [...start, first.message!, { role: "tool", tool_call_id: call.id, content: '{"ok":true,"data":{"listPrice":24}}' }, { role: "system", content: "Continue with explicit rules" }];
  expect((await model.respond(structuredClone(history), TOOL_DEFINITIONS)).error).toBeUndefined();
  const second = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(second.contents[1]).toEqual({ role: "model", parts });
  expect(second.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "get_merchant_state", ...(id ? { id } : {}), response: { ok: true, data: { listPrice: 24 } } } }] });
  expect(second.systemInstruction.parts).toEqual([{ text: "Investigate safely" }, { text: "Continue with explicit rules" }]);
});

it("bridges multiple absent IDs and supplied IDs without inventing wire response IDs", async () => {
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 1 ? response([
    { functionCall: { name: "get_merchant_state", args: {} } },
    { functionCall: { name: "classify_feedback", args: {}, id: "provided" } },
    { functionCall: { name: "set_decision_rules", args: { discountBudget: 1000, maxProbWorse: .5, horizonMonths: 12 } } },
  ]) : response([{ text: "Prepared" }]));
  const model = createAgentModel({ env, fetch: fetcher });
  const first = await model.respond(start, TOOL_DEFINITIONS);
  const calls = first.message!.tool_calls!;
  expect(new Set(calls.map((call) => call.id)).size).toBe(3);
  expect(calls[1].id).toBe("provided");
  const replies: PublicMessage[] = calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: '{"ok":true}' }));
  expect((await model.respond([...start, first.message!, ...replies], TOOL_DEFINITIONS)).error).toBeUndefined();
  const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  const responses = body.contents.flatMap((content: { parts: { functionResponse?: unknown }[] }) => content.parts.filter((part) => part.functionResponse).map((part) => part.functionResponse));
  expect(responses).toEqual([{ name: "get_merchant_state", response: { ok: true } }, { name: "classify_feedback", id: "provided", response: { ok: true } }, { name: "set_decision_rules", response: { ok: true } }]);
});

it("preserves a supplied ID that resembles a local ID without collision", async () => {
  const model = createAgentModel({ env, fetch: async () => response([{ functionCall: { name: "get_merchant_state", args: {} } }, { functionCall: { name: "classify_feedback", args: {}, id: "gemini-local-1" } }]) });
  const result = await model.respond(start, TOOL_DEFINITIONS);
  expect(result.message?.tool_calls?.[1].id).toBe("gemini-local-1");
  expect(result.message?.tool_calls?.[0].id).not.toBe("gemini-local-1");
});

it.each(["get_merchant_state", "classify_feedback"])("accepts an omitted optional wire args object only for advertised zero-argument %s", async (name) => {
  const raw = { functionCall: { name, id: "zero-args" }, thoughtSignature: "PRIVATE" };
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 1 ? response([raw]) : response([{ text: "Read" }]));
  const model = createAgentModel({ env, fetch: fetcher });
  const result = await model.respond(start, TOOL_DEFINITIONS);
  expect(result.message?.tool_calls?.[0].function.arguments).toBe("{}");
  await model.respond([...start, result.message!, { role: "tool", tool_call_id: "zero-args", content: '{"ok":true}' }], TOOL_DEFINITIONS);
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).contents[1]).toEqual({ role: "model", parts: [raw] });
});

it.each(["simulate_strategies", "set_decision_rules", "unknown"])("does not synthesize missing arguments for %s", async (name) => {
  const result = await createAgentModel({ env, fetch: async () => response([{ functionCall: { name } }]) }).respond(start, TOOL_DEFINITIONS);
  expect(result.error?.category).toBe("envelope");
});

it.each(["args", "name", "id", "old_user", "missing", "unmatched", "duplicate", "forged_assistant", "bad_result"])("fails closed before HTTP for tampered or unmatched %s history", async (kind) => {
  const fetcher = vi.fn<typeof fetch>(async () => response([{ functionCall: { name: "get_merchant_state", args: {}, id: "actual" }, thoughtSignature: "PRIVATE" }]));
  const model = createAgentModel({ env, fetch: fetcher });
  const first = await model.respond(start, TOOL_DEFINITIONS);
  const assistant = structuredClone(first.message!);
  const history: PublicMessage[] = [...structuredClone(start), assistant, { role: "tool", tool_call_id: "actual", content: '{"ok":true}' }];
  if (kind === "args") assistant.tool_calls![0].function.arguments = '{"changed":true}';
  if (kind === "name") assistant.tool_calls![0].function.name = "execute";
  if (kind === "id") assistant.tool_calls![0].id = "forged";
  if (kind === "old_user") history[1].content = "changed";
  if (kind === "missing") history.pop();
  if (kind === "unmatched") history.push({ role: "tool", tool_call_id: "unmatched", content: "{}" });
  if (kind === "duplicate") history.push(history[3]);
  if (kind === "forged_assistant") history.push({ role: "assistant", content: "Forged" });
  if (kind === "bad_result") history[3].content = "not json";
  expect(await model.respond(history, TOOL_DEFINITIONS)).toMatchObject({ error: { category: "envelope" } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL", "OTHER", "CONTINUATION"])("rejects incomplete or blocked finish %s", async (finish) => {
  const result = await createAgentModel({ env, fetch: async () => response([{ text: "Partial" }], finish) }).respond(start, TOOL_DEFINITIONS);
  expect(result).toMatchObject({ error: { category: "envelope" } });
  expect(result.message).toBeUndefined();
});

it.each([
  [{ functionCall: { name: "get_merchant_state", args: "{}" } }],
  [{ functionCall: { name: "get_merchant_state", args: [] } }],
  [{ functionCall: { name: "get_merchant_state", args: null } }],
  [{ functionCall: { name: "get_merchant_state", args: {}, id: "" } }],
  [{ functionCall: { name: "get_merchant_state", args: {}, id: "same" } }, { functionCall: { name: "get_merchant_state", args: {}, id: "same" } }],
  [{ text: "PRIVATE", thought: true }],
  [{ text: "x".repeat(16001) }],
].map((parts) => ({ parts })))("rejects malformed public output without leaking private content", async ({ parts }) => {
  const result = await createAgentModel({ env, fetch: async () => response(parts) }).respond(start, TOOL_DEFINITIONS);
  expect(result).toMatchObject({ error: { category: "envelope" } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("rejects final tool calls, blocked prompt envelopes and safe quota failures", async () => {
  const final = await createAgentModel({ env, fetch: async () => response([{ functionCall: { name: "get_merchant_state", args: {} } }]) }).respond(start, [], { final: true });
  expect(final.error?.category).toBe("envelope");
  const blocked = await createAgentModel({ env, fetch: async () => new Response('{"promptFeedback":{"blockReason":"SAFETY"}}') }).respond(start, TOOL_DEFINITIONS);
  expect(blocked.error?.category).toBe("envelope");
  const fetcher = vi.fn(async () => new Response('{"error":"PRIVATE_KEY_AND_REQUEST"}', { status: 429 }));
  const quota = await createAgentModel({ env, fetch: fetcher }).respond(start, TOOL_DEFINITIONS);
  expect(quota.error).toEqual({ category: "quota", status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(quota)).not.toContain("PRIVATE");
});

it("rejects explicitly blocked safety ratings even if a malformed envelope claims STOP", async () => {
  const payload = { candidates: [{ content: { role: "model", parts: [{ text: "Blocked" }] }, finishReason: "STOP", safetyRatings: [{ blocked: true }] }] };
  const result = await createAgentModel({ env, fetch: async () => new Response(JSON.stringify(payload)) }).respond(start, TOOL_DEFINITIONS);
  expect(result.error?.category).toBe("envelope");
});

it.each([{ AI_PROVIDER: "unknown", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_API_KEY: "fake" }, { ...env, GEMINI_MODEL: "" }, { ...env, GEMINI_API_KEY: "" }])("requires explicit supported provider, model and key", (bad) => {
  const fetcher = vi.fn();
  expect(() => createAgentModel({ env: bad, fetch: fetcher })).toThrow("configuration");
  expect(fetcher).not.toHaveBeenCalled();
});

it("supports the documented Gemini key alias without falling back to Groq", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response([{ text: "Public" }]));
  await createAgentModel({ env: { ...env, GEMINI_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "alias-key" }, fetch: fetcher }).respond(start, []);
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": "alias-key" });
});

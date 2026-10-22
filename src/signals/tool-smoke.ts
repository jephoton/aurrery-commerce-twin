import "server-only";
import { z } from "zod";
import { createTransport, emptyMetrics, type ProviderConfig, type ProviderMetrics, type SafeProviderError } from "./providers";

export interface ToolSmokeResult {
  passed: boolean;
  skipped?: boolean;
  reason?: "invalid_tool_call" | "invalid_tool_result" | "provider_error" | "classification_stopped";
  observedState?: { merchant: string; listPrice: number };
  metrics: ProviderMetrics;
  error?: SafeProviderError;
}
export function sumMetrics(...metrics: ProviderMetrics[]): ProviderMetrics {
  const total = emptyMetrics();
  for (const metric of metrics) {
    total.latencyMs += metric.latencyMs;
    total.retries += metric.retries;
    total.attempts.push(...metric.attempts);
    for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) total.usage[field] += metric.usage[field];
  }
  return total;
}
const name = "get_merchant_state";
const instruction = 'Call get_merchant_state exactly once with empty arguments. Then return only a JSON object with merchant and listPrice copied exactly from the tool result. Do not guess the state.';
const declaration = { name, description: "Read synthetic merchant state for this evaluation.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } };
const state = { merchant: "Evaluation Roasters", listPrice: 31.73 };
const stateSchema = z.strictObject({ merchant: z.literal(state.merchant), listPrice: z.literal(state.listPrice) });
const geminiContent = z.object({ role: z.literal("model"), parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional(), functionCall: z.unknown().optional() }).passthrough()) }).passthrough();
const geminiEnvelope = z.object({ candidates: z.array(z.object({ content: geminiContent, finishReason: z.string().optional() })).length(1) });
const groqMessage = z.object({ role: z.literal("assistant"), content: z.string().nullable().optional(), refusal: z.unknown().optional(), tool_calls: z.array(z.unknown()).nullable().optional() }).passthrough();
const groqEnvelope = z.object({ choices: z.array(z.object({ message: groqMessage })).length(1) });
const emptyArgs = z.strictObject({});

/** A separate two-request tool protocol probe, with no payment or execution tools. */
export async function toolSmoke(config: ProviderConfig): Promise<ToolSmokeResult> {
  const transport = createTransport(config);
  const gemini = config.provider === "gemini";
  const contents = [{ role: "user", parts: [{ text: instruction }] }];
  const messages = [{ role: "user", content: instruction }];
  const base = gemini
    ? { tools: [{ functionDeclarations: [declaration] }], generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "LOW" } } }
    : { tools: [{ type: "function", function: declaration }], max_completion_tokens: 1024, reasoning_effort: "low", stream: false, parallel_tool_calls: false };
  const first = await transport.send(gemini
    ? { ...base, contents, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } } }
    : { ...base, messages, tool_choice: { type: "function", function: { name } } });
  const fail = (reason: ToolSmokeResult["reason"], metrics: ProviderMetrics, error?: SafeProviderError): ToolSmokeResult => ({ passed: false, reason, metrics, ...(error ? { error } : {}) });
  if (first.error) return fail("provider_error", first.metrics, first.error);
  let next: unknown;
  if (gemini) {
    const parsed = geminiEnvelope.safeParse(first.payload);
    if (!parsed.success) return fail("invalid_tool_call", first.metrics);
    const { content, finishReason } = parsed.data.candidates[0];
    const calls = content.parts.filter((part) => part.functionCall !== undefined);
    const call = z.object({ name: z.literal(name), args: emptyArgs, id: z.string().min(1).optional() }).safeParse(calls[0]?.functionCall);
    if (calls.length !== 1 || !call.success || (finishReason && finishReason !== "STOP")) return fail("invalid_tool_call", first.metrics);
    // Echo the entire content unchanged, including opaque thought signatures and call IDs.
    next = { ...base, contents: [...contents, content, { role: "user", parts: [{ functionResponse: { name, ...(call.data.id ? { id: call.data.id } : {}), response: state } }] }], toolConfig: { functionCallingConfig: { mode: "NONE" } } };
  } else {
    const parsed = groqEnvelope.safeParse(first.payload);
    if (!parsed.success) return fail("invalid_tool_call", first.metrics);
    const message = parsed.data.choices[0].message;
    const call = z.object({ id: z.string().trim().min(1), type: z.literal("function"), function: z.object({ name: z.literal(name), arguments: z.string() }) }).safeParse(message.tool_calls?.[0]);
    if (message.refusal || message.tool_calls?.length !== 1 || !call.success) return fail("invalid_tool_call", first.metrics);
    try { if (!emptyArgs.safeParse(JSON.parse(call.data.function.arguments)).success) return fail("invalid_tool_call", first.metrics); }
    catch { return fail("invalid_tool_call", first.metrics); }
    next = { ...base, messages: [...messages, message, { role: "tool", tool_call_id: call.data.id, content: JSON.stringify(state) }], tool_choice: "none" };
  }
  const second = await transport.send(next);
  const metrics = sumMetrics(first.metrics, second.metrics);
  if (second.error) return fail("provider_error", metrics, second.error);
  let text: string | undefined;
  if (gemini) {
    const parsed = geminiEnvelope.safeParse(second.payload);
    if (parsed.success) {
      const { content, finishReason } = parsed.data.candidates[0];
      if (content.parts.some((part) => part.functionCall !== undefined) || (finishReason && finishReason !== "STOP")) return fail("invalid_tool_result", metrics);
      text = content.parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    }
  } else {
    const parsed = groqEnvelope.safeParse(second.payload);
    if (parsed.success) {
      const message = parsed.data.choices[0].message;
      if (message.refusal || message.tool_calls?.length) return fail("invalid_tool_result", metrics);
      text = message.content ?? undefined;
    }
  }
  try {
    const observed = stateSchema.safeParse(JSON.parse(text ?? ""));
    if (observed.success) return { passed: true, observedState: observed.data, metrics };
  } catch { /* Invalid JSON is a visible smoke failure, never raw provider output. */ }
  return fail("invalid_tool_result", metrics);
}

import "server-only";
import { z } from "zod";
import { emptyMetrics, type createTransport } from "@/signals/transport";
import { publicAssistant, type AgentModel, type AssistantMessage, type PublicMessage, type ToolCall } from "./model";

const providerId = z.string().min(1).max(256).refine((id) => !/[\u0000-\u001f\u007f]/.test(id));
const functionCall = z.object({ name: z.string().min(1).max(120), args: z.record(z.string(), z.unknown()).optional(), id: providerId.optional() });
const part = z.object({ text: z.string().optional(), thought: z.boolean().optional(), functionCall: z.unknown().optional() }).passthrough();
const ratings = z.array(z.object({ blocked: z.boolean().optional() })).max(32).optional();
const envelope = z.object({
  candidates: z.array(z.object({ content: z.object({ role: z.literal("model"), parts: z.array(part).min(1).max(128) }).passthrough(), finishReason: z.literal("STOP"), safetyRatings: ratings })).length(1),
  promptFeedback: z.object({ blockReason: z.string().optional(), safetyRatings: ratings }).optional(),
});
type Content = { role: "user" | "model"; parts: Record<string, unknown>[] };
interface PrivateTurn { content: Content; calls: Map<string, { name: string; id?: string }> }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One adapter per run. Raw provider content, thoughts and signatures never leave this closure. */
export function createGeminiAgentModel(transport: ReturnType<typeof createTransport>, beforeSend?: (body: unknown) => Promise<void>): AgentModel {
  let prefix: PublicMessage[] = [];
  const turns = new Map<number, PrivateTurn>();
  const usedIds = new Set<string>();
  let serial = 0;
  function history(messages: PublicMessage[]) {
    if (messages.length < prefix.length || !same(messages.slice(0, prefix.length), prefix)) return;
    const contents: Content[] = [], instructions: { text: string }[] = [];
    let pending = new Map<string, { name: string; id?: string }>();
    for (const [index, message] of messages.entries()) {
      if (message.role === "system") { instructions.push({ text: message.content }); continue; }
      if (message.role === "assistant") {
        const turn = turns.get(index);
        if (!turn || pending.size) return;
        contents.push(structuredClone(turn.content));
        pending = new Map(turn.calls);
      } else if (message.role === "tool") {
        const call = pending.get(message.tool_call_id);
        if (!call) return;
        let response: unknown;
        try { response = JSON.parse(message.content); } catch { return; }
        if (!record(response)) return;
        const reply = { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } };
        // Parallel calls share one user function-response turn; each response keeps its matched name/ID.
        const last = contents.at(-1);
        if (last?.role === "user" && last.parts.every((part) => Object.hasOwn(part, "functionResponse"))) last.parts.push(reply);
        else contents.push({ role: "user", parts: [reply] });
        pending.delete(message.tool_call_id);
      } else {
        if (pending.size) return;
        contents.push({ role: "user", parts: [{ text: message.content }] });
      }
    }
    if (pending.size) return;
    return { contents, ...(instructions.length ? { systemInstruction: { parts: instructions } } : {}) };
  }
  return { async respond(messages, tools, options) {
    const converted = history(messages);
    const invalid = { metrics: emptyMetrics(), error: { category: "envelope" as const } };
    if (!converted) return invalid;
    const body = {
      ...converted,
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "LOW" } },
      toolConfig: { functionCallingConfig: { mode: options?.final ? "NONE" : options?.requireTool ? "ANY" : "AUTO" } },
      ...(!options?.final ? { tools: [{ functionDeclarations: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters })) }] } : {}),
    };
    await beforeSend?.(body);
    const result = await transport.send(body);
    if (result.error) return { metrics: result.metrics, error: { category: result.error.category, ...(result.error.status ? { status: result.error.status } : {}) } };
    const fail = { metrics: result.metrics, error: invalid.error };
    const parsed = envelope.safeParse(result.payload);
    if (!parsed.success || parsed.data.promptFeedback?.blockReason || parsed.data.promptFeedback?.safetyRatings?.some((rating) => rating.blocked) || parsed.data.candidates[0].safetyRatings?.some((rating) => rating.blocked)) return fail;
    const content = parsed.data.candidates[0].content;
    const calls: ToolCall[] = [], mapping: PrivateTurn["calls"] = new Map();
    const supplied = new Set<string>();
    const parsedCalls: (z.infer<typeof functionCall> & { args: Record<string, unknown> })[] = [];
    for (const piece of content.parts) {
      if (piece.functionCall === undefined) continue;
      if (piece.thought || piece.text !== undefined || options?.final) return fail;
      const parsedCall = functionCall.safeParse(piece.functionCall);
      if (!parsedCall.success) return fail;
      const call = parsedCall.data;
      if (call.args === undefined) {
        // REST permits omitted args. Only an advertised zero-argument declaration can mean {}.
        const parameters = tools.find(({ function: fn }) => fn.name === call.name)?.function.parameters;
        if (!parameters || parameters.type !== "object" || !record(parameters.properties) || Object.keys(parameters.properties).length || (Array.isArray(parameters.required) && parameters.required.length)) return fail;
      }
      parsedCalls.push({ ...call, args: call.args ?? {} });
      if (call.id && (supplied.has(call.id) || usedIds.has(call.id))) return fail;
      if (call.id) supplied.add(call.id);
    }
    for (const call of parsedCalls) {
      let id = call.id;
      if (!id) { do { id = `gemini-local-${++serial}`; } while (usedIds.has(id) || supplied.has(id)); }
      calls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } });
      mapping.set(id, { name: call.name, ...(call.id ? { id: call.id } : {}) });
    }
    const message = publicAssistant({ content: content.parts.filter((piece) => !piece.thought).map((piece) => piece.text ?? "").join("") || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!message) return fail;
    for (const call of calls) usedIds.add(call.id);
    turns.set(messages.length, { content: structuredClone(content), calls: mapping });
    prefix = structuredClone([...messages, message]);
    return { message: message as AssistantMessage, metrics: result.metrics };
  } };
}

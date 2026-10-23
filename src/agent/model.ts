import "server-only";
import { z } from "zod";
import { createTransport, type ProviderConfig, type ProviderMetrics, type SafeProviderError } from "@/signals/transport";
import type { TOOL_DEFINITIONS } from "./tools";

const callSchema = z.object({ id: z.string().min(1).max(256).refine((id) => !/[\u0000-\u001f\u007f]/.test(id)), type: z.literal("function"), function: z.object({ name: z.string().min(1).max(120), arguments: z.string().max(32000) }) });
const messageSchema = z.object({ role: z.literal("assistant").optional(), content: z.string().max(16000).nullable().optional(), tool_calls: z.array(callSchema).max(32).optional() });
export type ToolCall = z.infer<typeof callSchema>;
export interface AssistantMessage { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
export type PublicMessage = { role: "system" | "user"; content: string } | AssistantMessage | { role: "tool"; tool_call_id: string; content: string };
export interface ModelResult { message?: AssistantMessage; metrics: ProviderMetrics; error?: Pick<SafeProviderError, "category" | "status"> }
export interface AgentModel { respond(messages: PublicMessage[], tools: typeof TOOL_DEFINITIONS, options?: { final?: boolean }): Promise<ModelResult> }

/** Object projection strips every undeclared provider field, including private reasoning. */
export function publicAssistant(raw: unknown): AssistantMessage | undefined {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return;
  const { content, tool_calls } = parsed.data;
  if ((!content?.trim() && !tool_calls?.length) || (tool_calls && new Set(tool_calls.map((c) => c.id)).size !== tool_calls.length)) return;
  return { role: "assistant", content: content ?? null, ...(tool_calls?.length ? { tool_calls } : {}) };
}
export function selectedGroq(env: Record<string, string | undefined>) {
  const model = env.GROQ_MODEL?.trim();
  if (env.AI_PROVIDER !== "groq" || !model || !/^[a-zA-Z0-9_./-]{1,120}$/.test(model) || !env.GROQ_API_KEY?.trim()) throw new Error("configuration");
  return model;
}
export function createAgentModel(config: Omit<ProviderConfig, "provider"> & { beforeSend?: (body: unknown) => Promise<void> } = {}): AgentModel {
  const env = config.env ?? process.env;
  const model = selectedGroq(env);
  const transport = createTransport({ ...config, env, model, provider: "groq" });
  return { async respond(messages, tools, options) {
    const body = { messages, stream: false, max_completion_tokens: 1024, reasoning_effort: "low", ...(options?.final ? { tool_choice: "none" } : { tools, parallel_tool_calls: false }) };
    await config.beforeSend?.({ ...body, model });
    const result = await transport.send(body);
    if (result.error) return { metrics: result.metrics, error: { category: result.error.category, ...(result.error.status ? { status: result.error.status } : {}) } };
    const envelope = z.object({ choices: z.array(z.object({ message: z.unknown(), finish_reason: z.string().nullable().optional() })).length(1) }).safeParse(result.payload);
    if (envelope.success && envelope.data.choices[0].finish_reason === "length") return { metrics: result.metrics, error: { category: "envelope" } };
    const message = envelope.success ? publicAssistant(envelope.data.choices[0].message) : undefined;
    return message ? { message, metrics: result.metrics } : { metrics: result.metrics, error: { category: "envelope" } };
  } };
}

import { z } from "zod";
import type { AgentEvent } from "./contracts";
import { StrategySchema } from "@/twin/interventions";
import { METRIC_KEYS, SEGMENTS, type TwinParams } from "@/twin/types";

export const MAX_FRAME_BYTES = 512 * 1024;
export interface AgentFrame { runId: string; seq: number; event: AgentEvent }
type Done = Extract<AgentEvent, { type: "done" }> & { status: "complete" | "incomplete" | "cancelled" };
const text = z.string().max(MAX_FRAME_BYTES);
const finite = z.number().finite();
const count = finite.int().nonnegative();
const probability = finite.min(0).max(1);
const summary = z.object({ mean: finite, p10: finite, p50: finite, p90: finite });
const metrics = z.record(z.enum(METRIC_KEYS), summary);
const deltas = z.record(z.enum(METRIC_KEYS), summary.extend({ probPositive: probability }));
const band = z.object({ p10: z.array(finite).min(1).max(37), p50: z.array(finite).min(1).max(37), p90: z.array(finite).min(1).max(37) });
const strategyResult = z.object({ strategy: StrategySchema, description: text, paypalAction: text.nullable(), metrics, vsBaseline: deltas, probProfitBelowBaseline: probability, probValueBelowBaseline: probability, activeBand: band, cumulativeProfitBand: band });
const segments = z.record(z.enum(SEGMENTS), z.object({ price: count, other: count }));
const rules = z.object({ discountBudget: finite.min(0).max(100000), maxProbWorse: probability, horizonMonths: count.min(1).max(12) });
const action = z.object({ type: z.literal("subscription_price_override"), segment: z.enum(SEGMENTS), reason: z.enum(["price", "any"]), listPrice: text, newPrice: text, discountPct: finite, months: count, campaignMonths: count, targets: z.array(text).min(1).max(25) });
const proposal = z.object({ id: text, createdAt: text, objective: text.nullable(), strategy: StrategySchema, prediction: z.object({ metrics, vsBaseline: deltas, probValueBelowBaseline: probability }), action, actionHash: text, status: z.enum(["proposed", "approved", "executing", "succeeded", "partially_failed", "failed", "rejected"]), approvedAt: text.nullable(), approvedBy: text.nullable(), completedAt: text.nullable(), revertAfter: text.nullable() });
const eventSchema: z.ZodType<AgentEvent> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), message: text }),
  z.strictObject({ type: z.literal("wait"), durationMs: count, message: text }),
  z.strictObject({ type: z.literal("tool_started"), name: text }),
  z.strictObject({ type: z.literal("tool_result"), name: text, result: z.union([z.object({ ok: z.literal(true), data: z.unknown() }), z.object({ ok: z.literal(false), code: text, message: text, terminal: z.literal(true).optional(), failure: z.object({ category: text, status: count.optional() }).optional() })]) }),
  z.strictObject({ type: z.literal("classification"), summary: z.object({ provider: z.enum(["gemini", "groq"]), model: text, stopped: z.boolean(), total: count, accepted: count, unclassified: count, cacheHits: count, segments, intents: z.object({ cancel: count, considering_cancel: count, stay: count }), eligiblePilotCount: count, pilotCount: count, mappingIssueCount: count, source: z.literal("AI-classified synthetic feedback") }), hitmap: segments, provenance: z.record(z.string(), z.object({ source: z.enum(["estimated", "assumption", "observed"]), note: text, evidenceCount: count.optional() })) }),
  z.strictObject({ type: z.literal("rules"), rules }),
  z.strictObject({ type: z.literal("comparison"), comparison: z.object({ merchantId: text, options: z.object({ runs: count.min(1), horizonMonths: count.min(1).max(36), seed: finite }), baselineId: text, strategies: z.array(strategyResult).min(1).max(50) }) }),
  z.strictObject({ type: z.literal("stress"), strategyId: text, stress: z.object({ base: strategyResult, stressed: strategyResult, shifted: z.array(text).max(100), stressedParams: z.custom<TwinParams>(v => typeof v === "object" && v !== null) }) }),
  z.strictObject({ type: z.literal("draft"), strategyId: text, message: text, displayOnly: z.literal(true) }),
  z.strictObject({ type: z.literal("proposal"), proposal, rationale: text, tradeoffs: text }),
  z.strictObject({ type: z.literal("summary"), message: text }),
  z.strictObject({ type: z.literal("error"), code: text, message: text }),
  z.strictObject({ type: z.literal("done"), status: z.enum(["complete", "incomplete", "cancelled"]), reason: text.optional(), proposalId: text.optional() }),
]);
const frameSchema = z.strictObject({ runId: z.string().min(1).max(100), seq: count.min(1), event: eventSchema });
export interface StreamOptions { signal?: AbortSignal; onEvent(event: AgentEvent): void }
const streamError = () => new Error("Agent stream interrupted or invalid. Run incomplete.");
const abortError = () => new DOMException("Run cancelled.", "AbortError");

/** Browser-safe decoder: only an explicit, ordered terminal frame establishes a result. */
export async function readAgentStream(response: Response, options: StreamOptions): Promise<Done> {
  if (!response.body) throw streamError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", runId: string | undefined, seq = 0, sawError = false;
  let done: Done | undefined;
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw abortError();
    for (;;) {
      const chunk = await reader.read();
      if (options.signal?.aborted) throw abortError();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES || done) throw streamError();
        const parsed = frameSchema.safeParse(JSON.parse(line));
        if (!parsed.success) throw streamError();
        const frame = parsed.data;
        if (frame.seq !== ++seq || (runId !== undefined && runId !== frame.runId)) throw streamError();
        runId = frame.runId;
        const event = frame.event;
        if (sawError && event.type !== "done") throw streamError();
        if (event.type === "error") sawError = true;
        if (event.type === "done") {
          if (!event.status || (sawError && event.status === "complete")) throw streamError();
          done = event as Done;
        }
        options.onEvent(event);
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_FRAME_BYTES) throw streamError();
      if (chunk.done) break;
    }
    if (buffer || !done) throw streamError();
    return done;
  } catch {
    if (options.signal?.aborted) throw abortError();
    throw streamError();
  } finally {
    options.signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestAgent(objective: string, options: StreamOptions & { fetch?: typeof fetch }): Promise<Done> {
  let response: Response;
  try { response = await (options.fetch ?? fetch)("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objective }), signal: options.signal }); }
  catch { if (options.signal?.aborted) throw abortError(); throw new Error("Agent connection unavailable. Run incomplete."); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(response.status === 409 ? "Another agent run is active. Try again after it finishes." : `Agent request failed (${response.status}).`);
  }
  return readAgentStream(response, options);
}

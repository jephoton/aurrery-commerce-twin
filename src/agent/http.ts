import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { acquireAgentLease, RunLimitError } from "./limits";
import { runAgent } from "./run";
import type { AgentEvent } from "./contracts";
import { MAX_FRAME_BYTES, type AgentFrame } from "./stream";
import { admitHostedRequest } from "@/hosting/guard";

const bodySchema = z.strictObject({ objective: z.string().trim().min(1).max(2000) });
const MAX_BODY_BYTES = 16384;
async function readBody(request: Request) {
  if (!request.body) throw new Error("BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) throw new Error("ABORT");
    for (;;) {
      const part = await reader.read();
      if (request.signal.aborted) throw new Error("ABORT");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("SIZE");
      chunks.push(part.value);
    }
    return bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { request.signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Injection belongs to server tests, never request JSON or client settings. */
export function createAgentHandler(deps: { run?: typeof runAgent; acquire?: typeof acquireAgentLease } = {}) {
  return async function handle(request: Request): Promise<Response> {
    const admission = admitHostedRequest(request, { limit: "agent" });
    if (admission) return admission;
    let body: z.infer<typeof bodySchema>;
    try { body = await readBody(request); }
    catch (error) { return Response.json({ message: "Provide only an objective of 1–2000 characters." }, { status: request.signal.aborted ? 499 : error instanceof Error && error.message === "SIZE" ? 413 : 400 }); }
    let lease: ReturnType<typeof acquireAgentLease>;
    try { lease = (deps.acquire ?? acquireAgentLease)(); }
    catch (error) { return Response.json({ message: error instanceof RunLimitError && error.code === "BUSY" ? "Another agent run is active." : "Agent unavailable." }, { status: error instanceof RunLimitError && error.code === "BUSY" ? 409 : 503 }); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const runId = randomUUID(), encoder = new TextEncoder();
    let seq = 0, closed = false, terminal = false, errorSent = false;
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          const emit = (event: AgentEvent) => {
            if (closed || terminal || (errorSent && event.type !== "done")) return;
            const frame: AgentFrame = { runId, seq: seq + 1, event };
            const bytes = encoder.encode(JSON.stringify(frame) + "\n");
            if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("FRAME_LIMIT");
            output.enqueue(bytes);
            seq++;
            if (event.type === "error") errorSent = true;
            if (event.type === "done") terminal = true;
          };
          const fail = () => {
            if (!errorSent) emit({ type: "error", code: controller.signal.aborted ? "CANCELLED" : "FAILED", message: controller.signal.aborted ? "Run cancelled." : "Agent run unavailable. Run incomplete." });
            emit({ type: "done", status: controller.signal.aborted ? "cancelled" : "incomplete", reason: controller.signal.aborted ? "CANCELLED" : "FAILED" });
          };
          void (async () => {
            try { await (deps.run ?? runAgent)({ objective: body.objective, signal: controller.signal, emit, lease }); if (!terminal) fail(); }
            catch { fail(); }
            finally {
              // Idempotent fallback also covers failure before the runner claims ownership.
              lease.release();
              request.signal.removeEventListener("abort", abort);
              if (!closed) { closed = true; output.close(); }
            }
          })();
        },
        cancel() { closed = true; controller.abort(); },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" } });
    } catch {
      controller.abort(); request.signal.removeEventListener("abort", abort); lease.release();
      return Response.json({ message: "Agent unavailable." }, { status: 503 });
    }
  };
}

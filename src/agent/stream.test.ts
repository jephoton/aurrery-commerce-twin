import { expect, it, vi } from "vitest";
import { readAgentStream, requestAgent, MAX_FRAME_BYTES } from "./stream";
import type { AgentEvent } from "./contracts";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";
import { STARTER_STRATEGIES } from "@/merchant/candidates";

const frame = (seq: number, event: AgentEvent, runId = "run-1") => JSON.stringify({ runId, seq, event }) + "\n";
function response(text: string, split = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split)); c.close(); } }));
}
it("decodes UTF-8 and lines split across every byte and requires explicit completion", async () => {
  const events: AgentEvent[] = [];
  const done = await readAgentStream(response(frame(1, { type: "summary", message: "Price café ☕" }) + frame(2, { type: "done", status: "complete", proposalId: "p1" })), { onEvent: e => events.push(e) });
  expect(events[0]).toEqual({ type: "summary", message: "Price café ☕" });
  expect(done.status).toBe("complete");
});
it("accepts a public summary within the shared byte bound", async () => {
  await expect(readAgentStream(response(frame(1, { type: "summary", message: "a".repeat(30000) }) + frame(2, { type: "done", status: "incomplete" }), 4096), { onEvent() {} })).resolves.toMatchObject({ status: "incomplete" });
});
it.each([
  frame(2, { type: "done", status: "complete" }),
  frame(1, { type: "status", message: "Started" }) + frame(2, { type: "done", status: "complete" }, "other"),
  frame(1, { type: "done", status: "complete" }).trimEnd(),
  frame(1, { type: "summary", message: "Disconnected" }),
  '{"runId":"run-1","seq":1,"event":{"type":"unknown"}}\n',
  frame(1, { type: "done" }),
  frame(1, { type: "error", code: "FAILED", message: "Incomplete" }) + frame(2, { type: "done", status: "complete" }),
  frame(1, { type: "done", status: "complete" }) + frame(2, { type: "status", message: "Late" }),
  "x".repeat(MAX_FRAME_BYTES + 1),
])("rejects corrupt, truncated or non-terminal streams", async text => {
  await expect(readAgentStream(response(text, 8192), { onEvent() {} })).rejects.toThrow(/stream/i);
});
it("retains a safe error event with an incomplete terminal status", async () => {
  const onEvent = vi.fn();
  const done = await readAgentStream(response(frame(1, { type: "error", code: "QUOTA", message: "Run incomplete: QUOTA." }) + frame(2, { type: "done", status: "incomplete", reason: "QUOTA" })), { onEvent });
  expect(done.status).toBe("incomplete");
  expect(onEvent).toHaveBeenCalledTimes(2);
});
it("round trips actual twin comparison and stress shapes without importing server code into the decoder", async () => {
  const twin = currentMerchant().twin;
  const comparison = compareStrategies(twin, [STARTER_STRATEGIES[0]], { runs: 2, horizonMonths: 1 });
  const stress = stressTest(twin, STARTER_STRATEGIES[0], { runs: 2, horizonMonths: 1 });
  const events: AgentEvent[] = [];
  await readAgentStream(response(frame(1, { type: "comparison", comparison }) + frame(2, { type: "stress", strategyId: STARTER_STRATEGIES[0].id, stress }) + frame(3, { type: "done", status: "incomplete" }), 97), { onEvent: e => events.push(e) });
  expect(events[0]).toEqual({ type: "comparison", comparison });
  expect(events[1]).toEqual({ type: "stress", strategyId: STARTER_STRATEGIES[0].id, stress });
});
it("aborts a stalled read promptly and cancels its reader", async () => {
  const cancelled = vi.fn();
  const controller = new AbortController();
  const pending = readAgentStream(new Response(new ReadableStream({ cancel: cancelled })), { signal: controller.signal, onEvent() {} });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toHaveBeenCalledOnce();
});
it("sends only the objective and sanitizes failed HTTP responses", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('private-provider-secret', { status: 500 }));
  await expect(requestAgent("Explore", { fetch: fetcher, onEvent() {} })).rejects.toThrow("Agent request failed (500).");
  expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ objective: "Explore" }));
});
it("does not wait for an uncooperative source cancellation promise", async () => {
  const controller = new AbortController();
  const pending = readAgentStream(new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) })), { signal: controller.signal, onEvent() {} });
  controller.abort();
  const settled = await Promise.race([pending.catch(error => error.name), new Promise<string>(resolve => setTimeout(() => resolve("stalled"), 20))]);
  expect(settled).toBe("AbortError");
});
it("reports malformed frames promptly even if source cleanup never resolves", async () => {
  const pending = readAgentStream(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("invalid\n")); }, cancel: () => new Promise<void>(() => {}) })), { onEvent() {} });
  const settled = await Promise.race([pending.catch(error => error.message), new Promise<string>(resolve => setTimeout(() => resolve("stalled"), 20))]);
  expect(settled).toMatch(/stream/);
});

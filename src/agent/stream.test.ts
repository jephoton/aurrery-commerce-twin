import { expect, it, vi } from "vitest";
import { readAgentStream, requestAgent, MAX_FRAME_BYTES } from "./stream";
import type { AgentEvent } from "./contracts";
import { SEGMENTS } from "@/twin/types";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";
import { STARTER_STRATEGIES } from "@/merchant/candidates";

const frame = (seq: number, event: AgentEvent, runId = "run-1") => JSON.stringify({ runId, seq, event }) + "\n";
const classifiedFrame = (exposure: number, accepted = 1): AgentEvent => ({ type: "classification", summary: { provider: "gemini", model: "fixture", stopped: false, total: 1, accepted, unclassified: 0, cacheHits: 0, segments: Object.fromEntries(SEGMENTS.map(s => [s, { price: 0, other: 0 }])) as Extract<AgentEvent, { type: "classification" }>["hitmap"], intents: { cancel: 1, considering_cancel: 0, stay: 0 }, eligiblePilotCount: 0, pilotCount: 0, mappingIssueCount: 0, source: "AI-classified synthetic feedback" }, hitmap: Object.fromEntries(SEGMENTS.map(s => [s, { price: 0, other: 0 }])) as Extract<AgentEvent, { type: "classification" }>["hitmap"], provenance: { rr: { source: "observed", note: "Measured subscriber-months", evidenceCount: exposure } } });
it("accepts fractional exposure provenance while keeping feedback counters integral", async () => {
  await expect(readAgentStream(response(frame(1, classifiedFrame(.5)) + frame(2, { type: "done", status: "incomplete" })), { onEvent() {} })).resolves.toMatchObject({ status: "incomplete" });
  for (const event of [classifiedFrame(-.5), classifiedFrame(.5, .5)]) await expect(readAgentStream(response(frame(1, event) + frame(2, { type: "done", status: "incomplete" })), { onEvent() {} })).rejects.toThrow();
});
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
it("decodes a simulate-only recommendation and rejects one that claims an action or carries extra fields", async () => {
  const recommendation: AgentEvent = { type: "recommendation", strategy: STARTER_STRATEGIES[0], rationale: "Fast-churning at-risk subscribers mostly cite price.", tradeoffs: "About $890 of discounts.", simulateOnly: true };
  const events: AgentEvent[] = [];
  await readAgentStream(response(frame(1, recommendation) + frame(2, { type: "done", status: "complete" })), { onEvent: e => events.push(e) });
  expect(events[0]).toEqual(recommendation);
  for (const bad of [{ ...recommendation, simulateOnly: false }, { ...recommendation, simulateOnly: undefined }, { ...recommendation, approvalUrl: "https://www.paypal.com/x" }, { ...recommendation, strategy: { ...STARTER_STRATEGIES[0], intervention: { kind: "unknown" } } }]) {
    await expect(readAgentStream(response(frame(1, bad as unknown as AgentEvent) + frame(2, { type: "done", status: "complete" })), { onEvent() {} })).rejects.toThrow();
  }
});

it("decodes an agent proposal for an annual-plan offer", async () => {
  const twin = currentMerchant().twin;
  const comparison = compareStrategies(twin, STARTER_STRATEGIES, { runs: 2, horizonMonths: 2 });
  const annual = comparison.strategies.find((item) => item.strategy.intervention.kind === "annual_plan")!;
  const proposal = {
    id: "prop_1", createdAt: "2026-11-06T00:00:00Z", objective: "Keep subscribers", strategy: annual.strategy,
    prediction: { metrics: annual.metrics, vsBaseline: annual.vsBaseline, probValueBelowBaseline: annual.probValueBelowBaseline },
    action: { type: "annual_plan_offer", productId: "PROD-1", monthlyPlanId: "P-1", currency: "USD", listPrice: "24.00", discountPct: 15, annualPrice: "244.80", offerWindowDays: 7, segments: ["core", "price_sensitive"], targets: [{ subscriptionId: "I-1", registration: { label: "Pilot D", segment: "core", reason: "other", createdAt: "2026-10-22T05:32:39.596Z" } }] },
    actionHash: "hash", status: "proposed", approvedAt: null, approvedBy: null, completedAt: null, revertAfter: null,
  } as unknown as Extract<AgentEvent, { type: "proposal" }>["proposal"];
  const seen: AgentEvent[] = [];
  await readAgentStream(response(frame(1, { type: "proposal", proposal, rationale: "Bigger lever", tradeoffs: "Customers must opt in" }) + frame(2, { type: "done", status: "complete", proposalId: "prop_1" })), { onEvent: (event) => seen.push(event) });
  expect(seen[0]).toMatchObject({ type: "proposal", proposal: { action: { type: "annual_plan_offer", annualPrice: "244.80" } } });
});

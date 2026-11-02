import { afterEach, expect, it, vi } from "vitest";
import { acquireAgentLease, createTokenWindow } from "@/agent/limits";
import { createMemoryPredictionCache } from "@/signals/memory-cache";
import { createClassifyHandler } from "./classify-handler";

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "test-model", GROQ_API_KEY: "fake-key" };
const post = (handler: ReturnType<typeof createClassifyHandler>, body: unknown, signal?: AbortSignal) =>
  handler(new Request("http://localhost/api/import/classify", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), signal }));
/** A Groq-shaped reply that labels price words "price" and everything else "other". */
function groq(init?: RequestInit) {
  const request = JSON.parse(String(init?.body));
  const inputs: { id: string; text: string }[] = JSON.parse(request.messages[1].content);
  const items = inputs.map((m) => ({ id: m.id, intent: "cancel", reason: /price|expensive/i.test(m.text) ? "price" : "other", confidence: 0.9 }));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: "stop" }], usage: { total_tokens: 150 } }));
}
const rows = [{ segment: "at_risk", text: "Too expensive" }, { segment: "at_risk", text: "Moving abroad" }, { segment: "core", text: "The price rose" }];
const expectLeaseFree = () => { const lease = acquireAgentLease(); lease.release(); };
afterEach(() => vi.restoreAllMocks());

it("classifies rows into per-segment counts, then answers the same rows from the cache without saying so", async () => {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const first = await post(handler, { rows });
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ provider: "groq", model: "test-model", total: 3, accepted: 3, unclassified: 0, stopped: false });
  expect(body.reasonCounts.at_risk).toEqual({ price: 1, other: 1 });
  expect(body.reasonCounts.core).toEqual({ price: 1, other: 0 });
  const second = await (await post(handler, { rows })).json();
  expect(fetch).toHaveBeenCalledTimes(1);
  // A cache hit would reveal that another uploader sent identical text: the two answers are indistinguishable.
  expect(second).toEqual(body);
  expect(Object.keys(second).sort()).toEqual(["accepted", "model", "notes", "provider", "reasonCounts", "stopped", "total", "unclassified"]);
  expectLeaseFree();
});

it("never echoes, stores or logs the feedback text", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const serialized = JSON.stringify(await (await post(handler, { rows })).json());
  for (const row of rows) expect(serialized).not.toContain(row.text);
  const invalid = JSON.stringify(await (await post(handler, { rows: [{ segment: "vip", text: "Secret words here" }], secretKey: 1 })).json());
  expect(invalid).not.toContain("Secret words");
  expect(invalid).not.toContain("secretKey");
  for (const spy of logs) expect(spy).not.toHaveBeenCalled();
});

it("returns partial counts when the deadline passes mid-classification", async () => {
  let now = 0;
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => { now += 200_000; return groq(init); });
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; } });
  const many = Array.from({ length: 45 }, (_, i) => ({ segment: "core", text: `Too expensive ${i}` }));
  const response = await post(handler, { rows: many });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ total: 45, accepted: 20, unclassified: 25, stopped: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  expectLeaseFree();
});

it("answers a client abort with the abort response, not partial counts, and frees the lease", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => { const reply = groq(init); controller.abort(); return reply; });
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const many = Array.from({ length: 45 }, (_, i) => ({ segment: "core", text: `Too expensive ${i}` }));
  const response = await post(handler, { rows: many }, controller.signal);
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({ error: "ABORTED", message: "Classification cancelled." });
  expect(fetch).toHaveBeenCalledTimes(1);
  expectLeaseFree();
  const early = new AbortController();
  early.abort();
  const before = await post(handler, { rows }, early.signal);
  expect(before.status).toBe(408);
  expect(await before.json()).toEqual({ error: "ABORTED", message: "Classification cancelled." });
  expect(fetch).toHaveBeenCalledTimes(1);
  expectLeaseFree();
});

it("rejects invalid, control-character and oversized bodies before any model call", async () => {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow() });
  const badSegment = await post(handler, { rows: [{ segment: "vip", text: "hi" }] });
  expect(badSegment.status).toBe(400);
  expect((await badSegment.json()).errors[0]).toMatchObject({ row: 2, column: "segment" });
  const control = await post(handler, { rows: [{ segment: "core", text: "bell\u0007" }] });
  expect((await control.json()).errors[0]).toMatchObject({ row: 2, column: "text", message: "must not contain control characters other than tab and line breaks" });
  const blank = await post(handler, { rows: [{ segment: "core", text: "   " }] });
  expect((await blank.json()).errors[0]).toMatchObject({ row: 2, column: "text" });
  expect((await post(handler, { rows: [], extra: 1 })).status).toBe(400);
  expect((await post(handler, { rows: Array.from({ length: 201 }, () => ({ segment: "core", text: "x" })) })).status).toBe(400);
  expect((await post(handler, "not json")).status).toBe(400);
  expect((await post(handler, "x".repeat(700_000))).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
  expectLeaseFree();
});

it("is unavailable without a configured classifier and busy while an agent run holds the lease", async () => {
  const fetch = vi.fn();
  const unconfigured = await post(createClassifyHandler({ env: {}, fetch }), { rows });
  expect(unconfigured.status).toBe(503);
  expect(await unconfigured.json()).toEqual({ error: "CLASSIFIER_UNAVAILABLE", message: "Feedback classification is not configured on this server. Import without feedback, or try again later." });
  const lease = acquireAgentLease();
  try {
    const busy = await post(createClassifyHandler({ env, fetch }), { rows });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "BUSY" });
  } finally { lease.release(); }
  expect(fetch).not.toHaveBeenCalled();
});

it("returns partial, stopped counts without leaking the error when the provider keeps failing", async () => {
  let now = 0;
  const fetch = vi.fn(async () => { throw new Error("socket closed: Too expensive"); });
  const handler = createClassifyHandler({ env, fetch, cache: createMemoryPredictionCache(), window: createTokenWindow(), now: () => now, sleep: async (ms) => { now += ms; } });
  const response = await post(handler, { rows });
  expect(response.status).toBe(200);
  expect(await response.clone().json()).toMatchObject({ total: 3, accepted: 0, unclassified: 3, stopped: true });
  const text = await response.text();
  expect(text).not.toContain("Too expensive");
  expect(text).not.toContain("socket");
  expectLeaseFree();
});

it("answers an unexpected classification failure with a fixed 502 and frees the lease", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => groq(init));
  const cache = createMemoryPredictionCache();
  vi.spyOn(cache, "get").mockImplementation(() => { throw new Error("cache broke on Too expensive"); });
  const response = await post(createClassifyHandler({ env, fetch, cache, window: createTokenWindow() }), { rows });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "CLASSIFICATION_FAILED", message: "Feedback classification failed. Import without feedback, or try again later." });
  expect(fetch).not.toHaveBeenCalled();
  for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  expectLeaseFree();
});

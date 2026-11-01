import { expect, it, vi } from "vitest";
import { createBudgetedClassifier } from "./budgeted-classifier";
import { RunLimitError } from "./limits";

type Prepare = (body: unknown) => Promise<void>;
const config = { provider: "groq" as const, model: "test-model", env: { GROQ_API_KEY: "fake-key" } };
const inputs = [{ id: "f1", text: "Too expensive", source: "cancel_flow" as const, segment: "at_risk" as const }];
const items = JSON.stringify({ items: [{ id: "f1", intent: "cancel", reason: "price", confidence: 0.9 }] });
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: items }, finish_reason: "stop" }], usage: { total_tokens: 150 } }));

it("paces each request with the frozen classification body before sending it", async () => {
  const order: string[] = [];
  const prepare = vi.fn<Prepare>(async () => { order.push("prepare"); });
  const fetcher = vi.fn<typeof fetch>(async () => { order.push("fetch"); return reply(); });
  const result = await createBudgetedClassifier({ ...config, fetch: fetcher }, { prepare }).classify(inputs);
  expect(result.error).toBeUndefined();
  expect(order).toEqual(["prepare", "fetch"]);
  const paced = prepare.mock.calls[0][0] as Record<string, unknown>;
  expect(paced).toMatchObject({ model: "test-model", max_completion_tokens: 4096, response_format: { type: "json_schema" } });
  const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as Record<string, unknown>;
  expect({ ...paced, model: undefined }).toEqual({ ...sent, model: undefined });
});

it("paces Gemini requests with Gemini's request shape", async () => {
  const prepare = vi.fn<Prepare>(async () => {});
  const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: items }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 150 } })));
  await createBudgetedClassifier({ provider: "gemini", model: "test-model", env: { GEMINI_API_KEY: "fake-key" }, fetch }, { prepare }).classify(inputs);
  expect(prepare.mock.calls[0][0]).toMatchObject({ generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "LOW" } } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rethrows budget limits by default and turns them into a terminal stop when asked", async () => {
  const prepare = vi.fn<Prepare>(async () => { throw new RunLimitError("DEADLINE"); });
  const fetch = vi.fn(async () => reply());
  await expect(createBudgetedClassifier({ ...config, fetch }, { prepare }).classify(inputs)).rejects.toBeInstanceOf(RunLimitError);
  const stopped = await createBudgetedClassifier({ ...config, fetch }, { prepare }, { onLimit: "stop" }).classify(inputs);
  expect(stopped).toMatchObject({ terminal: true, error: { category: "timeout", provider: "groq", model: "test-model" } });
  expect(fetch).not.toHaveBeenCalled();
});

it("rethrows errors that are not budget limits even in stop mode", async () => {
  const prepare = vi.fn<Prepare>(async () => { throw new Error("boom"); });
  await expect(createBudgetedClassifier({ ...config, fetch: vi.fn() }, { prepare }, { onLimit: "stop" }).classify(inputs)).rejects.toThrow("boom");
});

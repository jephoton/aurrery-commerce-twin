import { describe, expect, it, vi } from "vitest";
import { createProvider, createTransport, type ProviderConfig } from "./providers";

const input = [{ id: "a", text: "Too expensive", source: "support" as const, segment: "core" as const }];
const prediction = { id: "a", intent: "stay", reason: "price", confidence: 0.9 };
const answer = JSON.stringify({ items: [prediction] });
const groq = (text = answer) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 11, completion_tokens: 12, total_tokens: 23 } }));
const config = (fetch: typeof globalThis.fetch, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({ provider: "groq", env: { GROQ_API_KEY: "secret-value" }, fetch, sleep: async () => {}, ...overrides });

describe("provider boundary", () => {
  it("uses the Gemini alias and strips attached metadata before sending shared structured classification instructions", async () => {
    let sent: RequestInit | undefined;
    const provider = createProvider(config(async (_url, init) => {
      sent = init;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 18 } }));
    }, { provider: "gemini", env: { GOOGLE_GENERATIVE_AI_API_KEY: "alias-secret" } }));
    const result = await provider.classify([{ ...input[0], pilotIndex: 0, reason: "other" } as typeof input[number]]);
    expect(result.payload).toEqual({ items: [prediction] });
    expect(new Headers(sent?.headers).get("x-goog-api-key")).toBe("alias-secret");
    const body = JSON.parse(String(sent?.body));
    expect(body.generationConfig.responseFormat.text.schema.properties.items.type).toBe("array");
    expect(body.systemInstruction.parts[0].text).toContain("data");
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual(input);
    expect(result.metrics.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 18 });
  });

  it("normalizes Groq JSON and captures usage, explicit model and elapsed attempts", async () => {
    const provider = createProvider(config(async () => groq(), { model: "openai/gpt-oss-120b" }));
    const result = await provider.classify(input);
    expect(result.payload).toEqual({ items: [prediction] });
    expect(provider.model).toBe("openai/gpt-oss-120b");
    expect(result.metrics.usage).toEqual({ inputTokens: 11, outputTokens: 12, totalTokens: 23 });
    expect(result.metrics.attempts).toHaveLength(1);
    expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each(["network", "server"])("retries one %s failure, retaining failed-attempt metrics and bounded Retry-After", async (kind) => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const provider = createProvider(config(async () => {
      if (calls++ === 0) {
        if (kind === "network") throw new Error("secret-value request Authorization Bearer secret-value");
        return new Response("secret-value", { status: 503, headers: { "retry-after": "900", "x-ratelimit-remaining-tokens": "99", "x-secret": "secret-value" } });
      }
      return groq();
    }, { sleep }));
    const result = await provider.classify(input);
    expect(calls).toBe(2);
    expect(result.metrics.retries).toBe(1);
    expect(result.metrics.attempts).toHaveLength(2);
    expect(result.metrics.attempts[0].error?.category).toBe(kind);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    if (kind === "server") expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it.each([400, 401, 403, 404, 429])("stops on HTTP %i without retrying or leaking error bodies/headers", async (status) => {
    let calls = 0;
    const provider = createProvider(config(async () => {
      calls++;
      return new Response("secret-value in raw error", { status, headers: { "x-ratelimit-remaining-requests": "0", "x-secret": "secret-value", "retry-after": "9999" } });
    }));
    const result = await provider.classify(input);
    expect(calls).toBe(1);
    expect(result.terminal).toBe(true);
    expect(result.error?.status).toBe(status);
    expect(result.error?.retryCount).toBe(0);
    expect(result.error?.quota["x-ratelimit-remaining-requests"]).toBe("0");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("x-secret");
  });

  it("bounds retries at two attempts on persistent network failure", async () => {
    let calls = 0;
    const result = await createProvider(config(async () => { calls++; throw new Error("secret-value"); })).classify(input);
    expect(calls).toBe(2);
    expect(result.error).toMatchObject({ category: "network", retryCount: 1 });
    expect(result.metrics.attempts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("times out the body read as well as the fetch and retries once", async () => {
    let calls = 0;
    const result = await createProvider(config(async () => {
      calls++;
      return new Response(new ReadableStream({ start() {} }));
    }, { timeoutMs: 5 })).classify(input);
    expect(calls).toBe(2);
    expect(result.error?.category).toBe("timeout");
    expect(result.metrics.retries).toBe(1);
  });

  it.each([
    ["not JSON", "malformed_json"],
    [JSON.stringify({ choices: [] }), "envelope"],
    [JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }), "malformed_json"],
  ])("distinguishes malformed output from per-item validation (%s)", async (body, category) => {
    const result = await createProvider(config(async () => new Response(body))).classify(input);
    expect(result.error?.category).toBe(category);
    expect(result.terminal).toBe(false);
    expect(result.metrics.attempts).toHaveLength(1);
  });

  it("bounds response bytes without returning raw oversized output", async () => {
    const result = await createProvider(config(async () => new Response("secret-value".repeat(30_000)))).classify(input);
    expect(result.error?.category).toBe("response_size");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("reports missing explicit-provider credentials without a POST or automatic fallback", async () => {
    const fetch = vi.fn(async () => groq());
    const result = await createProvider(config(fetch, { env: { GEMINI_API_KEY: "other-secret" } })).classify(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ provider: "groq", category: "configuration" });
    expect(result.terminal).toBe(true);
  });

  it("exposes a reusable bounded transport for the separate read-only tool smoke", async () => {
    const transport = createTransport(config(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] }))));
    const result = await transport.send({ messages: [], tools: [] });
    expect(result.payload).toEqual({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] });
    expect(result.metrics.attempts).toHaveLength(1);
  });

  it("uses the nonempty alias when the canonical Gemini key is blank", async () => {
    let credential: string | null = null;
    await createProvider(config(async (_url, init) => {
      credential = new Headers(init?.headers).get("x-goog-api-key");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }));
    }, { provider: "gemini", env: { GEMINI_API_KEY: "  ", GOOGLE_GENERATIVE_AI_API_KEY: " alias-value " } })).classify(input);
    expect(credential).toBe("alias-value");
  });

  it("retains usage from a failed attempt when retrying an HTTP server error", async () => {
    let calls = 0;
    const result = await createProvider(config(async () => ++calls === 1
      ? new Response(JSON.stringify({ error: { message: "secret-value" }, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 503 })
      : groq())).classify(input);
    expect(result.metrics.usage).toEqual({ inputTokens: 14, outputTokens: 14, totalTokens: 28 });
    expect(result.metrics.attempts[0].usage.totalTokens).toBe(5);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it.each([401, 404, 429])("never retries terminal HTTP %i even when its error body stalls", async (status) => {
    let calls = 0;
    const result = await createProvider(config(async () => {
      calls++;
      return new Response(new ReadableStream({ start() {} }), { status });
    }, { timeoutMs: 5 })).classify(input);
    expect(calls).toBe(1);
    expect(result.error?.status).toBe(status);
    expect(result.error?.category).toBe(status === 429 ? "quota" : status === 401 ? "auth" : "model");
    expect(result.terminal).toBe(true);
  });

  it("times out a fetch that never produces headers", async () => {
    let calls = 0;
    const result = await createProvider(config(async () => { calls++; return new Promise<Response>(() => {}); }, { timeoutMs: 5 })).classify(input);
    expect(calls).toBe(2);
    expect(result.error?.category).toBe("timeout");
  });

  it("captures only public Gemini quota details, excluding raw errors and account dimensions", async () => {
    const body = { error: { message: "secret-value", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
      quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "0",
      quotaDimensions: { model: "gemini-3.8-flash", location: "global", consumer: "projects/private-account" },
      description: "secret-value", subject: "private-account",
    }] }] } };
    const result = await createProvider(config(async () => new Response(JSON.stringify(body), { status: 429 }), { provider: "gemini", env: { GEMINI_API_KEY: "secret-value" } })).classify(input);
    expect(result.error?.quotaViolations).toEqual([{
      quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "0", model: "gemini-3.8-flash", location: "global",
    }]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("private-account");
  });
});

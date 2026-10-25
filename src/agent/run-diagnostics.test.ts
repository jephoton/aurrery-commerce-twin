import { expect, it, vi } from "vitest";
import { runAgent } from "./run";
import { createTokenWindow } from "./limits";
import { emptyMetrics } from "@/signals/transport";
import type { AgentEvent } from "./contracts";
import type { ModelResult } from "./model";

const options = () => ({ objective: "Investigate retention", env: { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" }, window: createTokenWindow() });
it.each([
  { category: "request", status: 400, code: "PROVIDER_FAILED" },
  { category: "server", status: 503, code: "PROVIDER_FAILED" },
  { category: "auth", status: 401, code: "PROVIDER_FAILED" },
  { category: "quota", status: 429, code: "QUOTA" },
  { category: "envelope", status: 200, code: "PROTOCOL" },
] as const)("retains only safe %s failure details in the result and public event", async ({ category, status, code }) => {
  const events: AgentEvent[] = [];
  const respond = vi.fn(async () => ({ metrics: emptyMetrics(), error: { category, status, message: "PRIVATE_RAW_ERROR", reasoning: "PRIVATE_REASONING", request: { headers: { authorization: "PRIVATE_KEY" } } } }));
  const result = await runAgent({ ...options(), emit: (event) => events.push(event), model: { respond } });
  expect(result).toMatchObject({ status: "incomplete", reason: code, providerFailure: { category, status }, counters: { modelTurns: 1, requestedTools: 0 } });
  expect(result.providerFailure).toEqual({ category, status });
  const event = events.find((event) => event.type === "error");
  expect(event).toMatchObject({ code, message: expect.stringContaining(category) });
  expect(event?.type === "error" && event.message).toContain(`HTTP ${status}`);
  expect(JSON.stringify({ result, events })).not.toContain("PRIVATE_");
  expect(respond).toHaveBeenCalledTimes(1);
});
it.each([undefined, 99, 600, 400.5, NaN, Infinity, "400", { secret: "PRIVATE_STATUS" }])("drops an absent or invalid HTTP status %j while retaining its approved category", async (status) => {
  const events: AgentEvent[] = [];
  const error = { category: "server", status, raw: "PRIVATE_RAW" } as unknown as NonNullable<ModelResult["error"]>;
  const result = await runAgent({ ...options(), emit: (event) => events.push(event), model: { respond: async () => ({ metrics: emptyMetrics(), error }) } });
  expect(result.providerFailure).toEqual({ category: "server" });
  const event = events.find((event) => event.type === "error");
  expect(event?.type === "error" && event.message).toContain("server");
  expect(event?.type === "error" && event.message).not.toContain("HTTP");
  expect(JSON.stringify({ result, events })).not.toContain("PRIVATE_");
});
it.each(["PRIVATE_CATEGORY", null, { secret: "PRIVATE_CATEGORY" }])("omits unknown diagnostic categories rather than reflecting them: %j", async (category) => {
  const events: AgentEvent[] = [];
  const error = { category, status: 400, raw: "PRIVATE_RAW" } as unknown as NonNullable<ModelResult["error"]>;
  const result = await runAgent({ ...options(), emit: (event) => events.push(event), model: { respond: async () => ({ metrics: emptyMetrics(), error }) } });
  expect(result.reason).toBe("PROVIDER_FAILED");
  expect(result).not.toHaveProperty("providerFailure");
  expect(JSON.stringify({ result, events })).not.toContain("PRIVATE_");
});
it("keeps raw dependency exceptions private and leaves provider diagnostics absent", async () => {
  const events: AgentEvent[] = [];
  const result = await runAgent({ ...options(), emit: (event) => events.push(event), model: { respond: async () => { throw new Error("PRIVATE_RAW_EXCEPTION"); } } });
  expect(result.reason).toBe("FAILED");
  expect(result).not.toHaveProperty("providerFailure");
  expect(JSON.stringify({ result, events })).not.toContain("PRIVATE_");
});

import { expect, it, vi } from "vitest";
import { acquireAgentLease, createRunBudget, createTokenWindow } from "./limits";

it("allows only one active run and releases idempotently", () => {
  const lease = acquireAgentLease();
  expect(() => acquireAgentLease()).toThrow("BUSY");
  lease.release(); lease.release();
  acquireAgentLease().release();
});
it("paces the shared rolling token window and reports cancellable waits", async () => {
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const window = createTokenWindow();
  const events: unknown[] = [];
  const budget = createRunBudget({ now: () => now, sleep, window, emit: (e) => events.push(e) });
  await budget.reserve(5000);
  await budget.reserve(5000);
  expect(sleep).toHaveBeenCalledWith(60000, expect.any(AbortSignal));
  expect(events).toContainEqual(expect.objectContaining({ type: "wait", durationMs: 60000 }));
  expect(budget.counters().accountedTokens).toBe(10000);
});
it("keeps missing usage reservations, settles real usage, bounds retries and deadline", async () => {
  let now = 0;
  const budget = createRunBudget({ now: () => now, window: createTokenWindow(), maxTokens: 6000 });
  const settle = await budget.reserve(4000);
  settle(1000);
  expect(budget.counters().accountedTokens).toBe(1000);
  await budget.reserve(4000);
  await expect(budget.reserve(2000)).rejects.toThrow("TOKEN_LIMIT");
  now = 600001;
  expect(() => budget.check()).toThrow("DEADLINE");
  budget.close();
});
it("aborts while pacing and makes no further reservation", async () => {
  const controller = new AbortController();
  const budget = createRunBudget({ signal: controller.signal, window: createTokenWindow(), sleep: async () => { controller.abort(); } });
  await budget.reserve(7000);
  await expect(budget.reserve(7000)).rejects.toThrow("CANCELLED");
  expect(budget.counters().httpRequests).toBe(1);
  budget.close();
});

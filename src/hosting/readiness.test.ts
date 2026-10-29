import { afterEach, expect, it, vi } from "vitest";
import { createReadiness } from "./readiness";

afterEach(() => vi.useRealTimers());
it("returns generic no-store results and caches/coalesces a successful storage probe", async () => {
  const probe = vi.fn(async () => {});
  const health = createReadiness({ validate: () => {}, worker: () => {}, probe });
  const responses = await Promise.all(Array.from({ length: 20 }, () => health()));
  expect(responses.every(r => r.status === 200 && r.headers.get("cache-control") === "no-store")).toBe(true);
  expect(await responses[0].json()).toEqual({ status: "ready" });
  expect(probe).toHaveBeenCalledTimes(1);
  await health(); expect(probe).toHaveBeenCalledTimes(1);
});
it("fails closed before storage, with no private diagnostic text", async () => {
  const probe = vi.fn();
  for (const dependency of ["validate", "worker"] as const) {
    const health = createReadiness({ validate: () => {}, worker: () => {}, probe, [dependency]: () => { throw new Error("private-token/path"); } });
    const result = await health(); expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "unavailable" });
  }
  expect(probe).not.toHaveBeenCalled();
});
it("keeps stalled probe ownership after the deadline, then recovers only after settlement and cache expiry", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const probe = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const health = createReadiness({ validate: () => {}, worker: () => {}, probe });
  const first = health(); await vi.advanceTimersByTimeAsync(4_000);
  expect((await first).status).toBe(503);
  const again = health(); await vi.advanceTimersByTimeAsync(4_000);
  expect((await again).status).toBe(503); expect(probe).toHaveBeenCalledTimes(1);
  reject(new Error("private-network-url")); await vi.advanceTimersByTimeAsync(0);
  expect((await health()).status).toBe(503);
  await vi.advanceTimersByTimeAsync(2_001);
  expect((await health()).status).toBe(200); expect(probe).toHaveBeenCalledTimes(2);
});
it("performs no probe at module load and validates configuration on every cached request", async () => {
  const probe = vi.fn(async () => {}); let valid = true;
  const health = createReadiness({ validate() { if (!valid) throw new Error(); }, worker: () => {}, probe });
  expect(probe).not.toHaveBeenCalled(); await health(); valid = false;
  expect((await health()).status).toBe(503); expect(probe).toHaveBeenCalledTimes(1);
});

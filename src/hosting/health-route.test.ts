import { expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({ connection: vi.fn(async () => {}), readiness: vi.fn(async () => Response.json({ status: "ready" })) }));
vi.mock("next/server", () => ({ connection: dependencies.connection }));
vi.mock("./readiness", () => ({ readiness: dependencies.readiness }));
it("does not access runtime configuration/storage during import, and waits for request time", async () => {
  const { GET, runtime } = await import("@/app/api/health/route");
  expect(runtime).toBe("nodejs"); expect(dependencies.readiness).not.toHaveBeenCalled();
  await GET(); expect(dependencies.connection).toHaveBeenCalledOnce(); expect(dependencies.readiness).toHaveBeenCalledOnce();
  expect(dependencies.connection.mock.invocationCallOrder[0]).toBeLessThan(dependencies.readiness.mock.invocationCallOrder[0]);
});

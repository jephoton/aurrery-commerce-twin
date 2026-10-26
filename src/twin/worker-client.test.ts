import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "./simulate";
import { stressTest } from "./stress";
import type { Strategy } from "./interventions";
import { runComparison, runStress, WorkerTaskError } from "./worker-client";

const twin = currentMerchant().twin;
const strategy: Strategy = { id: "save", name: "Save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } };
const options = { runs: 12, horizonMonths: 2, seed: 20261113 };
const temporary = mkdtempSync(join(tmpdir(), "aurrery-worker-test-"));
const hang = join(temporary, "hang.cjs");
const started = join(temporary, "started");
const fail = join(temporary, "fail.cjs");
const inspect = join(temporary, "inspect.cjs");
writeFileSync(hang, `require('node:worker_threads').parentPort.once('message', () => { require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); while (true) {} });\n`);
writeFileSync(fail, "process.exit(9);\n");
writeFileSync(inspect, "const { parentPort, resourceLimits } = require('node:worker_threads'); parentPort.once('message', () => parentPort.postMessage({ ok: true, result: { env: process.env, execArgv: process.execArgv, heap: resourceLimits.maxOldGenerationSizeMb } }));\n");
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe("bounded twin worker", () => {
  it("preserves every seeded comparison and stress number", async () => {
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
    expect(await runStress(twin, strategy, options)).toEqual(stressTest(twin, strategy, options));
  });

  it("rejects an already aborted request without occupying capacity", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runComparison(twin, [strategy], options, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
  });

  it("aborts a running worker and releases capacity only after termination", async () => {
    rmSync(started, { force: true });
    const controller = new AbortController();
    const pending = runComparison(twin, [strategy], options, { signal: controller.signal, workerFile: hang, timeoutMs: 1000 });
    await expect(runStress(twin, strategy, options)).rejects.toMatchObject({ code: "BUSY" });
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 750 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
  });

  it("terminates a real infinite worker on deadline, then releases capacity", async () => {
    rmSync(started, { force: true });
    let parentTicked = false;
    setTimeout(() => { parentTicked = true; }, 10);
    await expect(runComparison(twin, [strategy], options, { workerFile: hang, timeoutMs: 750 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(existsSync(started)).toBe(true);
    expect(parentTicked).toBe(true);
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
  });

  it("starts with empty environment and execArgv and a 128 MiB heap", async () => {
    process.env.AURRERY_TEST_PARENT_SECRET = "only-parent";
    try {
      const result = await runComparison(twin, [strategy], options, { workerFile: inspect }) as unknown as { env: Record<string, string>; execArgv: string[]; heap: number };
      expect(result.env).toEqual({});
      expect(result.execArgv).toEqual([]);
      expect(result.heap).toBe(128);
    } finally { delete process.env.AURRERY_TEST_PARENT_SECRET; }
  });

  it("shares admission across separately loaded copies of the client module", async () => {
    const controller = new AbortController();
    const pending = runComparison(twin, [strategy], options, { signal: controller.signal, workerFile: hang });
    vi.resetModules();
    const second = await import("./worker-client");
    await expect(second.runStress(twin, strategy, options)).rejects.toMatchObject({ code: "BUSY" });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("reports abnormal exits safely and releases capacity", async () => {
    await expect(runComparison(twin, [strategy], options, { workerFile: fail })).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
  });

  it("fails safely when a worker bundle is missing, with no synchronous fallback", async () => {
    await expect(runComparison(twin, [strategy], options, { workerFile: join(temporary, "missing.cjs") })).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(await runComparison(twin, [strategy], options)).toEqual(compareStrategies(twin, [strategy], options));
  });

  it("exposes only the approved safe failure codes", () => {
    expect(new WorkerTaskError("WORKER_FAILED").message).not.toContain(temporary);
  });
});

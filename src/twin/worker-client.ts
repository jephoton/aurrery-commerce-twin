import "server-only";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { Strategy } from "./interventions";
import type { ComparisonResult, SimulationOptions } from "./simulate";
import type { StressResult } from "./stress";
import type { MerchantTwin } from "./types";

type FailureCode = "ABORTED" | "BUSY" | "TIMEOUT" | "WORKER_FAILED";
const safeMessages: Record<FailureCode, string> = {
  ABORTED: "Simulation cancelled.",
  BUSY: "Another simulation is running. Please retry shortly.",
  TIMEOUT: "Simulation exceeded its time limit.",
  WORKER_FAILED: "Simulation could not complete.",
};
export class WorkerTaskError extends Error {
  constructor(readonly code: FailureCode) { super(safeMessages[code]); }
}

export interface WorkerRunConfig {
  signal?: AbortSignal;
  /** Server-owned test override. Production callers use the default 30-second deadline. */
  timeoutMs?: number;
  /** Server-owned test fixture path. */
  workerFile?: string;
}

type Job = { kind: "compare"; twin: MerchantTwin; strategies: Strategy[]; options: Partial<SimulationOptions> }
  | { kind: "stress"; twin: MerchantTwin; strategy: Strategy; options: Partial<SimulationOptions> };

// Next may evaluate separate route bundles in one process; admission must outlive a module copy.
const capacityKey = Symbol.for("aurrery.twin.worker.occupied");
const capacity = globalThis as typeof globalThis & { [key: symbol]: boolean | undefined };

async function run<T>(job: Job, config: WorkerRunConfig = {}): Promise<T> {
  if (config.signal?.aborted) throw new WorkerTaskError("ABORTED");
  if (capacity[capacityKey]) throw new WorkerTaskError("BUSY");
  capacity[capacityKey] = true;
  let worker: Worker;
  try {
    worker = new Worker(config.workerFile ?? resolve(process.cwd(), "build", "twin-worker.cjs"), {
      env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
  } catch {
    capacity[capacityKey] = false;
    throw new WorkerTaskError("WORKER_FAILED");
  }

  return new Promise<T>((fulfill, reject) => {
    let settled = false;
    const timer = setTimeout(() => void finish(new WorkerTaskError("TIMEOUT")), config.timeoutMs ?? 30_000);
    const abort = () => void finish(new WorkerTaskError("ABORTED"));
    async function finish(error?: WorkerTaskError, result?: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", abort);
      try { await worker.terminate(); } catch { /* worker may have exited already */ }
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
      capacity[capacityKey] = false;
      if (error) reject(error);
      else fulfill(result as T);
    }
    worker.once("message", (response: { ok: boolean; result?: T }) => {
      void finish(response?.ok ? undefined : new WorkerTaskError("WORKER_FAILED"), response?.result);
    });
    worker.once("error", () => { void finish(new WorkerTaskError("WORKER_FAILED")); });
    worker.once("exit", () => { void finish(new WorkerTaskError("WORKER_FAILED")); });
    config.signal?.addEventListener("abort", abort, { once: true });
    if (config.signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch { void finish(new WorkerTaskError("WORKER_FAILED")); }
  });
}

export function runComparison(twin: MerchantTwin, strategies: Strategy[], options: Partial<SimulationOptions> = {}, config?: WorkerRunConfig): Promise<ComparisonResult> {
  return run({ kind: "compare", twin, strategies, options }, config);
}

export function runStress(twin: MerchantTwin, strategy: Strategy, options: Partial<SimulationOptions> = {}, config?: WorkerRunConfig): Promise<StressResult> {
  return run({ kind: "stress", twin, strategy, options }, config);
}

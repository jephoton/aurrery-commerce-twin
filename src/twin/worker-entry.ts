import { parentPort } from "node:worker_threads";
import { compareStrategies } from "./simulate";
import { stressTest } from "./stress";
import type { MerchantTwin } from "./types";
import type { Strategy } from "./interventions";
import type { SimulationOptions } from "./simulate";

type Job = { kind: "compare"; twin: MerchantTwin; strategies: Strategy[]; options: Partial<SimulationOptions> }
  | { kind: "stress"; twin: MerchantTwin; strategy: Strategy; options: Partial<SimulationOptions> };

parentPort?.once("message", (job: Job) => {
  try {
    const result = job.kind === "compare"
      ? compareStrategies(job.twin, job.strategies, job.options)
      : stressTest(job.twin, job.strategy, job.options);
    parentPort?.postMessage({ ok: true, result });
  } catch {
    parentPort?.postMessage({ ok: false });
  }
});

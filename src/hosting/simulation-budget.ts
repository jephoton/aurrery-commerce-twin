// Futures simulated per strategy by server-run comparisons (manual, proposal recompute and agent).
//
// Render Free gives the app about a tenth of a CPU. Measured on 2026-10-30, the hosted comparison
// of the five starter strategies took ~2.5s per 100 futures plus ~5s fixed, so 1,000 futures
// overran the 30-second worker deadline. Hosted comparisons use a smaller paired sample; the
// common random numbers keep paired differences stable, and the UI shows the actual count.

export const LOCAL_SIMULATION_RUNS = 1000;
export const HOSTED_SIMULATION_RUNS = 400;

type Env = Record<string, string | undefined>;

export function simulationRuns(env: Env = process.env): number {
  const override = env.SIMULATION_RUNS;
  if (override !== undefined) {
    if (!/^\d{3,4}$/.test(override) || Number(override) < 100 || Number(override) > 5000) {
      throw new Error("Invalid simulation configuration");
    }
    return Number(override);
  }
  return env.RENDER === "true" || env.HOSTED_DEMO === "true" ? HOSTED_SIMULATION_RUNS : LOCAL_SIMULATION_RUNS;
}

/** A request may ask for fewer futures than the budget, never more. */
export function cappedSimulationRuns(requested: number | undefined, env: Env = process.env): number {
  const budget = simulationRuns(env);
  return Math.min(requested ?? budget, budget);
}

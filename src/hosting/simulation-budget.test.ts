import { describe, expect, it } from "vitest";
import { HOSTED_SIMULATION_RUNS, LOCAL_SIMULATION_RUNS, cappedSimulationRuns, simulationRuns } from "./simulation-budget";

describe("simulation budget", () => {
  it("uses the full sample locally", () => {
    expect(simulationRuns({})).toBe(LOCAL_SIMULATION_RUNS);
    expect(LOCAL_SIMULATION_RUNS).toBe(1000);
  });

  it.each([{ RENDER: "true" }, { HOSTED_DEMO: "true" }])("uses the hosted sample when hosted (%o)", (env) => {
    expect(simulationRuns(env)).toBe(HOSTED_SIMULATION_RUNS);
    expect(HOSTED_SIMULATION_RUNS).toBeLessThan(LOCAL_SIMULATION_RUNS);
  });

  it("accepts an explicit override within the API bounds", () => {
    expect(simulationRuns({ RENDER: "true", SIMULATION_RUNS: "250" })).toBe(250);
    expect(simulationRuns({ SIMULATION_RUNS: "5000" })).toBe(5000);
  });

  it.each(["", "99", "5001", "300.5", "1e3", " 300", "abc"])("rejects an invalid override %j", (value) => {
    expect(() => simulationRuns({ SIMULATION_RUNS: value })).toThrow("Invalid simulation configuration");
  });

  it("caps requested runs at the budget and defaults to it", () => {
    expect(cappedSimulationRuns(undefined, { RENDER: "true" })).toBe(HOSTED_SIMULATION_RUNS);
    expect(cappedSimulationRuns(5000, { RENDER: "true" })).toBe(HOSTED_SIMULATION_RUNS);
    expect(cappedSimulationRuns(100, { RENDER: "true" })).toBe(100);
    expect(cappedSimulationRuns(undefined, {})).toBe(LOCAL_SIMULATION_RUNS);
  });
});

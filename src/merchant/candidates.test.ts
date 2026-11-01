import { expect, it } from "vitest";
import { StrategySchema } from "@/twin/interventions";
import { STARTER_STRATEGIES, starterStrategiesFor } from "./candidates";
import { buildDemoTwin } from "./demo";

it("accepts every actual starter strategy through the API strategy schema", () => {
  for (const strategy of STARTER_STRATEGIES) {
    expect(StrategySchema.safeParse(strategy).success, strategy.id).toBe(true);
  }
});

it("scales list-price candidates with the list price and keeps Ridgeline's set exactly", () => {
  expect(starterStrategiesFor(24)).toEqual(STARTER_STRATEGIES);
  expect(starterStrategiesFor(20).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-18", "list-23"]);
  expect(starterStrategiesFor(20).find((s) => s.id === "list-23")?.name).toBe("Raise list price to $23");
  expect(starterStrategiesFor(20).find((s) => s.id === "list-18")?.name).toBe("Cut list price to $18");
  expect(starterStrategiesFor(4).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-5"]);
  expect(starterStrategiesFor(1).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15"]);
  // $190 × 9/8 = $214 is outside the $5–$200 guardrail, so only the cut remains.
  expect(starterStrategiesFor(190).map((s) => s.id)).toEqual(["at-risk-20-3m", "cancel-price-25-3m", "annual-15", "list-174"]);
  expect(starterStrategiesFor(20, { reasonTargeting: false }).map((s) => s.id)).not.toContain("cancel-price-25-3m");
  expect(starterStrategiesFor(24, { reasonTargeting: true })).toEqual(STARTER_STRATEGIES);
});

it("drops the price-driven cancel save when almost nobody starts in cancel intent, and keeps Ridgeline's set", () => {
  const ridgelineCancelIntent = buildDemoTwin().twin.initialActive.cancel_intent;
  expect(ridgelineCancelIntent).toBeGreaterThanOrEqual(5);
  expect(starterStrategiesFor(24, { reasonTargeting: true, cancelIntentActive: ridgelineCancelIntent })).toEqual(STARTER_STRATEGIES);
  expect(starterStrategiesFor(20, { cancelIntentActive: 5 }).map((s) => s.id)).toContain("cancel-price-25-3m");
  expect(starterStrategiesFor(20, { cancelIntentActive: 4 }).map((s) => s.id)).toEqual(["at-risk-20-3m", "annual-15", "list-18", "list-23"]);
  expect(starterStrategiesFor(20, { cancelIntentActive: 0 }).map((s) => s.id)).not.toContain("cancel-price-25-3m");
});

it("keeps every scaled starter valid for the API strategy schema", () => {
  for (const price of [1, 4, 5.5, 20, 24, 99.99, 190, 200]) {
    for (const strategy of starterStrategiesFor(price)) {
      expect(StrategySchema.safeParse(strategy).success, `${price} ${strategy.id}`).toBe(true);
    }
  }
});

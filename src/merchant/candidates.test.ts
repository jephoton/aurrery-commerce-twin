import { expect, it } from "vitest";
import { StrategySchema } from "@/twin/interventions";
import { STARTER_STRATEGIES } from "./candidates";

it("accepts every actual starter strategy through the API strategy schema", () => {
  for (const strategy of STARTER_STRATEGIES) {
    expect(StrategySchema.safeParse(strategy).success, strategy.id).toBe(true);
  }
});

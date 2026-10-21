import { z } from "zod";
import { currentMerchant } from "@/merchant";
import { StrategySchema } from "@/twin/interventions";
import { compareStrategies } from "@/twin/simulate";
import { errorResponse } from "../_lib/http";

const BodySchema = z.object({
  strategies: z.array(StrategySchema).min(1).max(8),
  options: z
    .object({
      runs: z.number().int().min(100).max(5000).optional(),
      horizonMonths: z.number().int().min(1).max(36).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  try {
    const body = BodySchema.parse(await request.json());
    return Response.json(compareStrategies(currentMerchant().twin, body.strategies, body.options));
  } catch (e) {
    return errorResponse(e);
  }
}

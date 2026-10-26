import { z } from "zod";
import { currentMerchant } from "@/merchant";
import { StrategySchema } from "@/twin/interventions";
import { runComparison } from "@/twin/worker-client";
import { errorResponse, readBoundedJson } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

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
  const admission = admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const body = BodySchema.parse(await readBoundedJson(request));
    return Response.json(await runComparison(currentMerchant().twin, body.strategies, body.options, { signal: request.signal }));
  } catch (e) {
    return errorResponse(e);
  }
}

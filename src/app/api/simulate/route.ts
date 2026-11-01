import { z } from "zod";
import { observedMerchant } from "@/merchant/observed";
import { toObservedSnapshot } from "@/merchant/observed-snapshot";
import { ImportPayloadSchema, payloadIssues } from "@/import/import-payload";
import { buildImportedTwin, usesReasonTargeting } from "@/import/imported-twin";
import { StrategySchema } from "@/twin/interventions";
import { runComparison } from "@/twin/worker-client";
import { errorResponse, invalidImportResponse, readBoundedJson, reasonUnavailableResponse } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";
import { cappedSimulationRuns } from "@/hosting/simulation-budget";

const BodySchema = z.object({
  strategies: z.array(StrategySchema).min(1).max(8),
  options: z
    .object({
      runs: z.number().int().min(100).max(5000).optional(),
      horizonMonths: z.number().int().min(1).max(36).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  /**
   * An imported merchant (M6): the twin is rebuilt from this payload for this request only. Parsed
   * separately so errors name rows and columns only, never client-sent keys.
   */
  import: z.unknown().optional(),
});

export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const body = BodySchema.parse(await readBoundedJson(request));
    const options = { ...body.options, runs: cappedSimulationRuns(body.options?.runs) };
    if (body.import !== undefined) {
      // Simulate only: never reads Ridgeline's observed ledger evidence (discount outcomes or annual offers).
      const payload = ImportPayloadSchema.safeParse(body.import);
      if (!payload.success) return invalidImportResponse(payloadIssues(payload.error));
      const built = buildImportedTwin(payload.data);
      if (!built.ok) return invalidImportResponse(built.errors);
      if (!built.reasonTargeting && body.strategies.some(usesReasonTargeting)) return reasonUnavailableResponse();
      const comparison = await runComparison(built.twin, body.strategies, options, { signal: request.signal });
      return Response.json({ ...comparison, imported: true });
    }
    const merchant = await observedMerchant();
    const observedSnapshot = toObservedSnapshot(merchant);
    const comparison = await runComparison(merchant.twin, body.strategies, options, { signal: request.signal });
    return Response.json({ ...comparison, observedSnapshot });
  } catch (e) {
    return errorResponse(e);
  }
}

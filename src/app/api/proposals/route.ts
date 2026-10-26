import { z } from "zod";
import { listExecutions } from "@/execution/execute";
import { createProposal, listProposals } from "@/ledger/proposals";
import { currentMerchant } from "@/merchant";
import { StrategySchema } from "@/twin/interventions";
import { runComparison, WorkerTaskError } from "@/twin/worker-client";
import { errorResponse, readBoundedJson } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

const BodySchema = z.object({
  objective: z.string().max(1000).nullable().default(null),
  strategy: StrategySchema,
});

export function GET(request: Request) {
  const admission = admitHostedRequest(request);
  if (admission) return admission;
  try {
    return Response.json({ proposals: listProposals().map((p) => ({ ...p, executions: listExecutions(p.id) })) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create a proposal. The prediction is recomputed here, server-side, never taken from the client. */
export async function POST(request: Request) {
  const admission = admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const body = BodySchema.parse(await readBoundedJson(request));
    const { twin } = currentMerchant();
    const comparison = await runComparison(twin, [body.strategy], {}, { signal: request.signal });
    if (request.signal.aborted) throw new WorkerTaskError("ABORTED");
    const result = comparison.strategies.find((s) => s.strategy.id === body.strategy.id)!;
    const proposal = createProposal({ objective: body.objective, strategy: body.strategy, result, listPrice: twin.params.listPrice });
    return Response.json({ proposal }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

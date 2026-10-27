import { z } from "zod";
import { connection } from "next/server";
import { listExecutions } from "@/execution/execute";
import { createProposal, listProposals } from "@/ledger/proposals";
import { observedMerchant } from "@/merchant/observed";
import { StrategySchema } from "@/twin/interventions";
import { runComparison, WorkerTaskError } from "@/twin/worker-client";
import { errorResponse, readBoundedJson } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

const BodySchema = z.object({
  objective: z.string().max(1000).nullable().default(null),
  strategy: StrategySchema,
});

export async function GET(request: Request) {
  await connection();
  const admission = await admitHostedRequest(request);
  if (admission) return admission;
  try {
    const proposals = await listProposals();
    return Response.json({ proposals: await Promise.all(proposals.map(async (p) => ({ ...p, executions: await listExecutions(p.id) }))) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create a proposal. The prediction is recomputed here, server-side, never taken from the client. */
export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const body = BodySchema.parse(await readBoundedJson(request));
    const { twin } = await observedMerchant();
    const comparison = await runComparison(twin, [body.strategy], {}, { signal: request.signal });
    if (request.signal.aborted) throw new WorkerTaskError("ABORTED");
    const result = comparison.strategies.find((s) => s.strategy.id === body.strategy.id)!;
    const proposal = await createProposal({ objective: body.objective, strategy: body.strategy, result, listPrice: twin.params.listPrice });
    return Response.json({ proposal }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

import { z } from "zod";
import { listExecutions } from "@/execution/execute";
import { createProposal, listProposals } from "@/ledger/proposals";
import { currentMerchant } from "@/merchant";
import { StrategySchema } from "@/twin/interventions";
import { compareStrategies } from "@/twin/simulate";
import { errorResponse } from "../_lib/http";

const BodySchema = z.object({
  objective: z.string().max(1000).nullable().default(null),
  strategy: StrategySchema,
});

export function GET() {
  try {
    return Response.json({ proposals: listProposals().map((p) => ({ ...p, executions: listExecutions(p.id) })) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create a proposal. The prediction is recomputed here, server-side, never taken from the client. */
export async function POST(request: Request) {
  try {
    const body = BodySchema.parse(await request.json());
    const { twin } = currentMerchant();
    const comparison = compareStrategies(twin, [body.strategy]);
    const result = comparison.strategies.find((s) => s.strategy.id === body.strategy.id)!;
    const proposal = createProposal({ objective: body.objective, strategy: body.strategy, result, listPrice: twin.params.listPrice });
    return Response.json({ proposal }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

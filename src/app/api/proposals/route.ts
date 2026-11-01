import { z } from "zod";
import { connection } from "next/server";
import { listExecutions } from "@/execution/execute";
import { PAYPAL_NOT_CONFIGURED_MESSAGE, proposeStrategy } from "@/execution/annual-proposal";
import { listProposals, ProposalError } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { observedMerchant } from "@/merchant/observed";
import { StrategySchema } from "@/twin/interventions";
import { runComparison, WorkerTaskError } from "@/twin/worker-client";
import { demoOnlyResponse, errorResponse, readBoundedJson } from "../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";
import { simulationRuns } from "@/hosting/simulation-budget";

const BodySchema = z.object({
  objective: z.string().max(1000).nullable().default(null),
  strategy: StrategySchema,
  /** Annual offers only: whole days each customer has to accept; bound into the action hash. */
  offerWindowDays: z.number().int().min(1).max(30).optional(),
}).refine((body) => body.offerWindowDays === undefined || body.strategy.intervention.kind === "annual_plan", {
  message: "An offer window applies only to an annual-plan strategy.", path: ["offerWindowDays"],
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
    const raw = await readBoundedJson(request);
    // Imported merchants are simulate only (M6): an import never becomes a proposal or an annual offer.
    if (typeof raw === "object" && raw !== null && "import" in raw) return demoOnlyResponse();
    const body = BodySchema.parse(raw);
    // Annual offers need live PayPal reads; refuse before spending a simulation.
    if (body.strategy.intervention.kind === "annual_plan" && !paypalConfigured()) throw new ProposalError(PAYPAL_NOT_CONFIGURED_MESSAGE, "NOT_EXECUTABLE");
    const { twin } = await observedMerchant();
    const comparison = await runComparison(twin, [body.strategy], { runs: simulationRuns() }, { signal: request.signal });
    if (request.signal.aborted) throw new WorkerTaskError("ABORTED");
    const result = comparison.strategies.find((s) => s.strategy.id === body.strategy.id)!;
    const proposal = await proposeStrategy({ objective: body.objective, strategy: body.strategy, result, listPrice: twin.params.listPrice, offerWindowDays: body.offerWindowDays }, request.signal);
    return Response.json({ proposal }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

import { z } from "zod";
import { executeProposal, ExecutionReconciliationRequired } from "@/execution/execute";
import { approveResetProposal, ProposalError } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, readBoundedJson } from "../../../../_lib/http";

const BodySchema = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();

/** Fresh administrator confirmation approves the exact reset and uses the shared claim/executor. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const admission = await admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  try {
    const { id } = await params;
    const body = BodySchema.parse(await readBoundedJson(request));
    if (!paypalConfigured()) return Response.json({ error: "PAYPAL_NOT_CONFIGURED" }, { status: 503 });
    try { await approveResetProposal(id, body.actionHash, "administrator (demo reset)"); }
    catch (error) { if (error instanceof ProposalError) throw error; throw new ExecutionReconciliationRequired(id); }
    return Response.json(await executeProposal(id));
  } catch (error) { return errorResponse(error); }
}

import { z } from "zod";
import { executeProposal, ExecutionReconciliationRequired } from "@/execution/execute";
import { approveProposal, ProposalError } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { errorResponse, readBoundedJson } from "../../../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

const BodySchema = z.object({
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().min(1).max(80),
});

/** Explicit merchant approval of an exact action payload, followed by a single PayPal execution. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admission = admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  try {
    const { id } = await params;
    const body = BodySchema.parse(await readBoundedJson(request));
    if (!paypalConfigured()) {
      return Response.json({ error: "PAYPAL_NOT_CONFIGURED", message: "Set PayPal sandbox credentials before approving." }, { status: 503 });
    }
    try { await approveProposal(id, body.actionHash, body.approvedBy); }
    catch (error) { if (error instanceof ProposalError) throw error; throw new ExecutionReconciliationRequired(id); }
    return Response.json(await executeProposal(id));
  } catch (e) {
    return errorResponse(e);
  }
}

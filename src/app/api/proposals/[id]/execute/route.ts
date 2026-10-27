import { z } from "zod";
import { executeProposal } from "@/execution/execute";
import { getProposal, ProposalError } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, readBoundedJson } from "../../../_lib/http";

const BodySchema = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();

/** A new explicit merchant request can resume only an approved action after an uncertain claim acknowledgement. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admission = await admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  try {
    const { id } = await params;
    const body = BodySchema.parse(await readBoundedJson(request));
    const proposal = await getProposal(id);
    if (proposal.actionHash !== body.actionHash) throw new ProposalError("Approved payload does not match the proposal.", "HASH_MISMATCH");
    if (proposal.status !== "approved") throw new ProposalError("Only an approved action can be explicitly executed.", "INVALID_STATE");
    if (!paypalConfigured()) return Response.json({ error: "PAYPAL_NOT_CONFIGURED" }, { status: 503 });
    return Response.json(await executeProposal(id));
  } catch (error) { return errorResponse(error); }
}

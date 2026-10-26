import { z } from "zod";
import { rejectProposal } from "@/ledger/proposals";
import { errorResponse, readBoundedJson } from "../../../_lib/http";
import { admitHostedRequest } from "@/hosting/guard";

const BodySchema = z.object({ reason: z.string().max(500).default("Rejected by merchant") });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admission = admitHostedRequest(request, { admin: true });
  if (admission) return admission;
  try {
    const { id } = await params;
    const body = BodySchema.parse(request.body ? await readBoundedJson(request) : {});
    return Response.json({ proposal: rejectProposal(id, body.reason) });
  } catch (e) {
    return errorResponse(e);
  }
}

import { z } from "zod";
import { createRevertProposal } from "@/ledger/proposals";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, readBoundedJson } from "../../_lib/http";

const BodySchema = z.object({ sourceProposalId: z.string().regex(/^prop_[0-9a-f-]{36}$/) }).strict();

/** Preview only. The merchant must separately approve the resulting exact hash. */
export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const { sourceProposalId } = BodySchema.parse(await readBoundedJson(request));
    return Response.json({ proposal: await createRevertProposal(sourceProposalId) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

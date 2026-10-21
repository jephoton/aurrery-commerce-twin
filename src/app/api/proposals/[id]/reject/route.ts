import { z } from "zod";
import { rejectProposal } from "@/ledger/proposals";
import { errorResponse } from "../../../_lib/http";

const BodySchema = z.object({ reason: z.string().max(500).default("Rejected by merchant") });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = BodySchema.parse(await request.json().catch(() => ({})));
    return Response.json({ proposal: rejectProposal(id, body.reason) });
  } catch (e) {
    return errorResponse(e);
  }
}

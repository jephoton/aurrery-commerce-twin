import { connection } from "next/server";
import { z } from "zod";
import { admitHostedRequest } from "@/hosting/guard";
import { getProposal } from "@/ledger/proposals";
import { errorResponse } from "../../_lib/http";

/** One authoritative action, including an older selected proposal outside recent/paged lists. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const admission = await admitHostedRequest(request);
  if (admission) return admission;
  try {
    const id = z.string().regex(/^prop_[0-9a-f-]{36}$/).parse((await params).id);
    return Response.json({ proposal: await getProposal(id) });
  } catch (error) { return errorResponse(error); }
}

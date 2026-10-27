import { connection } from "next/server";
import { z } from "zod";
import { admitHostedRequest } from "@/hosting/guard";
import { listOutstandingProposals, type ProposalCursor } from "@/ledger/proposals";
import { errorResponse, RequestBodyError } from "../../_lib/http";

const CursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().regex(/^prop_[0-9a-f-]{36}$/) }).strict();

/** Bounded pages of actions that still need merchant attention, independent of recent history. */
export async function GET(request: Request) {
  await connection();
  const admission = await admitHostedRequest(request);
  if (admission) return admission;
  try {
    const params = new URL(request.url).searchParams;
    const limit = params.has("limit") ? z.coerce.number().int().min(1).max(50).parse(params.get("limit")) : 20;
    const encoded = params.get("cursor");
    let before: ProposalCursor | undefined;
    if (encoded !== null) {
      if (encoded.length > 300 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new RequestBodyError("INVALID_JSON");
      try { before = CursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
      catch { throw new RequestBodyError("INVALID_JSON"); }
    }
    const page = await listOutstandingProposals(limit, before);
    return Response.json({ proposals: page.proposals, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") : null });
  } catch (error) { return errorResponse(error); }
}

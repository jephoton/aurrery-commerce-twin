import { z } from "zod";
import { previewDemoReset } from "@/execution/reset";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, readBoundedJson } from "../../_lib/http";

/** Preview derives the cohort and canonical price; callers cannot supply either. */
export async function POST(request: Request): Promise<Response> {
  const admission = await admitHostedRequest(request, { admin: true, limit: "preparation" });
  if (admission) return admission;
  try {
    z.object({}).strict().parse(await readBoundedJson(request));
    const preview = await previewDemoReset();
    return Response.json(preview, { status: preview.proposal ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}

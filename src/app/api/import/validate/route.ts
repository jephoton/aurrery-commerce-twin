import { ImportPayloadSchema, payloadIssues } from "@/import/import-payload";
import { buildImportedTwin } from "@/import/imported-twin";
import { summarizeMerchant } from "@/merchant/summary";
import { admitHostedRequest } from "@/hosting/guard";
import { errorResponse, invalidImportResponse, readBoundedJson } from "../../_lib/http";

/**
 * Re-validates an import (history, economics and classified counts) and summarizes the twin it builds.
 * Stateless: nothing about the upload is stored, logged or exported, and errors name rows and columns
 * only. POST handlers are never cached.
 */
export async function POST(request: Request) {
  const admission = await admitHostedRequest(request, { limit: "preparation" });
  if (admission) return admission;
  try {
    const parsed = ImportPayloadSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) return invalidImportResponse(payloadIssues(parsed.error));
    const built = buildImportedTwin(parsed.data);
    if (!built.ok) return invalidImportResponse(built.errors);
    const counts = built.reasonTargeting ? parsed.data.reasonCounts : undefined;
    const summary = summarizeMerchant(built.twin, built.history, {
      imported: { months: built.months, firstMonth: built.firstMonth, lastMonth: built.lastMonth, feedbackRows: built.feedbackRows, ...(counts ? { reasonCounts: counts } : {}) },
    });
    return Response.json({ summary, reasonTargeting: built.reasonTargeting });
  } catch (e) {
    return errorResponse(e);
  }
}

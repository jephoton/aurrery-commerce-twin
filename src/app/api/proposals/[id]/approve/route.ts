import { z } from "zod";
import { executeProposal } from "@/execution/execute";
import { approveProposal } from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { errorResponse } from "../../../_lib/http";

const BodySchema = z.object({
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().min(1).max(80),
});

/** Explicit merchant approval of an exact action payload, followed by a single PayPal execution. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = BodySchema.parse(await request.json());
    if (!paypalConfigured()) {
      return Response.json({ error: "PAYPAL_NOT_CONFIGURED", message: "Set PayPal sandbox credentials before approving." }, { status: 503 });
    }
    approveProposal(id, body.actionHash, body.approvedBy);
    return Response.json(await executeProposal(id));
  } catch (e) {
    return errorResponse(e);
  }
}

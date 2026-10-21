import { ZodError } from "zod";
import { ProposalError } from "@/ledger/proposals";

const STATUS_BY_CODE: Record<ProposalError["code"], number> = {
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  HASH_MISMATCH: 409,
  NOT_EXECUTABLE: 422,
  NO_TARGETS: 422,
};

export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_INPUT", issues: error.issues }, { status: 400 });
  }
  if (error instanceof ProposalError) {
    return Response.json({ error: error.code, message: error.message }, { status: STATUS_BY_CODE[error.code] });
  }
  console.error(error);
  return Response.json({ error: "INTERNAL", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

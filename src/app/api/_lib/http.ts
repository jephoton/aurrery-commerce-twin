import { ZodError } from "zod";
import { ProposalError } from "@/ledger/proposals";
import { ExecutionReconciliationRequired } from "@/execution/execute";
import { WorkerTaskError } from "@/twin/worker-client";

const MAX_JSON_BYTES = 64 * 1024;
export class RequestBodyError extends Error {
  constructor(readonly code: "BODY_TOO_LARGE" | "INVALID_JSON") { super(code); }
}

/** Read at most the admitted bytes, including when Content-Length is absent or false. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new RequestBodyError("BODY_TOO_LARGE");
  if (!request.body) throw new RequestBodyError("INVALID_JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) throw new WorkerTaskError("ABORTED");
      const { value, done } = await reader.read();
      if (request.signal.aborted) throw new WorkerTaskError("ABORTED");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw new RequestBodyError("BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RequestBodyError("INVALID_JSON"); }
}

const STATUS_BY_CODE: Record<ProposalError["code"], number> = {
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  HASH_MISMATCH: 409,
  NOT_EXECUTABLE: 422,
  NO_TARGETS: 422,
};

export function errorResponse(error: unknown): Response {
  if (error instanceof ExecutionReconciliationRequired) {
    return Response.json({ error: "RECONCILIATION_REQUIRED", proposalId: error.proposalId, message: "Approval or execution outcome is unconfirmed. Check the ledger and PayPal before any further action." }, { status: 409 });
  }
  if (error instanceof RequestBodyError) {
    return Response.json({ error: error.code }, { status: error.code === "BODY_TOO_LARGE" ? 413 : 400 });
  }
  if (error instanceof WorkerTaskError) {
    const status = { ABORTED: 408, BUSY: 429, TIMEOUT: 504, WORKER_FAILED: 503 }[error.code];
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof ZodError) {
    return Response.json({ error: "INVALID_INPUT", issues: error.issues }, { status: 400 });
  }
  if (error instanceof ProposalError) {
    return Response.json({ error: error.code, message: error.message }, { status: STATUS_BY_CODE[error.code] });
  }
  console.error("API request failed: INTERNAL");
  return Response.json({ error: "INTERNAL", message: "Request unavailable." }, { status: 500 });
}

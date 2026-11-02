import { capErrors, type RowError } from "./row-error";

/** Per-row import errors (M6). Nothing was stored, so the browser's current twin stays as it was. */
export function invalidImportResponse(errors: RowError[]): Response {
  return Response.json({ error: "INVALID_IMPORT", message: "The import has errors. Nothing was changed.", errors: capErrors(errors) }, { status: 400 });
}

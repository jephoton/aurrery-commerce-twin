/** A validation error located by CSV row (the physical line where the record starts; the header is row 1) and column. */
export interface RowError { row: number | null; column: string | null; message: string }

export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; errors: RowError[] };

export const MAX_REPORTED_ERRORS = 50;

export function formatRowError(error: RowError): string {
  const where = [error.row === null ? null : `row ${error.row}`, error.column].filter((part): part is string => !!part).join(", ");
  return where ? `${where}: ${error.message}` : error.message;
}

/** Keeps responses and the UI bounded; the last entry says how many were left out. */
export function capErrors(errors: RowError[]): RowError[] {
  if (errors.length <= MAX_REPORTED_ERRORS) return errors;
  return [...errors.slice(0, MAX_REPORTED_ERRORS), { row: null, column: null, message: `${errors.length - MAX_REPORTED_ERRORS} more errors not shown` }];
}

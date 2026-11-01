import { z } from "zod";
import type { RowError } from "./row-error";

// Merchant-entered unit economics for an imported twin. Labelled as assumptions in provenance.

const label = z.string().trim()
  .min(1, "is required")
  .max(80, "must be at most 80 characters")
  // \p{Cc} (C0 and C1 controls) keeps ESLint's no-control-regex quiet, unlike a \u0000-\u001f range.
  .regex(/^\P{Cc}*$/u, "must not contain control characters");

export const EconomicsSchema = z.strictObject({
  merchantName: label,
  planName: label,
  listPrice: z.number().finite().min(1, "must be at least 1 USD").max(200, "must be at most 200 USD"),
  unitCost: z.number().finite().min(0, "must not be negative"),
  shippingCost: z.number().finite().min(0, "must not be negative"),
  paymentFeeRate: z.number().finite().min(0, "must not be negative").max(0.2, "must be at most 0.2"),
  paymentFeeFixed: z.number().finite().min(0, "must not be negative").max(5, "must be at most 5 USD"),
}).superRefine((e, ctx) => {
  if (e.unitCost + e.shippingCost >= e.listPrice) ctx.addIssue({ code: "custom", path: ["unitCost"], message: "unit cost plus shipping must be below the list price" });
});
export type Economics = z.infer<typeof EconomicsSchema>;

/** Ridgeline's numbers under a neutral name, so an import never looks like the demo merchant. */
export const DEFAULT_ECONOMICS: Economics = { merchantName: "Your merchant", planName: "Monthly plan", listPrice: 24, unitCost: 9.2, shippingCost: 4.1, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

/** The committed sample merchant (fictional). */
export const SAMPLE_ECONOMICS: Economics = { merchantName: "Hollowbrook Treat Box", planName: "Treat Box (monthly)", listPrice: 20, unitCost: 5, shippingCost: 3, paymentFeeRate: 0.0349, paymentFeeFixed: 0.49 };

export function economicsErrors(error: z.ZodError): RowError[] {
  return error.issues.map((issue) => ({ row: null, column: issue.path.map(String).join(".") || null, message: issue.message }));
}

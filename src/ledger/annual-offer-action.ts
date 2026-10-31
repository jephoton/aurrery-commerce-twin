import { z } from "zod";
import type { Strategy } from "@/twin/interventions";
import { REASONS, SEGMENTS } from "@/twin/types";
import { usdCents } from "@/paypal/prices";

// The exact payload a merchant approves for an annual-plan offer. Its SHA-256 hash binds the
// approval; execution may only do what this payload says.

export const MAX_ANNUAL_TARGETS = 25;
export const MAX_ANNUAL_LIST_CENTS = 20000; // matches the list_price_change max ($200)
const Money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/); // canonical, agrees with usdCents

// The registration snapshot taken at approval time. MUST stay identical to the `registration`
// object in RevertTargetSchema (src/ledger/proposals.ts); duplicated here only to keep this
// module free of "server-only".
const RegistrationSnapshotSchema = z.object({
  label: z.string().min(1), segment: z.enum(SEGMENTS), reason: z.enum(REASONS), createdAt: z.string().datetime(),
}).strict();

export const AnnualOfferTargetSchema = z.object({
  subscriptionId: z.string().regex(/^I-[A-Z0-9]+$/),
  registration: RegistrationSnapshotSchema,
}).strict();

/** list × 12 × (1 − discount%), rounded to the cent, without float drift. */
export function annualPriceCents(listPrice: string, discountPct: number): number | null {
  const list = usdCents(listPrice);
  return list === null ? null : Math.round((list * 12 * (100 - discountPct)) / 100);
}

const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export const AnnualOfferActionSchema = z.object({
  type: z.literal("annual_plan_offer"),
  productId: z.string().regex(/^PROD-[A-Z0-9]+$/),
  monthlyPlanId: z.string().regex(/^P-[A-Z0-9]+$/),
  currency: z.literal("USD"),
  listPrice: Money,
  discountPct: z.number().min(0).max(40),
  annualPrice: Money,
  offerWindowDays: z.number().int().min(1).max(30),
  segments: z.array(z.enum(SEGMENTS)).min(1).max(SEGMENTS.length),
  targets: z.array(AnnualOfferTargetSchema).min(1).max(MAX_ANNUAL_TARGETS),
}).strict().superRefine((action, ctx) => {
  const listCents = usdCents(action.listPrice);
  if (listCents === null || listCents <= 0 || listCents > MAX_ANNUAL_LIST_CENTS)
    ctx.addIssue({ code: "custom", message: "List price must be between $0.01 and $200.00", path: ["listPrice"] });
  const expected = annualPriceCents(action.listPrice, action.discountPct);
  const annualCents = usdCents(action.annualPrice);
  if (expected === null || annualCents === null || annualCents <= 0 || annualCents !== expected)
    ctx.addIssue({ code: "custom", message: "Annual price does not match the list price and discount", path: ["annualPrice"] });
  if (new Set(action.targets.map((t) => t.subscriptionId)).size !== action.targets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate annual offer target", path: ["targets"] });
  if (new Set(action.segments).size !== action.segments.length)
    ctx.addIssue({ code: "custom", message: "Duplicate annual offer segment", path: ["segments"] });
  if (action.targets.some((t) => !action.segments.includes(t.registration.segment)))
    ctx.addIssue({ code: "custom", message: "Target outside the offered segments", path: ["targets"] });
});
export type AnnualOfferAction = z.infer<typeof AnnualOfferActionSchema>;

export interface AnnualOfferCandidate { subscriptionId: string; label: string; segment: string; reason: string; createdAt: string }

/**
 * Build the payload from candidates that the caller has ALREADY checked are eligible:
 * registered, ACTIVE, at list price, on `monthlyPlanId`, with no unresolved claim.
 */
export function buildAnnualOfferAction(input: {
  strategy: Strategy; listPrice: number; productId: string; monthlyPlanId: string; offerWindowDays: number; eligible: AnnualOfferCandidate[];
}): AnnualOfferAction {
  const iv = input.strategy.intervention;
  if (iv.kind !== "annual_plan") throw new Error("Not an annual-plan strategy.");
  const listPrice = input.listPrice.toFixed(2);
  const targets = input.eligible
    .filter((s) => (iv.segments as readonly string[]).includes(s.segment))
    .slice(0, MAX_ANNUAL_TARGETS)
    .map(({ subscriptionId, label, segment, reason, createdAt }) => ({ subscriptionId, registration: { label, segment, reason, createdAt } }));
  if (targets.length === 0) throw new Error(`No eligible subscribers in segments ${iv.segments.join(", ")}.`);
  const cents = annualPriceCents(listPrice, iv.discountPct);
  if (cents === null) throw new Error("Invalid list price.");
  return AnnualOfferActionSchema.parse({
    type: "annual_plan_offer", productId: input.productId, monthlyPlanId: input.monthlyPlanId, currency: "USD",
    listPrice, discountPct: iv.discountPct, annualPrice: money(cents), offerWindowDays: input.offerWindowDays,
    segments: [...iv.segments], targets,
  });
}

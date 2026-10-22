import { z } from "zod";
import { SEGMENTS } from "./types";

// Interventions the twin can simulate. Bounds are commercial guardrails enforced server-side,
// whether the strategy came from the merchant or from the AI agent.

const SegmentSchema = z.enum(SEGMENTS);

export const InterventionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline") }),
  z.object({
    kind: z.literal("targeted_discount"),
    segment: SegmentSchema,
    /** "price" targets only subscribers whose main leaving reason is price. */
    reason: z.enum(["price", "any"]),
    discountPct: z.number().min(5).max(50),
    months: z.number().int().min(1).max(12),
  }),
  z.object({
    kind: z.literal("list_price_change"),
    newPrice: z.number().min(5).max(200),
  }),
  z.object({
    kind: z.literal("annual_plan"),
    discountPct: z.number().min(0).max(40),
    segments: z.array(SegmentSchema).min(1).max(SEGMENTS.length),
  }),
]);
export type Intervention = z.infer<typeof InterventionSchema>;

export const StrategySchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1).max(80),
  intervention: InterventionSchema,
  rationale: z.string().max(600).optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const BASELINE: Strategy = {
  id: "baseline",
  name: "Do nothing (baseline)",
  intervention: { kind: "baseline" },
};

/** Which PayPal operation, if any, would realise an intervention. Keeps the twin honest about executability. */
export function paypalActionFor(intervention: Intervention): string | null {
  switch (intervention.kind) {
    case "baseline":
      return null;
    case "targeted_discount":
      return "PATCH /v1/billing/subscriptions/{id}: per-subscriber fixed_price override (no buyer consent required; billing within 10 days unaffected)";
    case "list_price_change":
      return "POST /v1/billing/plans/{id}/update-pricing-schemes: applies to existing and future subscriptions (billing within 10 days unaffected)";
    case "annual_plan":
      return "POST /v1/billing/plans: new annual plan; each subscriber must approve switching via PayPal";
  }
}

export function describeIntervention(intervention: Intervention, listPrice: number): string {
  switch (intervention.kind) {
    case "baseline":
      return "Keep current pricing and offers.";
    case "targeted_discount": {
      const who = `${intervention.segment.replaceAll("_", " ")} subscribers${intervention.reason === "price" ? " leaving over price" : ""}`;
      return `Offer ${who} ${intervention.discountPct}% off ($${(listPrice * (1 - intervention.discountPct / 100)).toFixed(2)}/mo) for ${intervention.months} month(s).`;
    }
    case "list_price_change":
      return `Change the list price from $${listPrice.toFixed(2)} to $${intervention.newPrice.toFixed(2)}/mo for all subscribers.`;
    case "annual_plan":
      return `Offer ${intervention.segments.join(", ").replaceAll("_", " ")} subscribers an annual prepay plan at ${intervention.discountPct}% off ($${(listPrice * 12 * (1 - intervention.discountPct / 100)).toFixed(2)}/yr).`;
  }
}

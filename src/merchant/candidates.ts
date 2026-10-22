import type { Strategy } from "@/twin/interventions";

// A starting set of strategies spanning the intervention space. The AI agent proposes its own;
// these keep the comparison useful without it.
export const STARTER_STRATEGIES: Strategy[] = [
  {
    id: "at-risk-20-3m",
    name: "At-risk: 20% off for 3 months (6-month campaign)",
    intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3, campaignMonths: 6 },
  },
  {
    id: "cancel-price-25-3m",
    name: "Cancel-flow save offer: 25% off for 3 months to price-driven leavers (6-month campaign)",
    intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 6 },
  },
  {
    id: "annual-15",
    name: "Annual prepay at 15% off",
    intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] },
  },
  {
    id: "list-22",
    name: "Cut list price to $22",
    intervention: { kind: "list_price_change", newPrice: 22 },
  },
  {
    id: "list-27",
    name: "Raise list price to $27",
    intervention: { kind: "list_price_change", newPrice: 27 },
  },
];

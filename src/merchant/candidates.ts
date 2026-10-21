import type { Strategy } from "@/twin/interventions";

// A starting set of strategies spanning the intervention space. The AI agent proposes its own;
// these keep the comparison useful without it.
export const STARTER_STRATEGIES: Strategy[] = [
  {
    id: "at-risk-20-3m",
    name: "At-risk: 20% off for 3 months",
    intervention: { kind: "targeted_discount", segment: "at_risk", discountPct: 20, months: 3 },
  },
  {
    id: "at-risk-35-2m",
    name: "At-risk: 35% off for 2 months",
    intervention: { kind: "targeted_discount", segment: "at_risk", discountPct: 35, months: 2 },
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

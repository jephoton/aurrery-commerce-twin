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
    name: "Price-driven cancel save: 25% off for 3 months (6-month campaign)",
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

const MIN_LIST_PRICE = 5;
const MAX_LIST_PRICE = 200;

const listPriceStrategy = (verb: "Cut" | "Raise", price: number): Strategy => ({
  id: `list-${price}`,
  name: `${verb} list price to $${price}`,
  intervention: { kind: "list_price_change", newPrice: price },
});

/**
 * The starter set for a merchant's list price. List-price candidates scale with it (−1/12 and +1/8,
 * in whole dollars), so Ridgeline's $24 gives exactly STARTER_STRATEGIES. A candidate is dropped when
 * it falls outside the $5–$200 guardrail or does not move the price. Without classified feedback
 * (`reasonTargeting: false`), price-reason targeting is dropped.
 */
export function starterStrategiesFor(listPrice: number, options: { reasonTargeting?: boolean } = {}): Strategy[] {
  const inRange = (price: number) => price >= MIN_LIST_PRICE && price <= MAX_LIST_PRICE;
  const down = Math.round((listPrice * 11) / 12);
  const up = Math.round((listPrice * 9) / 8);
  return STARTER_STRATEGIES.flatMap((s): Strategy[] => {
    const iv = s.intervention;
    if (iv.kind === "targeted_discount" && iv.reason === "price" && options.reasonTargeting === false) return [];
    if (iv.kind !== "list_price_change") return [s];
    // STARTER_STRATEGIES holds one cut ($22) and one rise ($27) from Ridgeline's $24.
    if (iv.newPrice < 24) return inRange(down) && down < listPrice ? [listPriceStrategy("Cut", down)] : [];
    return inRange(up) && up > listPrice ? [listPriceStrategy("Raise", up)] : [];
  });
}

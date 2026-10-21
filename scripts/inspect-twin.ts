// Prints a comparison of sample strategies on the demo twin, for sanity-checking the model.
import { buildDemoTwin } from "@/merchant/demo";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies } from "@/twin/simulate";

const { twin } = buildDemoTwin();
console.log("initial", twin.initialActive, "acq", twin.params.monthlyAcquisition);
console.log("churn", Object.fromEntries(Object.entries(twin.params.segments).map(([k, v]) => [k, betaMean(v.monthlyChurn).toFixed(4)])));
const t0 = performance.now();
const r = compareStrategies(twin, [
  { id: "d20", name: "at-risk 20% x3", intervention: { kind: "targeted_discount", segment: "at_risk", discountPct: 20, months: 3 } },
  { id: "d35", name: "at-risk 35% x2", intervention: { kind: "targeted_discount", segment: "at_risk", discountPct: 35, months: 2 } },
  { id: "ps15", name: "price-sens 15% x3", intervention: { kind: "targeted_discount", segment: "price_sensitive", discountPct: 15, months: 3 } },
  { id: "cut22", name: "list $22", intervention: { kind: "list_price_change", newPrice: 22 } },
  { id: "rise27", name: "list $27", intervention: { kind: "list_price_change", newPrice: 27 } },
  { id: "annual", name: "annual 15%", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core", "price_sensitive"] } },
], { runs: 1000 });
console.log("ms", Math.round(performance.now() - t0));
const f = (x: number) => Math.round(x).toLocaleString();
for (const s of r.strategies) {
  const m = s.metrics, d = s.vsBaseline;
  console.log(s.strategy.name.padEnd(20), "GP", f(m.grossProfit.p50), "ΔGP p10/p50/p90", f(d.grossProfit.p10), f(d.grossProfit.p50), f(d.grossProfit.p90),
    "P(worse)", s.probProfitBelowBaseline.toFixed(2), "ΔValue p10/p50/p90", f(d.totalValue.p10), f(d.totalValue.p50), f(d.totalValue.p90), "P(value worse)", s.probValueBelowBaseline.toFixed(2), "endActive", f(m.endingActive.p50), "ΔendActive", f(d.endingActive.mean), "ΔvolChurn", f(d.voluntaryChurn.mean), "discount$", f(m.discountCost.mean));
}

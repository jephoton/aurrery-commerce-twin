// Prints the starter strategy comparison and stress tests on the demo twin.
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildDemoTwin } from "@/merchant/demo";
import { betaMean } from "@/twin/calibrate";
import { compareStrategies } from "@/twin/simulate";
import { stressTest, type StressResult } from "@/twin/stress";

const { twin } = buildDemoTwin();
console.log("initial", twin.initialActive);
console.log("churn", Object.fromEntries(Object.entries(twin.params.segments).map(([k, v]) => [k, betaMean(v.monthlyChurn).toFixed(4)])));

const f = (x: number) => Math.round(x).toLocaleString();
const comparison = compareStrategies(twin, STARTER_STRATEGIES);
console.log("options", comparison.options);
for (const s of comparison.strategies) {
  const d = s.vsBaseline.totalValue;
  console.log(
    s.strategy.name.padEnd(65),
    "ΔValue p10/p50/p90", f(d.p10), f(d.p50), f(d.p90),
    "P(worse)", s.probValueBelowBaseline.toFixed(2),
    "discount$", f(s.metrics.discountCost.mean),
  );
}
for (const strategy of STARTER_STRATEGIES) {
  const st: StressResult = stressTest(twin, strategy);
  console.log("stress", strategy.name.padEnd(65), "ΔValue p50", f(st.base.vsBaseline.totalValue.p50), "→", f(st.stressed.vsBaseline.totalValue.p50), "|", st.shifted.join("; "));
}

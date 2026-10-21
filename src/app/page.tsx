import { Lab, type MerchantSummary } from "@/components/Lab";
import { currentMerchant } from "@/merchant";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { betaMean } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";

export default function Home() {
  const { twin, history } = currentMerchant();
  const lastMonth = history.segments.at(-1)!.month;
  const recent = history.segments.filter((r) => r.month === lastMonth);
  const startActive = recent.reduce((s, r) => s + r.activeAtStart, 0);
  const churned = recent.reduce((s, r) => s + r.voluntaryChurn + r.involuntaryChurn, 0);
  const active = SEGMENTS.reduce((s, seg) => s + twin.initialActive[seg], 0);

  const summary: MerchantSummary = {
    name: twin.merchant.name,
    description: twin.merchant.description,
    planName: twin.merchant.planName,
    asOfMonth: twin.asOfMonth,
    listPrice: twin.params.listPrice,
    active,
    mrr: active * twin.params.listPrice,
    lastMonthChurnRate: churned / startActive,
    segments: SEGMENTS.map((s) => ({
      id: s,
      label: twin.params.segments[s].label,
      active: twin.initialActive[s],
      churn: betaMean(twin.params.segments[s].monthlyChurn),
    })),
    provenance: twin.provenance,
  };

  return <Lab summary={summary} starterStrategies={STARTER_STRATEGIES} />;
}

import { Lab, type MerchantSummary } from "@/components/Lab";
import { observedMerchant } from "@/merchant/observed";
import { connection } from "next/server";
import { Suspense } from "react";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { betaMean } from "@/twin/calibrate";
import { SEGMENTS } from "@/twin/types";
import { simulationRuns } from "@/hosting/simulation-budget";

export default function Home() {
  return <Suspense fallback={<main className="p-6" aria-busy="true">Loading merchant evidence…</main>}><ObservedHome /></Suspense>;
}

async function ObservedHome() {
  await connection();
  const { twin, history, evidence, changes } = await observedMerchant();
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
    observedEvidence: evidence,
    parameterChanges: changes,
  };

  return <Lab summary={summary} starterStrategies={STARTER_STRATEGIES} simulationRuns={simulationRuns()} />;
}

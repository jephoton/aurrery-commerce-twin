import { Lab } from "@/components/Lab";
import { observedMerchant } from "@/merchant/observed";
import { connection } from "next/server";
import { Suspense } from "react";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { summarizeMerchant } from "@/merchant/summary";
import { simulationRuns } from "@/hosting/simulation-budget";

export default function Home() {
  return <Suspense fallback={<main className="p-6" aria-busy="true">Loading merchant evidence…</main>}><ObservedHome /></Suspense>;
}

async function ObservedHome() {
  await connection();
  const { twin, history, evidence, changes, annual } = await observedMerchant();
  const summary = summarizeMerchant(twin, history, { observedEvidence: evidence, parameterChanges: changes, annualEvidence: annual });
  return <Lab summary={summary} starterStrategies={STARTER_STRATEGIES} simulationRuns={simulationRuns()} />;
}

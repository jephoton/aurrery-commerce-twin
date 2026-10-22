import { listSandboxSubscribers } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/setup";
import { evaluateComparison, evaluateProvider, parseEvaluationArgs, writeEvaluationArtifacts, type ProviderEvaluation } from "@/signals/evaluate";

function printEvaluation(result: ProviderEvaluation): void {
  const percent = (value: number) => `${(100 * value).toFixed(1)}%`;
  const { score } = result;
  console.log(`${result.provider}/${result.model}: schema ${percent(score.schemaValidRate)}, accepted ${percent(score.acceptedCoverage)}, whole-corpus joint ${percent(score.wholeCorpusAgreement.joint)}, suitable=${score.suitable}`);
  console.log("agreement", JSON.stringify({ accepted: score.acceptedAgreement, wholeCorpus: score.wholeCorpusAgreement, confusion: score.confusion }));
  console.log("pilots", JSON.stringify({ checks: score.pilotChecks, ...result.pilots }));
  console.log("usage", JSON.stringify({ meaning: result.usageMeaning, accountTier: result.accountTier, freeCapacityEvidence: result.freeCapacityEvidence, tokens: result.metrics.usage, httpLatencyMs: Math.round(result.metrics.latencyMs), elapsedMs: Math.round(result.elapsedMs), retries: result.metrics.retries, cache: result.cache }));
  console.log("errors/quota", JSON.stringify(result.metrics.attempts.map(({ status, quota, quotaViolations, error }) => ({ status, quota, quotaViolations, error }))));
  console.log("tool smoke", JSON.stringify({ passed: result.tool.passed, skipped: result.tool.skipped ?? false, reason: result.tool.reason, observedState: result.tool.observedState, error: result.tool.error }));
  if (result.roundTrip.available) {
    console.log("simulated round trip", JSON.stringify({ source: result.roundTrip.source, options: result.roundTrip.options, changeInMedianTotalValue: result.roundTrip.changeInMedianTotalValue }));
    for (const updated of result.roundTrip.updated.strategies) {
      const base = result.roundTrip.base.strategies.find(({ id }) => id === updated.id)!;
      console.log(JSON.stringify({ strategy: updated.name, base: { value: base.metrics.totalValue, vsBaseline: base.vsBaseline.totalValue, chanceWorse: base.probValueBelowBaseline }, updated: { value: updated.metrics.totalValue, vsBaseline: updated.vsBaseline.totalValue, chanceWorse: updated.probValueBelowBaseline } }));
    }
  } else console.log(`simulated round trip unavailable: ${result.roundTrip.reason}`);
}

async function main(): Promise<void> {
  const options = parseEvaluationArgs(process.argv.slice(2));
  const registryRows = listSandboxSubscribers();
  const labels = PILOT_COHORT.map(({ label }) => label);
  console.log(`Signals ${options.providers.length === 1 ? "diagnostic" : "comparison"}: ${options.providers.join(" then ")}; ${options.useCache ? "cache reuse enabled" : "fresh calls"}; batch pacing ${options.batchDelayMs}ms.`);
  const comparison = await evaluateComparison(options, async (provider, evaluationOptions) => {
    console.log(`${provider}: starting classification`);
    const result = await evaluateProvider({ provider }, {
      ...evaluationOptions, registryRows, labels,
      onProgress(event) {
        if (event.kind === "delay") console.log(`${event.provider}/${event.model}: proactive batch pacing ${event.delayMs}ms`);
        else console.log(`${event.provider}/${event.model}: batch ${event.batch.index + 1}, accepted ${event.batch.accepted.length}/${event.batch.inputIds.length}${event.batch.error ? `, error=${event.batch.error.category}` : ""}`);
      },
    });
    printEvaluation(result);
    return result;
  });
  const paths = await writeEvaluationArtifacts(comparison);
  for (const [index, path] of paths.entries()) console.log(`${comparison.results[index].provider}: artifact ${path}`);
  for (const result of comparison.results) if ("failure" in result) console.error(`${result.provider}: ${result.failure}; details suppressed to protect credentials.`);
  console.log("qualifying fresh candidates", JSON.stringify(comparison.qualifyingCandidates));
  console.log(comparison.rankingBasis);
  console.log("Provider selection remains pending review; runtime configuration is unchanged.");
  process.exitCode = comparison.exitCode;
}

main().catch(() => {
  console.error("Evaluation could not complete. Check supported flags, local registry access and artifact directory permissions; exception details are suppressed to protect credentials.");
  process.exitCode = 1;
});

import "server-only";
import { selectedProvider } from "@/agent/model";
import { selectedAgentRateProfile } from "@/agent/limits";
import { hostedConfig } from "./config";
import { simulationRuns } from "./simulation-budget";

/** Runtime only: neither a build prerequisite nor a provider connectivity test. */
export function deploymentConfiguration(env: Record<string, string | undefined> = process.env): void {
  try {
    const config = hostedConfig(env);
    if (!config.hosted) return;
    const selected = selectedProvider(env);
    if (!env.PAYPAL_CLIENT_ID?.trim() || !env.PAYPAL_CLIENT_SECRET?.trim()) throw new Error();
    selectedAgentRateProfile(selected.provider, env);
    simulationRuns(env);
    // PAYPAL_WEBHOOK_ID is deliberately optional until the deployed URL is registered.
  } catch { throw new Error("Invalid hosted configuration"); }
}

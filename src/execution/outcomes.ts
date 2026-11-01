import type { Proposal } from "@/ledger/proposals";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";

// Shared execution results. No secrets: an annual offer's approval link never appears here.

export interface TargetOutcome {
  subscriptionId: string;
  ok: boolean;
  skipped?: boolean;
  httpStatus: number | null;
  debugId: string | null;
  verified: boolean;
  observed: Pick<SubscriptionSnapshot, "status" | "regularPrice" | "planOverridden" | "nextBillingTime"> | null;
  error: string | null;
  /** Present when an annual-plan offer was issued. The switch itself is verified only by later reads. */
  offer?: { annualPlanId: string; expiresAt: string };
}
export interface ExecutionReport { proposal: Proposal; outcomes: TargetOutcome[] }

export class ExecutionReconciliationRequired extends Error {
  constructor(readonly proposalId: string) { super("Approval or execution outcome is unconfirmed; reconcile the ledger and PayPal before any further action."); this.name = "ExecutionReconciliationRequired"; }
}

/** Client errors PayPal rejects before mutating: the single definitive-failure rule (decision 0008). */
export const DEFINITIVE_HTTP_FAILURES: readonly number[] = [400, 401, 403, 404, 422];
export const isDefinitiveFailure = (httpStatus: number | null): boolean => httpStatus !== null && DEFINITIVE_HTTP_FAILURES.includes(httpStatus);

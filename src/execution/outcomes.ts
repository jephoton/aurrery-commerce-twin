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
  /** Why a price change was refused before any PATCH; read this marker, never the error wording. */
  refused?: RefusalReason;
  /** Present when an annual-plan offer was issued. The switch itself is verified only by later reads. */
  offer?: { annualPlanId: string; expiresAt: string };
}
/** A subscriber on a recorded annual plan, or one whose plan PayPal did not report while annual plans exist. */
export type RefusalReason = "annual_plan" | "plan_unknown";
export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  annual_plan: "On an annual plan by customer choice; the price was not changed.",
  plan_unknown: "PayPal did not report the subscription's plan, so it may be on an annual plan; the price was not changed.",
};
/** Why a price change must be refused for a subscription on this plan, or null. Once any annual plan exists, a plan PayPal did not report cannot be proven monthly. */
export const annualRefusal = (planId: string | null, annualPlans: ReadonlySet<string>): RefusalReason | null =>
  annualPlans.size > 0 && !planId ? "plan_unknown" : planId && annualPlans.has(planId) ? "annual_plan" : null;
/** The status column of an execution report: a refusal's reason, else the read-back status, else the error. */
export const outcomeStatusText = (outcome: TargetOutcome): string | null =>
  outcome.refused ? REFUSAL_TEXT[outcome.refused] : outcome.observed?.status ?? outcome.error;
export interface ExecutionReport { proposal: Proposal; outcomes: TargetOutcome[] }

export class ExecutionReconciliationRequired extends Error {
  constructor(readonly proposalId: string) { super("Approval or execution outcome is unconfirmed; reconcile the ledger and PayPal before any further action."); this.name = "ExecutionReconciliationRequired"; }
}

/** Client errors PayPal rejects before mutating: the single definitive-failure rule (decision 0008). */
export const DEFINITIVE_HTTP_FAILURES: readonly number[] = [400, 401, 403, 404, 422];
export const isDefinitiveFailure = (httpStatus: number | null): boolean => httpStatus !== null && DEFINITIVE_HTTP_FAILURES.includes(httpStatus);

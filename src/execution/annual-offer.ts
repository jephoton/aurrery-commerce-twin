import "server-only";
import { annualIneligibility, annualPlanMismatch, INELIGIBILITY_TEXT, type AnnualOfferAction } from "@/ledger/annual-offer-action";
import { offerExpiry } from "@/ledger/annual-offer-status";
import type { IssuedOffer } from "@/ledger/annual-offers";
import type { Proposal } from "@/ledger/proposals";
import type { PayPalFailure } from "@/paypal/client";
import type { PlanSnapshot, ReviseOffer } from "@/paypal/plans";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";
import { ExecutionReconciliationRequired, isDefinitiveFailure, type ExecutionReport, type TargetOutcome } from "./outcomes";

// Approach A: the proposal succeeds when offers are issued; the offer tracker follows each customer.
// PayPal calls run outside transactions. revise mints a new approval token on every call and takes no
// request ID (decision 0008), so it is called at most once per target and never retried. The approval
// link is handed only to recordOffer; it never enters an outcome, error, request record or audit entry.

export interface AnnualExecution { id: string; actionHash: string; action: AnnualOfferAction }
export interface AnnualDependencies {
  /** The registered monthly plan (`paypal.plan_id` setting). */
  monthlyPlanSetting: () => Promise<string | null>;
  getPlan: (planId: string) => Promise<Result<PlanSnapshot>>;
  createPlan: (input: { productId: string; annualPrice: string; currency: "USD"; requestId: string; name: string; description: string }) => Promise<Result<PlanSnapshot>>;
  read: (subscriptionId: string) => Promise<Result<SubscriptionSnapshot>>;
  revise: (input: { subscriptionId: string; planId: string; returnUrl: string }) => Promise<Result<ReviseOffer>>;
  /** Claim, registration snapshot, monthly-plan setting and open-offer check on the ledger. */
  validateTarget: (subscriptionId: string) => Promise<boolean>;
  recordObservation: (snapshot: SubscriptionSnapshot, source: string) => Promise<void>;
  recordPlan: (plan: PlanSnapshot, debugId: string | null) => Promise<void>;
  /** The only destination of an approval link (recordAnnualOffer). */
  recordOffer: (offer: IssuedOffer) => Promise<unknown>;
  /** A target that received no offer (recordAnnualTarget). */
  recordTarget: (request: unknown, outcome: TargetOutcome) => Promise<void>;
  finish: (status: "succeeded" | "partially_failed" | "failed", summary: { succeeded: number; total: number }) => Promise<void>;
  get: () => Promise<Proposal>;
  now: () => Date;
  returnUrl: string;
}

/** Deterministic per approved action: a repeated create returns PayPal's original plan within its retention window. */
export const annualPlanRequestId = (actionHash: string) => `aurrery-annual-${actionHash}`;
const OPERATOR_NOTE = "Unresolved: do not retry revise. Reconcile by reading the subscription in PayPal (runbook: annual offers).";

/** PayPal's own message, unless it carries anything link-like; approval links must never reach outcomes. */
const failureText = (error: PayPalFailure) =>
  /ba_token|https?:\/\//i.test(error.message) ? `${error.name} (PayPal's message was withheld because it contained a link)` : `${error.name}: ${error.message}`;

type EnsuredPlan = { plan: PlanSnapshot; debugId: string | null } | { reason: string };

async function ensurePlan({ action, actionHash }: AnnualExecution, deps: AnnualDependencies): Promise<EnsuredPlan> {
  if ((await deps.monthlyPlanSetting()) !== action.monthlyPlanId) return { reason: "The registered monthly plan changed after approval" };
  const monthly = await deps.getPlan(action.monthlyPlanId);
  if (!monthly.ok) return { reason: `The monthly plan could not be read (${monthly.error.name})` };
  if (monthly.value.productId !== action.productId) return { reason: "The monthly plan belongs to another product" };
  const created = await deps.createPlan({
    productId: action.productId, annualPrice: action.annualPrice, currency: action.currency, requestId: annualPlanRequestId(actionHash),
    name: `Annual prepay (${action.discountPct}% off)`, description: `One prepaid year at ${action.annualPrice} USD`,
  });
  if (!created.ok) return { reason: `The annual plan could not be created (${created.error.name})` };
  const readBack = await deps.getPlan(created.value.planId);
  if (!readBack.ok) return { reason: `The annual plan could not be read back (${readBack.error.name})` };
  const mismatch = readBack.value.planId !== created.value.planId ? "plan id" : annualPlanMismatch(readBack.value, action);
  if (mismatch) return { reason: `The annual plan read back with a different ${mismatch}` };
  return { plan: readBack.value, debugId: readBack.debugId };
}

/** Exported for offline tests; production wiring supplies the ledger and PayPal adapters. */
export async function executeAnnualOfferWith(proposal: AnnualExecution, deps: AnnualDependencies): Promise<ExecutionReport> {
  const { action } = proposal;
  const outcomes: TargetOutcome[] = [];
  const reconcile = (error?: unknown): never => {
    throw error instanceof ExecutionReconciliationRequired ? error : new ExecutionReconciliationRequired(proposal.id);
  };
  const refuse = (subscriptionId: string, error: string, extra: Partial<TargetOutcome> = {}): TargetOutcome =>
    ({ subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false, observed: null, error, ...extra });
  const record = async (request: unknown, outcome: TargetOutcome) => {
    try { await deps.recordTarget(request, outcome); } catch (error) { reconcile(error); }
    outcomes.push(outcome);
  };
  const finish = async (): Promise<ExecutionReport> => {
    const issued = outcomes.filter((outcome) => outcome.ok && outcome.offer).length;
    const status = issued === action.targets.length ? "succeeded" : issued === 0 ? "failed" : "partially_failed";
    try {
      await deps.finish(status, { succeeded: issued, total: action.targets.length });
      return { proposal: await deps.get(), outcomes };
    } catch (error) { return reconcile(error); }
  };

  let ensured: EnsuredPlan;
  try { ensured = await ensurePlan(proposal, deps); } catch (error) { return reconcile(error); }
  if ("reason" in ensured) {
    // Nothing customer-facing has happened yet, so the proposal fails cleanly (an orphan plan is harmless).
    for (const { subscriptionId } of action.targets) {
      await record({ subscriptionId, step: "annual_plan" }, refuse(subscriptionId, `${ensured.reason}; no offer was made.`));
    }
    return finish();
  }
  try { await deps.recordPlan(ensured.plan, ensured.debugId); } catch (error) { reconcile(error); }
  const annualPlanId = ensured.plan.planId;

  for (const target of action.targets) {
    const { subscriptionId } = target;
    const request = { subscriptionId, operation: "revise", planId: annualPlanId };
    let current: SubscriptionSnapshot | null = null;
    try {
      if (await deps.validateTarget(subscriptionId)) {
        const read = await deps.read(subscriptionId);
        if (!read.ok) return reconcile();
        current = read.value;
        await deps.recordObservation(current, "paypal.execution_preread");
      }
    } catch (error) { return reconcile(error); }
    if (!current) {
      await record(request, refuse(subscriptionId, "Registration, claim or open offer changed before the PayPal read; no offer was made."));
      continue;
    }
    const observed = { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime };
    const ineligible = annualIneligibility(current, { subscriptionId, monthlyPlanId: action.monthlyPlanId, listPrice: action.listPrice });
    if (ineligible) { await record(request, refuse(subscriptionId, INELIGIBILITY_TEXT[ineligible], { observed })); continue; }
    let authorized = false;
    try { authorized = await deps.validateTarget(subscriptionId); } catch (error) { return reconcile(error); }
    if (!authorized) {
      await record(request, refuse(subscriptionId, "Registration, claim or open offer changed after the PayPal read; no offer was made.", { observed }));
      continue;
    }

    let revised: Result<ReviseOffer>;
    try { revised = await deps.revise({ subscriptionId, planId: annualPlanId, returnUrl: deps.returnUrl }); } catch (error) { return reconcile(error); }
    if (!revised.ok) {
      const outcome = refuse(subscriptionId, failureText(revised.error), { httpStatus: revised.error.httpStatus, debugId: revised.error.debugId, observed });
      if (isDefinitiveFailure(revised.error.httpStatus)) { await record(request, outcome); continue; }
      // PayPal may have minted an approval token Aurrery does not hold (including HTTP 200 without a usable link).
      await record(request, { ...outcome, error: `${outcome.error} ${OPERATOR_NOTE}` });
      return reconcile();
    }
    if (revised.value.planId !== null && revised.value.planId !== annualPlanId) {
      await record(request, refuse(subscriptionId, `PayPal reported another plan for the switch; the link was not stored. ${OPERATOR_NOTE}`,
        { httpStatus: revised.value.httpStatus, debugId: revised.debugId, observed }));
      return reconcile();
    }
    try {
      const offeredAt = deps.now().toISOString();
      const expiresAt = offerExpiry(offeredAt, action.offerWindowDays);
      const outcome: TargetOutcome = { subscriptionId, ok: true, httpStatus: revised.value.httpStatus, debugId: revised.debugId, verified: false, observed, error: null, offer: { annualPlanId, expiresAt } };
      await deps.recordOffer({ proposalId: proposal.id, subscriptionId, segment: target.registration.segment, annualPlanId, approvalUrl: revised.value.approvalUrl, offeredAt, expiresAt, request, outcome });
      outcomes.push(outcome);
    } catch (error) { return reconcile(error); }
  }
  return finish();
}

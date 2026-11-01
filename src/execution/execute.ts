import "server-only";
import { now } from "@/ledger/db";
import { runtimeLedgerConnection, type LedgerConnection } from "@/ledger/connection";
import { auditOn, authoritativeWrite } from "@/ledger/operations";
import { claimForExecution, finishExecution, getProposal, validateTargetForExecution, ProposalError, type Proposal } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type SubscriptionSnapshot } from "@/paypal/subscriptions";
import { sameUsdAmount, usdCents } from "@/paypal/prices";
import { PriceOverrideActionSchema } from "@/ledger/proposals";
import { REASONS, SEGMENTS } from "@/twin/types";
import { SUBSCRIBER_MONTH_MS } from "@/ledger/discount-outcomes";
import { listAnnualPlanIds, recordAnnualOffer, recordAnnualPlan, recordAnnualTarget } from "@/ledger/annual-offers";
import { getSetting } from "@/ledger/operations";
import { createAnnualPlan, getPlan, reviseToPlan } from "@/paypal/plans";
import { hostedConfig } from "@/hosting/config";
import { ExecutionReconciliationRequired, isDefinitiveFailure, type ExecutionReport, type TargetOutcome } from "./outcomes";
import { executeAnnualOfferWith, type AnnualDependencies } from "./annual-offer";
export { ExecutionReconciliationRequired, type ExecutionReport, type TargetOutcome } from "./outcomes";

// PayPal calls run outside a transaction. Storage acknowledgement failure leaves the claim
// unresolved; an operator must reconcile PayPal before any further mutation.
const OPERATION = "PATCH subscription fixed_price";

type Dependencies = {
  claim: typeof claimForExecution;
  get: typeof getProposal;
  finish: typeof finishExecution;
  patch: typeof overrideSubscriptionPrice;
  read: typeof getSubscription;
  record: (id: string, request: unknown, outcome: TargetOutcome, snapshot: SubscriptionSnapshot | null) => Promise<void>;
  recordObservation?: typeof recordObservation;
  validateTarget?: typeof validateTargetForExecution;
  /** Ledger and PayPal adapters for an annual offer; built only after its claim succeeds. */
  annual?: (proposal: Proposal) => AnnualDependencies;
  /** Yearly plans offers were made on; a subscriber on one switched by customer choice and is never re-priced. */
  annualPlanIds?: () => Promise<ReadonlySet<string>>;
};

export async function recordTarget(id: string, request: unknown, outcome: TargetOutcome, snapshot: SubscriptionSnapshot | null, connection?: LedgerConnection, recordedAt = now()): Promise<void> {
  connection ??= await runtimeLedgerConnection();
  await authoritativeWrite(connection, async (tx) => {
    const observation = snapshot ? await tx.execute(
      `INSERT INTO observations (subscription_id, observed_at, status, regular_price, plan_overridden, last_payment_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [snapshot.id, recordedAt, snapshot.status, snapshot.regularPrice, snapshot.planOverridden ? 1 : 0, JSON.stringify(snapshot.lastPayment), "paypal.get_subscription"],
    ) : null;
    const execution = await tx.execute(
      `INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, http_status, debug_id, response_json, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, outcome.subscriptionId, OPERATION, JSON.stringify(request), outcome.ok ? 1 : 0, outcome.httpStatus, outcome.debugId, JSON.stringify(outcome), outcome.verified ? 1 : 0, recordedAt],
    );
    if (outcome.ok && outcome.verified && snapshot?.status === "ACTIVE" && snapshot.id === outcome.subscriptionId && observation) {
      const stored = (await tx.query("SELECT action_json FROM proposals WHERE id=?", [id]))[0];
      const action = PriceOverrideActionSchema.safeParse(JSON.parse(String(stored?.action_json ?? "null")));
      const pilot = (await tx.query("SELECT segment,reason FROM sandbox_subscribers WHERE subscription_id=?", [outcome.subscriptionId]))[0];
      const discountedCents = action.success ? usdCents(action.data.newPrice) : null;
      const listCents = action.success ? usdCents(action.data.listPrice) : null;
      if (action.success && pilot && SEGMENTS.includes(pilot.segment as typeof SEGMENTS[number]) && REASONS.includes(pilot.reason as typeof REASONS[number]) &&
        pilot.segment === action.data.segment && (action.data.reason === "any" || pilot.reason === action.data.reason) &&
        action.data.targets.includes(snapshot.id) && sameUsdAmount(snapshot.regularPrice, action.data.newPrice) &&
        discountedCents !== null && listCents !== null && discountedCents < listCents) {
        await tx.execute(`INSERT INTO discount_episodes (execution_id,start_observation_id,subscription_id,segment,reason,started_at,ends_at,discounted_price) VALUES (?,?,?,?,?,?,?,?)`,
          [execution.lastInsertRowid!, observation.lastInsertRowid!, snapshot.id, String(pilot.segment), String(pilot.reason), recordedAt, new Date(Date.parse(recordedAt) + action.data.months * SUBSCRIBER_MONTH_MS).toISOString(), action.data.newPrice]);
      }
    }
    await auditOn(tx, "execution.target_recorded", id, { targetId: outcome.subscriptionId, ok: outcome.ok, verified: outcome.verified });
  });
}

/** Exported for offline failure-path tests. Never retry PayPal after an ambiguous result. */
export async function executeProposalWith(id: string, deps: Dependencies): Promise<ExecutionReport> {
  let proposal: Proposal;
  try { proposal = await deps.claim(id); }
  catch (error) { if (error instanceof ProposalError) throw error; throw new ExecutionReconciliationRequired(id); }
  const action = proposal.action;
  if (action.type === "annual_plan_offer") {
    // Claimed: a missing or misconfigured executor must never fall through to a price PATCH or a retry.
    let annual: AnnualDependencies;
    try {
      if (!deps.annual) throw new Error("Annual offer execution is not wired.");
      annual = deps.annual(proposal);
    } catch { throw new ExecutionReconciliationRequired(id); }
    return executeAnnualOfferWith({ id: proposal.id, actionHash: proposal.actionHash, action }, annual);
  }
  // Read after the claim's transaction has closed: the ledger read opens its own.
  let annualPlans: ReadonlySet<string>;
  try { annualPlans = await (deps.annualPlanIds?.() ?? Promise.resolve(new Set<string>())); }
  catch { throw new ExecutionReconciliationRequired(id); }
  const outcomes: TargetOutcome[] = [];
  const targets = action.type === "subscription_price_override"
    ? action.targets.map((subscriptionId) => ({ subscriptionId, expectedCurrentPrice: action.listPrice, listPrice: action.newPrice }))
    : action.type === "subscription_price_reset" ? action.targets.map((target) => ({ ...target, listPrice: action.canonicalListPrice })) : action.targets;
  for (const target of targets) {
    const { subscriptionId } = target;
    const requestedPrice = target.listPrice;
    const request = { subscriptionId, path: "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price", value: { currency_code: "USD", value: requestedPrice } };
    let current: SubscriptionSnapshot;
    try {
      if (deps.validateTarget && !(await deps.validateTarget(proposal, subscriptionId))) {
        const outcome: TargetOutcome = { subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false, observed: null, error: "Registration or verified action changed before mutation." };
        await deps.record(id, request, outcome, null);
        outcomes.push(outcome);
        continue;
      }
      const before = await deps.read(subscriptionId);
      if (!before.ok) throw new ExecutionReconciliationRequired(id);
      current = before.value;
      if (deps.recordObservation) await deps.recordObservation(current, "paypal.execution_preread");
    } catch { throw new ExecutionReconciliationRequired(id); }
    // Refused by plan, not price: a switched subscriber's yearly price can coincide with a captured one.
    if (current.planId !== null && annualPlans.has(current.planId)) {
      const outcome: TargetOutcome = { subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false,
        observed: { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime },
        error: "On an annual plan by customer choice; the price was not changed." };
      try { await deps.record(id, request, outcome, null); } catch { throw new ExecutionReconciliationRequired(id); }
      outcomes.push(outcome);
      continue;
    }
    if (action.type === "subscription_price_reset" && current.id === subscriptionId && current.status === "ACTIVE" && sameUsdAmount(current.regularPrice, requestedPrice)) {
      const outcome: TargetOutcome = { subscriptionId, ok: false, skipped: true, httpStatus: null, debugId: null, verified: false,
        observed: { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime },
        error: "Already at canonical list price; no PATCH sent." };
      try { await deps.record(id, request, outcome, null); } catch { throw new ExecutionReconciliationRequired(id); }
      outcomes.push(outcome);
      continue;
    }
    if (current.id !== subscriptionId || current.status !== "ACTIVE" || !sameUsdAmount(current.regularPrice, target.expectedCurrentPrice) ||
      (action.type === "subscription_price_revert" && !current.planOverridden)) {
      const outcome: TargetOutcome = { subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false,
        observed: { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime },
        error: "Current subscription did not match the approved price and status." };
      try { await deps.record(id, request, outcome, null); } catch { throw new ExecutionReconciliationRequired(id); }
      outcomes.push(outcome);
      continue;
    }
    try {
      if (deps.validateTarget && !(await deps.validateTarget(proposal, subscriptionId))) {
        const outcome: TargetOutcome = { subscriptionId, ok: false, httpStatus: null, debugId: null, verified: false,
          observed: { status: current.status, regularPrice: current.regularPrice, planOverridden: current.planOverridden, nextBillingTime: current.nextBillingTime },
          error: "Registration or verified action changed after the PayPal read." };
        await deps.record(id, request, outcome, null);
        outcomes.push(outcome);
        continue;
      }
    } catch { throw new ExecutionReconciliationRequired(id); }
    let patched: Awaited<ReturnType<typeof overrideSubscriptionPrice>>;
    try { patched = await deps.patch(subscriptionId, requestedPrice); }
    catch { throw new ExecutionReconciliationRequired(id); }
    const outcome: TargetOutcome = {
      subscriptionId,
      ok: patched.ok,
      httpStatus: patched.ok ? patched.value.httpStatus : patched.error.httpStatus,
      debugId: patched.ok ? patched.debugId : patched.error.debugId,
      verified: false,
      observed: null,
      error: patched.ok ? null : `${patched.error.name}: ${patched.error.message}`,
    };
    let snapshot: SubscriptionSnapshot | null = null;
    if (patched.ok) {
      let read: Awaited<ReturnType<typeof getSubscription>>;
      try { read = await deps.read(subscriptionId); }
      catch { throw new ExecutionReconciliationRequired(id); }
      if (read.ok) {
        snapshot = read.value;
        outcome.observed = { status: snapshot.status, regularPrice: snapshot.regularPrice, planOverridden: snapshot.planOverridden, nextBillingTime: snapshot.nextBillingTime };
        outcome.verified = snapshot.id === subscriptionId && snapshot.status === "ACTIVE" && sameUsdAmount(snapshot.regularPrice, requestedPrice);
      } else outcome.error = `Applied, but read-back failed: ${read.error.name}: ${read.error.message}`;
    }
    try { await deps.record(id, request, outcome, snapshot); }
    catch { throw new ExecutionReconciliationRequired(id); }
    outcomes.push(outcome);
    // Known client errors failed before mutation; uncertain failures and unverified successes stop.
    const knownFailure = !outcome.ok && isDefinitiveFailure(outcome.httpStatus);
    if (!knownFailure && (!outcome.ok || !outcome.verified)) throw new ExecutionReconciliationRequired(id);
  }
  const succeeded = outcomes.filter((outcome) => outcome.ok && outcome.verified).length;
  const completed = succeeded + outcomes.filter((outcome) => outcome.skipped).length;
  const status = completed === action.targets.length ? "succeeded" : completed === 0 ? "failed" : "partially_failed";
  const revertAfter = action.type === "subscription_price_override" && succeeded ? new Date(Date.now() + action.months * 30 * 86_400_000).toISOString() : null;
  try { await deps.finish(id, status, revertAfter, { succeeded, total: action.targets.length }); }
  catch { throw new ExecutionReconciliationRequired(id); }
  try { return { proposal: await deps.get(id), outcomes }; }
  catch { throw new ExecutionReconciliationRequired(id); }
}

/** Where PayPal returns a customer after approving or cancelling a switch: the hosted origin, or local APP_URL. */
export function annualReturnUrl(env: Record<string, string | undefined> = process.env): string {
  const config = hostedConfig(env);
  const url = new URL("/?paypal=annual", config.hosted ? config.origin : env.APP_URL ?? "http://localhost:3001");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The annual offer return URL must use http or https.");
  return url.toString();
}

const annualDependencies = (proposal: Proposal): AnnualDependencies => ({
  monthlyPlanSetting: () => getSetting("paypal.plan_id"),
  getPlan, createPlan: createAnnualPlan, read: getSubscription, revise: reviseToPlan,
  validateTarget: (subscriptionId) => validateTargetForExecution(proposal, subscriptionId),
  recordObservation: (snapshot, source) => recordObservation(snapshot, source),
  recordPlan: (plan, debugId) => recordAnnualPlan(proposal.id, plan, debugId),
  recordOffer: (offer) => recordAnnualOffer(offer),
  recordTarget: (request, outcome) => recordAnnualTarget(proposal.id, request, outcome),
  finish: (status, summary) => finishExecution(proposal.id, status, null, summary),
  get: () => getProposal(proposal.id),
  now: () => new Date(),
  // Resolved here, inside deps.annual(proposal): a configuration error becomes a reconciliation, never a half-run.
  returnUrl: annualReturnUrl(),
});

export const executeProposal = (id: string): Promise<ExecutionReport> => executeProposalWith(id, {
  claim: claimForExecution, get: getProposal, finish: finishExecution,
  patch: overrideSubscriptionPrice, read: getSubscription, record: recordTarget, recordObservation, validateTarget: validateTargetForExecution,
  annual: annualDependencies, annualPlanIds: () => listAnnualPlanIds(),
});

export async function recordObservation(s: SubscriptionSnapshot, source: string, connection?: LedgerConnection): Promise<void> {
  await authoritativeWrite(connection ?? await runtimeLedgerConnection(), async (tx) => {
    await tx.execute(
      `INSERT INTO observations (subscription_id, observed_at, status, regular_price, plan_overridden, last_payment_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [s.id, now(), s.status, s.regularPrice, s.planOverridden ? 1 : 0, JSON.stringify(s.lastPayment), source],
    );
  });
}

export async function listExecutions(proposalId: string, connection?: LedgerConnection): Promise<TargetOutcome[]> {
  return authoritativeWrite(connection ?? await runtimeLedgerConnection(), async (tx) => {
    const rows = await tx.query("SELECT response_json FROM executions WHERE proposal_id = ? ORDER BY id", [proposalId]);
    return rows.map((r) => JSON.parse(String(r.response_json)) as TargetOutcome);
  });
}

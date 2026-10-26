import "server-only";
import { now } from "@/ledger/db";
import { runtimeLedgerConnection, type LedgerConnection } from "@/ledger/connection";
import { auditOn, authoritativeWrite } from "@/ledger/operations";
import { claimForExecution, finishExecution, getProposal, ProposalError, type Proposal } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type SubscriptionSnapshot } from "@/paypal/subscriptions";

// PayPal calls run outside a transaction. Storage acknowledgement failure leaves the claim
// unresolved; an operator must reconcile PayPal before any further mutation.
export interface TargetOutcome {
  subscriptionId: string;
  ok: boolean;
  httpStatus: number | null;
  debugId: string | null;
  verified: boolean;
  observed: Pick<SubscriptionSnapshot, "status" | "regularPrice" | "planOverridden" | "nextBillingTime"> | null;
  error: string | null;
}
export interface ExecutionReport { proposal: Proposal; outcomes: TargetOutcome[] }
const OPERATION = "PATCH subscription fixed_price";

export class ExecutionReconciliationRequired extends Error {
  constructor(readonly proposalId: string) { super("Approval or execution outcome is unconfirmed; reconcile the ledger and PayPal before any further action."); this.name = "ExecutionReconciliationRequired"; }
}

type Dependencies = {
  claim: typeof claimForExecution;
  get: typeof getProposal;
  finish: typeof finishExecution;
  patch: typeof overrideSubscriptionPrice;
  read: typeof getSubscription;
  record: (id: string, request: unknown, outcome: TargetOutcome, snapshot: SubscriptionSnapshot | null) => Promise<void>;
};

async function recordTarget(id: string, request: unknown, outcome: TargetOutcome, snapshot: SubscriptionSnapshot | null): Promise<void> {
  const connection = await runtimeLedgerConnection();
  await authoritativeWrite(connection, async (tx) => {
    if (snapshot) await tx.execute(
      `INSERT INTO observations (subscription_id, observed_at, status, regular_price, plan_overridden, last_payment_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [snapshot.id, now(), snapshot.status, snapshot.regularPrice, snapshot.planOverridden ? 1 : 0, JSON.stringify(snapshot.lastPayment), "paypal.get_subscription"],
    );
    await tx.execute(
      `INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, http_status, debug_id, response_json, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, outcome.subscriptionId, OPERATION, JSON.stringify(request), outcome.ok ? 1 : 0, outcome.httpStatus, outcome.debugId, JSON.stringify(outcome), outcome.verified ? 1 : 0, now()],
    );
    await auditOn(tx, "execution.target_recorded", id, { targetId: outcome.subscriptionId, ok: outcome.ok, verified: outcome.verified });
  });
}

/** Exported for offline failure-path tests. Never retry PayPal after an ambiguous result. */
export async function executeProposalWith(id: string, deps: Dependencies): Promise<ExecutionReport> {
  let proposal: Proposal;
  try { proposal = await deps.claim(id); }
  catch (error) { if (error instanceof ProposalError) throw error; throw new ExecutionReconciliationRequired(id); }
  const action = proposal.action;
  const outcomes: TargetOutcome[] = [];
  for (const subscriptionId of action.targets) {
    const request = { subscriptionId, path: "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price", value: { currency_code: "USD", value: action.newPrice } };
    let patched: Awaited<ReturnType<typeof overrideSubscriptionPrice>>;
    try { patched = await deps.patch(subscriptionId, action.newPrice); }
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
        outcome.verified = snapshot.regularPrice !== null && Number(snapshot.regularPrice) === Number(action.newPrice);
      } else outcome.error = `Applied, but read-back failed: ${read.error.name}: ${read.error.message}`;
    }
    try { await deps.record(id, request, outcome, snapshot); }
    catch { throw new ExecutionReconciliationRequired(id); }
    outcomes.push(outcome);
    // Known client errors failed before mutation; uncertain failures and unverified successes stop.
    const knownFailure = !outcome.ok && [400, 401, 403, 404, 422].includes(outcome.httpStatus ?? 0);
    if (!knownFailure && (!outcome.ok || !outcome.verified)) throw new ExecutionReconciliationRequired(id);
  }
  const succeeded = outcomes.filter((outcome) => outcome.ok).length;
  const status = succeeded === action.targets.length ? "succeeded" : succeeded === 0 ? "failed" : "partially_failed";
  const revertAfter = succeeded ? new Date(Date.now() + action.months * 30 * 86_400_000).toISOString() : null;
  try { await deps.finish(id, status, revertAfter, { succeeded, total: action.targets.length }); }
  catch { throw new ExecutionReconciliationRequired(id); }
  try { return { proposal: await deps.get(id), outcomes }; }
  catch { throw new ExecutionReconciliationRequired(id); }
}

export const executeProposal = (id: string): Promise<ExecutionReport> => executeProposalWith(id, {
  claim: claimForExecution, get: getProposal, finish: finishExecution,
  patch: overrideSubscriptionPrice, read: getSubscription, record: recordTarget,
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

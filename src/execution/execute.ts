import "server-only";
import { now } from "@/ledger/db";
import { runtimeLedgerConnection, type LedgerConnection } from "@/ledger/connection";
import { auditOn, authoritativeWrite } from "@/ledger/operations";
import { claimForExecution, finishExecution, getProposal, ProposalError, type Proposal } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type SubscriptionSnapshot } from "@/paypal/subscriptions";
import { PriceOverrideActionSchema } from "@/ledger/proposals";
import { REASONS, SEGMENTS } from "@/twin/types";
import { SUBSCRIBER_MONTH_MS } from "@/ledger/discount-outcomes";

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
      if (action.success && pilot && SEGMENTS.includes(pilot.segment as typeof SEGMENTS[number]) && REASONS.includes(pilot.reason as typeof REASONS[number]) &&
        pilot.segment === action.data.segment && (action.data.reason === "any" || pilot.reason === action.data.reason) &&
        action.data.targets.includes(snapshot.id) && Number(snapshot.regularPrice) === Number(action.data.newPrice) && Number(action.data.newPrice) < Number(action.data.listPrice)) {
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

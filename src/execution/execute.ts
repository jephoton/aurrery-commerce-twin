import "server-only";
import { audit, ledger, now } from "@/ledger/db";
import { claimForExecution, finishExecution, getProposal, type Proposal } from "@/ledger/proposals";
import { getSubscription, overrideSubscriptionPrice, type SubscriptionSnapshot } from "@/paypal/subscriptions";

// Executes an approved proposal against PayPal Sandbox, then reads each subscription back so the
// recorded outcome is what PayPal reports, not what we asked for.

export interface TargetOutcome {
  subscriptionId: string;
  ok: boolean;
  httpStatus: number | null;
  debugId: string | null;
  verified: boolean;
  observed: Pick<SubscriptionSnapshot, "status" | "regularPrice" | "planOverridden" | "nextBillingTime"> | null;
  error: string | null;
}

export interface ExecutionReport {
  proposal: Proposal;
  outcomes: TargetOutcome[];
}

const OPERATION = "PATCH subscription fixed_price";

export async function executeProposal(id: string): Promise<ExecutionReport> {
  const proposal = claimForExecution(id);
  const action = proposal.action;
  const outcomes: TargetOutcome[] = [];

  try {
    await executeTargets(id, proposal, outcomes);
  } catch (e) {
    // Never leave a proposal stuck in "executing": record what completed and fail the rest.
    audit("execution.crashed", id, { message: e instanceof Error ? e.message : String(e), completed: outcomes.length });
  }

  const succeeded = outcomes.filter((o) => o.ok).length;
  const status = succeeded === action.targets.length ? "succeeded" : succeeded === 0 ? "failed" : "partially_failed";
  const revertAfter = succeeded > 0 ? new Date(Date.now() + action.months * 30 * 86_400_000).toISOString() : null;
  finishExecution(id, status, revertAfter);
  audit("execution.report", id, { succeeded, total: action.targets.length });
  return { proposal: getProposal(id), outcomes };
}

async function executeTargets(id: string, proposal: Proposal, outcomes: TargetOutcome[]) {
  const action = proposal.action;
  for (const subscriptionId of action.targets) {
    const request = { subscriptionId, path: "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price", value: { currency_code: "USD", value: action.newPrice } };
    const patched = await overrideSubscriptionPrice(subscriptionId, action.newPrice);
    const outcome: TargetOutcome = {
      subscriptionId,
      ok: patched.ok,
      httpStatus: patched.ok ? patched.value.httpStatus : patched.error.httpStatus,
      debugId: patched.ok ? patched.debugId : patched.error.debugId,
      verified: false,
      observed: null,
      error: patched.ok ? null : `${patched.error.name}: ${patched.error.message}`,
    };

    if (patched.ok) {
      const read = await getSubscription(subscriptionId);
      if (read.ok) {
        const v = read.value;
        outcome.observed = { status: v.status, regularPrice: v.regularPrice, planOverridden: v.planOverridden, nextBillingTime: v.nextBillingTime };
        outcome.verified = v.regularPrice !== null && Number(v.regularPrice) === Number(action.newPrice);
        recordObservation(v, "paypal.get_subscription");
      } else {
        outcome.error = `Applied, but read-back failed: ${read.error.name}: ${read.error.message}`;
      }
    }

    ledger()
      .prepare(
        `INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, http_status, debug_id, response_json, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, subscriptionId, OPERATION, JSON.stringify(request), outcome.ok ? 1 : 0, outcome.httpStatus, outcome.debugId, JSON.stringify(outcome), outcome.verified ? 1 : 0, now());
    outcomes.push(outcome);
  }
}

export function recordObservation(s: SubscriptionSnapshot, source: string) {
  ledger()
    .prepare(
      `INSERT INTO observations (subscription_id, observed_at, status, regular_price, plan_overridden, last_payment_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.id, now(), s.status, s.regularPrice, s.planOverridden ? 1 : 0, JSON.stringify(s.lastPayment), source);
}

export function listExecutions(proposalId: string): TargetOutcome[] {
  return ledger()
    .prepare("SELECT response_json FROM executions WHERE proposal_id = ? ORDER BY id")
    .all(proposalId)
    .map((r) => JSON.parse(String(r.response_json)));
}

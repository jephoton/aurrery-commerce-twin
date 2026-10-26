import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { StrategySchema, type Strategy } from "@/twin/interventions";
import type { StrategyResult } from "@/twin/simulate";
import { REASONS, SEGMENTS, type ReasonId } from "@/twin/types";
import { now } from "./db";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor, type LedgerRow } from "./connection";
import { auditOn, authoritativeWrite } from "./operations";

// Action proposals: the only route from a recommendation to a PayPal call.
// proposed → approved (explicit merchant approval of an exact payload) → executing → terminal.

export const MAX_TARGETS_PER_ACTION = 25;

export const PriceOverrideActionSchema = z.object({
  type: z.literal("subscription_price_override"),
  segment: z.enum(SEGMENTS),
  reason: z.enum(["price", "any"]),
  listPrice: z.string().regex(/^\d+\.\d{2}$/),
  newPrice: z.string().regex(/^\d+\.\d{2}$/),
  discountPct: z.number().min(5).max(50),
  months: z.number().int().min(1).max(12),
  campaignMonths: z.number().int().min(0).max(12),
  targets: z.array(z.string().regex(/^I-[A-Z0-9]+$/)).min(1).max(MAX_TARGETS_PER_ACTION),
});
export type PriceOverrideAction = z.infer<typeof PriceOverrideActionSchema>;
export type ProposalAction = PriceOverrideAction;

export type ProposalStatus = "proposed" | "approved" | "executing" | "succeeded" | "partially_failed" | "failed" | "rejected";

export interface Proposal {
  id: string;
  createdAt: string;
  objective: string | null;
  strategy: Strategy;
  prediction: Pick<StrategyResult, "metrics" | "vsBaseline" | "probValueBelowBaseline">;
  action: ProposalAction;
  actionHash: string;
  status: ProposalStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  completedAt: string | null;
  revertAfter: string | null;
}

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID_STATE" | "HASH_MISMATCH" | "NOT_EXECUTABLE" | "NO_TARGETS",
  ) {
    super(message);
  }
}

export const hashAction = (action: ProposalAction) => createHash("sha256").update(JSON.stringify(action)).digest("hex");

export interface SandboxSubscriber {
  subscriptionId: string;
  label: string;
  segment: string;
  reason: ReasonId;
}

function parseSubscriber(r: LedgerRow): SandboxSubscriber {
  const reason = z.enum(REASONS).safeParse(r.reason);
  if (!reason.success) console.warn(`Invalid stored pilot reason for ${r.subscription_id}; using other.`);
  return { subscriptionId: String(r.subscription_id), label: String(r.label), segment: String(r.segment), reason: reason.success ? reason.data : "other" };
}

/** Snapshot today's matching pilots. Later campaign entrants require separate proposals and approvals. */
export function buildActionFromSubscribers(strategy: Strategy, listPrice: number, subscribers: SandboxSubscriber[], eligibleTargetIds?: readonly string[]): ProposalAction {
  const iv = strategy.intervention;
  if (iv.kind !== "targeted_discount") {
    throw new ProposalError(`Strategy kind "${iv.kind}" has no executable PayPal action in this build.`, "NOT_EXECUTABLE");
  }
  const targets = subscribers
    .filter((s) => s.segment === iv.segment && (iv.reason === "any" || s.reason === iv.reason))
    .filter((s) => eligibleTargetIds === undefined || eligibleTargetIds.includes(s.subscriptionId))
    .map((s) => s.subscriptionId)
    .slice(0, MAX_TARGETS_PER_ACTION);
  if (targets.length === 0) {
    throw new ProposalError(`No sandbox subscriptions are registered in segment "${iv.segment}" for reason "${iv.reason}".`, "NO_TARGETS");
  }
  return PriceOverrideActionSchema.parse({
    type: "subscription_price_override",
    segment: iv.segment,
    reason: iv.reason,
    listPrice: listPrice.toFixed(2),
    newPrice: (Math.round(listPrice * (1 - iv.discountPct / 100) * 100) / 100).toFixed(2),
    discountPct: iv.discountPct,
    months: iv.months,
    campaignMonths: iv.campaignMonths,
    targets,
  });
}

export type CreateProposalInput = {
  objective: string | null;
  strategy: Strategy;
  result: StrategyResult;
  listPrice: number;
  eligibleTargetIds?: readonly string[];
};

function parseProposal(r: LedgerRow | undefined, id: string): Proposal {
  if (!r) throw new ProposalError(`Proposal ${id} not found.`, "NOT_FOUND");
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    objective: r.objective === null ? null : String(r.objective),
    strategy: JSON.parse(String(r.strategy_json)),
    prediction: JSON.parse(String(r.simulation_json)),
    action: JSON.parse(String(r.action_json)),
    actionHash: String(r.action_hash),
    status: r.status as ProposalStatus,
    approvedAt: r.approved_at === null ? null : String(r.approved_at),
    approvedBy: r.approved_by === null ? null : String(r.approved_by),
    completedAt: r.completed_at === null ? null : String(r.completed_at),
    revertAfter: r.revert_after === null ? null : String(r.revert_after),
  };
}

async function proposalOn(tx: LedgerExecutor, id: string): Promise<Proposal> {
  return parseProposal((await tx.query("SELECT * FROM proposals WHERE id = ?", [id]))[0], id);
}

/** Bind a workflow to a connection for offline tests or migration tooling. */
export function createProposalRepository(connection: LedgerConnection) {
  return {
    async listSandboxSubscribers(): Promise<SandboxSubscriber[]> {
      // rowid preserves cohort order for registrations made in the same millisecond.
      return authoritativeWrite(connection, async (tx) =>
        (await tx.query("SELECT subscription_id, label, segment, reason FROM sandbox_subscribers ORDER BY rowid")).map(parseSubscriber));
    },
    async registerSandboxSubscriber(s: SandboxSubscriber): Promise<void> {
      await authoritativeWrite(connection, async (tx) => {
        await tx.execute("INSERT OR REPLACE INTO sandbox_subscribers (subscription_id, label, segment, reason, created_at) VALUES (?, ?, ?, ?, ?)", [s.subscriptionId, s.label, s.segment, s.reason, now()]);
      });
    },
    /** Change only the identifier: preserve rowid, cohort metadata and proposal targets. */
    async replaceSandboxSubscription(previousId: string, label: string, subscriptionId: string): Promise<void> {
      await authoritativeWrite(connection, async (tx) => {
        const result = await tx.execute("UPDATE sandbox_subscribers SET subscription_id = ? WHERE subscription_id = ? AND label = ?", [subscriptionId, previousId, label]);
        if (result.rowsAffected !== 1) throw new Error("Pilot registration changed during recovery; no replacement was made.");
      });
    },
    async buildAction(strategy: Strategy, listPrice: number, eligibleTargetIds?: readonly string[]): Promise<ProposalAction> {
      return buildActionFromSubscribers(strategy, listPrice, await this.listSandboxSubscribers(), eligibleTargetIds);
    },
    async createProposal(input: CreateProposalInput): Promise<Proposal> {
      const strategy = StrategySchema.parse(input.strategy);
      return authoritativeWrite(connection, async (tx) => {
        const subscribers = (await tx.query("SELECT subscription_id, label, segment, reason FROM sandbox_subscribers ORDER BY rowid")).map(parseSubscriber);
        const action = buildActionFromSubscribers(strategy, input.listPrice, subscribers, input.eligibleTargetIds);
        const prediction = { metrics: input.result.metrics, vsBaseline: input.result.vsBaseline, probValueBelowBaseline: input.result.probValueBelowBaseline };
        const id = `prop_${randomUUID()}`;
        const actionHash = hashAction(action);
        await tx.execute(
          `INSERT INTO proposals (id, created_at, objective, strategy_json, simulation_json, action_type, action_json, action_hash, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
          [id, now(), input.objective, JSON.stringify(strategy), JSON.stringify(prediction), action.type, JSON.stringify(action), actionHash],
        );
        await auditOn(tx, "proposal.created", id, { strategyId: strategy.id, action });
        return proposalOn(tx, id);
      });
    },
    async getProposal(id: string): Promise<Proposal> { return authoritativeWrite(connection, (tx) => proposalOn(tx, id)); },
    async listProposals(limit = 20): Promise<Proposal[]> {
      return authoritativeWrite(connection, async (tx) => {
        const rows = await tx.query("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?", [limit]);
        return rows.map((row) => parseProposal(row, String(row.id)));
      });
    },
    /** Approval binds to the exact action payload the merchant saw. */
    async approveProposal(id: string, actionHash: string, approvedBy: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const p = await proposalOn(tx, id);
        if (p.actionHash !== actionHash) throw new ProposalError("Approved payload does not match the proposal.", "HASH_MISMATCH");
        const res = await tx.execute("UPDATE proposals SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'proposed' AND action_hash = ?", [now(), approvedBy, id, actionHash]);
        if (res.rowsAffected !== 1) throw new ProposalError(`Proposal is ${p.status}, not awaiting approval.`, "INVALID_STATE");
        await auditOn(tx, "proposal.approved", id, { approvedBy, actionHash });
        return proposalOn(tx, id);
      });
    },
    async rejectProposal(id: string, reason: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const res = await tx.execute("UPDATE proposals SET status = 'rejected', completed_at = ? WHERE id = ? AND status = 'proposed'", [now(), id]);
        if (res.rowsAffected !== 1) throw new ProposalError("Only a proposed action can be rejected.", "INVALID_STATE");
        await auditOn(tx, "proposal.rejected", id, { reason });
        return proposalOn(tx, id);
      });
    },
    /** Exactly one caller wins the conditional transition. */
    async claimForExecution(id: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const res = await tx.execute("UPDATE proposals SET status = 'executing' WHERE id = ? AND status = 'approved'", [id]);
        if (res.rowsAffected !== 1) {
          const p = await proposalOn(tx, id);
          throw new ProposalError(`Proposal is ${p.status}; only an approved proposal can be executed, once.`, "INVALID_STATE");
        }
        await auditOn(tx, "proposal.executing", id, null);
        return proposalOn(tx, id);
      });
    },
    async finishExecution(id: string, status: "succeeded" | "partially_failed" | "failed", revertAfter: string | null, summary?: { succeeded: number; total: number }): Promise<void> {
      await authoritativeWrite(connection, async (tx) => {
        const res = await tx.execute("UPDATE proposals SET status = ?, completed_at = ?, revert_after = ? WHERE id = ? AND status = 'executing'", [status, now(), revertAfter, id]);
        if (res.rowsAffected !== 1) throw new ProposalError("Only an executing proposal can be completed.", "INVALID_STATE");
        await auditOn(tx, `proposal.${status}`, id, { revertAfter });
        if (summary) await auditOn(tx, "execution.report", id, summary);
      });
    },
  };
}

type Repository = ReturnType<typeof createProposalRepository>;
const runtimeRepository = async (): Promise<Repository> => createProposalRepository(await runtimeLedgerConnection());
export const listSandboxSubscribers = async () => (await runtimeRepository()).listSandboxSubscribers();
export const registerSandboxSubscriber = async (s: SandboxSubscriber) => (await runtimeRepository()).registerSandboxSubscriber(s);
export const replaceSandboxSubscription = async (previousId: string, label: string, subscriptionId: string) => (await runtimeRepository()).replaceSandboxSubscription(previousId, label, subscriptionId);
export const buildAction = async (strategy: Strategy, listPrice: number, eligibleTargetIds?: readonly string[]) => (await runtimeRepository()).buildAction(strategy, listPrice, eligibleTargetIds);
export const createProposal = async (input: CreateProposalInput) => (await runtimeRepository()).createProposal(input);
export const getProposal = async (id: string) => (await runtimeRepository()).getProposal(id);
export const listProposals = async (limit?: number) => (await runtimeRepository()).listProposals(limit);
export const approveProposal = async (id: string, actionHash: string, approvedBy: string) => (await runtimeRepository()).approveProposal(id, actionHash, approvedBy);
export const rejectProposal = async (id: string, reason: string) => (await runtimeRepository()).rejectProposal(id, reason);
export const claimForExecution = async (id: string) => (await runtimeRepository()).claimForExecution(id);
export const finishExecution = async (id: string, status: "succeeded" | "partially_failed" | "failed", revertAfter: string | null, summary?: { succeeded: number; total: number }) => (await runtimeRepository()).finishExecution(id, status, revertAfter, summary);

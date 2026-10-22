import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { StrategySchema, type Strategy } from "@/twin/interventions";
import type { StrategyResult } from "@/twin/simulate";
import { REASONS, SEGMENTS, type ReasonId } from "@/twin/types";
import { audit, ledger, now } from "./db";

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

export function listSandboxSubscribers(): SandboxSubscriber[] {
  return ledger()
    // Insertion order: rows registered in the same millisecond must keep the cohort's order.
    .prepare("SELECT subscription_id, label, segment, reason FROM sandbox_subscribers ORDER BY rowid")
    .all()
    .map((r) => {
      const reason = z.enum(REASONS).safeParse(r.reason);
      if (!reason.success) console.warn(`Invalid stored pilot reason for ${r.subscription_id}; using other.`);
      return {
        subscriptionId: String(r.subscription_id),
        label: String(r.label),
        segment: String(r.segment),
        reason: reason.success ? reason.data : "other",
      };
    });
}

export function registerSandboxSubscriber(s: SandboxSubscriber) {
  ledger()
    .prepare("INSERT OR REPLACE INTO sandbox_subscribers (subscription_id, label, segment, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(s.subscriptionId, s.label, s.segment, s.reason, now());
}

/** Snapshot today's matching pilots. Later campaign entrants require separate proposals and approvals. */
export function buildAction(strategy: Strategy, listPrice: number): ProposalAction {
  const iv = strategy.intervention;
  if (iv.kind !== "targeted_discount") {
    throw new ProposalError(`Strategy kind "${iv.kind}" has no executable PayPal action in this build.`, "NOT_EXECUTABLE");
  }
  const targets = listSandboxSubscribers()
    .filter((s) => s.segment === iv.segment && (iv.reason === "any" || s.reason === iv.reason))
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

export function createProposal(input: {
  objective: string | null;
  strategy: Strategy;
  result: StrategyResult;
  listPrice: number;
}): Proposal {
  const strategy = StrategySchema.parse(input.strategy);
  const action = buildAction(strategy, input.listPrice);
  const prediction = {
    metrics: input.result.metrics,
    vsBaseline: input.result.vsBaseline,
    probValueBelowBaseline: input.result.probValueBelowBaseline,
  };
  const id = `prop_${randomUUID()}`;
  const actionHash = hashAction(action);
  ledger()
    .prepare(
      `INSERT INTO proposals (id, created_at, objective, strategy_json, simulation_json, action_type, action_json, action_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
    )
    .run(id, now(), input.objective, JSON.stringify(strategy), JSON.stringify(prediction), action.type, JSON.stringify(action), actionHash);
  audit("proposal.created", id, { strategyId: strategy.id, action });
  return getProposal(id);
}

export function getProposal(id: string): Proposal {
  const r = ledger().prepare("SELECT * FROM proposals WHERE id = ?").get(id);
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

export function listProposals(limit = 20): Proposal[] {
  return ledger()
    .prepare("SELECT id FROM proposals ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r) => getProposal(String(r.id)));
}

/** Approval binds to the exact action payload the merchant saw, via its hash. */
export function approveProposal(id: string, actionHash: string, approvedBy: string): Proposal {
  const p = getProposal(id);
  if (p.actionHash !== actionHash) throw new ProposalError("Approved payload does not match the proposal.", "HASH_MISMATCH");
  const res = ledger()
    .prepare("UPDATE proposals SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'proposed'")
    .run(now(), approvedBy, id);
  if (res.changes !== 1) throw new ProposalError(`Proposal is ${p.status}, not awaiting approval.`, "INVALID_STATE");
  audit("proposal.approved", id, { approvedBy, actionHash });
  return getProposal(id);
}

export function rejectProposal(id: string, reason: string): Proposal {
  const res = ledger().prepare("UPDATE proposals SET status = 'rejected', completed_at = ? WHERE id = ? AND status = 'proposed'").run(now(), id);
  if (res.changes !== 1) throw new ProposalError("Only a proposed action can be rejected.", "INVALID_STATE");
  audit("proposal.rejected", id, { reason });
  return getProposal(id);
}

/** Atomically move approved → executing. Exactly one caller can win, so execution cannot be duplicated. */
export function claimForExecution(id: string): Proposal {
  const res = ledger().prepare("UPDATE proposals SET status = 'executing' WHERE id = ? AND status = 'approved'").run(id);
  if (res.changes !== 1) {
    const p = getProposal(id);
    throw new ProposalError(`Proposal is ${p.status}; only an approved proposal can be executed, once.`, "INVALID_STATE");
  }
  audit("proposal.executing", id, null);
  return getProposal(id);
}

export function finishExecution(id: string, status: "succeeded" | "partially_failed" | "failed", revertAfter: string | null) {
  ledger().prepare("UPDATE proposals SET status = ?, completed_at = ?, revert_after = ? WHERE id = ? AND status = 'executing'").run(status, now(), revertAfter, id);
  audit(`proposal.${status}`, id, { revertAfter });
}

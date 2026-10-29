import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { StrategySchema, type Strategy } from "@/twin/interventions";
import type { StrategyResult } from "@/twin/simulate";
import { REASONS, SEGMENTS, type ReasonId } from "@/twin/types";
import { sameUsdAmount, usdCents } from "@/paypal/prices";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import { currentMerchant } from "@/merchant";
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
const Money = z.string().regex(/^\d+\.\d{2}$/);
const RevertTargetSchema = z.object({
  subscriptionId: z.string().regex(/^I-[A-Z0-9]+$/),
  sourceExecutionId: z.number().int().positive(),
  expectedCurrentPrice: Money,
  listPrice: Money,
  registration: z.object({ label: z.string().min(1), segment: z.enum(SEGMENTS), reason: z.enum(REASONS), createdAt: z.string().datetime() }).strict(),
}).strict();
export const RevertActionSchema = z.object({
  type: z.literal("subscription_price_revert"),
  sourceProposalId: z.string().regex(/^prop_[0-9a-f-]{36}$/),
  sourceActionHash: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(RevertTargetSchema).min(1).max(MAX_TARGETS_PER_ACTION),
}).strict().superRefine((action, ctx) => {
  if (new Set(action.targets.map((target) => target.subscriptionId)).size !== action.targets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate recovery target", path: ["targets"] });
  if (action.targets.some((target) => Number(target.expectedCurrentPrice) >= Number(target.listPrice)))
    ctx.addIssue({ code: "custom", message: "Recovery price is not a discount", path: ["targets"] });
});
export type RevertAction = z.infer<typeof RevertActionSchema>;
const ResetTargetSchema = RevertTargetSchema.omit({ sourceExecutionId: true, listPrice: true }).extend({
  expectedCurrentPrice: z.string().refine((price) => usdCents(price) !== null, "Invalid observed USD amount"),
});
export const ResetActionSchema = z.object({
  type: z.literal("subscription_price_reset"), canonicalListPrice: Money,
  targets: z.array(ResetTargetSchema).min(1).max(PILOT_COHORT.length),
}).strict().superRefine((action, ctx) => {
  if (usdCents(action.canonicalListPrice) === null || usdCents(action.canonicalListPrice) === 0)
    ctx.addIssue({ code: "custom", message: "Invalid canonical list price", path: ["canonicalListPrice"] });
  for (const target of action.targets) {
    const expected = PILOT_COHORT.find((pilot) => pilot.label === target.registration.label);
    if (!expected || expected.segment !== target.registration.segment || expected.reason !== target.registration.reason)
      ctx.addIssue({ code: "custom", message: "Invalid demo pilot metadata", path: ["targets"] });
  }
  if (new Set(action.targets.map((target) => target.subscriptionId)).size !== action.targets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate reset target", path: ["targets"] });
  if (new Set(action.targets.map((target) => target.registration.label)).size !== action.targets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate pilot label", path: ["targets"] });
  if (action.targets.some((target) => sameUsdAmount(target.expectedCurrentPrice, action.canonicalListPrice)))
    ctx.addIssue({ code: "custom", message: "Already at list price", path: ["targets"] });
});
export type ResetAction = z.infer<typeof ResetActionSchema>;
export type ProposalAction = PriceOverrideAction | RevertAction | ResetAction;

export type ProposalStatus = "proposed" | "approved" | "executing" | "succeeded" | "partially_failed" | "failed" | "rejected";
export type ProposalCursor = { createdAt: string; id: string };

export interface Proposal {
  id: string;
  createdAt: string;
  objective: string | null;
  strategy: Strategy | null;
  prediction: Pick<StrategyResult, "metrics" | "vsBaseline" | "probValueBelowBaseline"> | null;
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
export function buildActionFromSubscribers(strategy: Strategy, listPrice: number, subscribers: SandboxSubscriber[], eligibleTargetIds?: readonly string[]): PriceOverrideAction {
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

async function assertRegistrationMutable(tx: LedgerExecutor, subscriptionIds: string[], label: string): Promise<void> {
  const ids = new Set(subscriptionIds);
  for (const pilot of await tx.query("SELECT subscription_id FROM sandbox_subscribers WHERE label=?", [label])) ids.add(String(pilot.subscription_id));
  for (const id of ids) {
    if ((await tx.query("SELECT target_id FROM active_target_claims WHERE target_id=?", [id])).length)
      throw new Error("Pilot has an active execution claim.");
  }
  // A legacy executing action can predate the reservation table.
  for (const row of await tx.query("SELECT action_json FROM proposals WHERE status='executing'")) {
    let action: ProposalAction;
    try { action = JSON.parse(String(row.action_json)); } catch { throw new Error("Unresolved execution blocks pilot registration changes."); }
    const targets = action.type === "subscription_price_override" ? action.targets : action.targets.map((target) => target.subscriptionId);
    if (!targets || !Array.isArray(targets) || targets.some((target) => ids.has(target))) throw new Error("Pilot has an active execution claim.");
  }
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
        await assertRegistrationMutable(tx, [s.subscriptionId], s.label);
        await tx.execute("INSERT OR REPLACE INTO sandbox_subscribers (subscription_id, label, segment, reason, created_at) VALUES (?, ?, ?, ?, ?)", [s.subscriptionId, s.label, s.segment, s.reason, now()]);
      });
    },
    /** Change only the identifier: preserve rowid, cohort metadata and proposal targets. */
    async replaceSandboxSubscription(previousId: string, label: string, subscriptionId: string): Promise<void> {
      await authoritativeWrite(connection, async (tx) => {
        await assertRegistrationMutable(tx, [previousId, subscriptionId], label);
        const result = await tx.execute("UPDATE sandbox_subscribers SET subscription_id = ? WHERE subscription_id = ? AND label = ?", [subscriptionId, previousId, label]);
        if (result.rowsAffected !== 1) throw new Error("Pilot registration changed during recovery; no replacement was made.");
      });
    },
    async buildAction(strategy: Strategy, listPrice: number, eligibleTargetIds?: readonly string[]): Promise<PriceOverrideAction> {
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
    async createRevertProposal(sourceProposalId: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const source = await proposalOn(tx, sourceProposalId);
        if (source.action.type !== "subscription_price_override" || !["succeeded", "partially_failed"].includes(source.status) ||
          hashAction(source.action) !== source.actionHash) throw new ProposalError("Source is not a completed discount action.", "INVALID_STATE");
        const executions = await tx.query("SELECT id,target_id,response_json,created_at FROM executions WHERE proposal_id=? AND operation='PATCH subscription fixed_price' AND ok=1 AND verified=1 ORDER BY id", [source.id]);
        const targets: RevertAction["targets"] = [];
        for (const execution of executions) {
          const id = String(execution.target_id);
          if (!source.action.targets.includes(id)) continue;
          let reported: { observed?: { regularPrice?: string } };
          try { reported = JSON.parse(String(execution.response_json)); } catch { continue; }
          if (!sameUsdAmount(reported.observed?.regularPrice, source.action.newPrice)) continue;
          const latest = (await tx.query("SELECT id FROM executions WHERE target_id=? AND ok=1 AND verified=1 ORDER BY id DESC LIMIT 1", [id]))[0];
          if (Number(latest?.id) !== Number(execution.id)) continue;
          const registration = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [id]))[0];
          if (!registration || Date.parse(String(registration.created_at)) > Date.parse(String(execution.created_at)) || registration.segment !== source.action.segment ||
            (source.action.reason !== "any" && registration.reason !== source.action.reason)) continue;
          targets.push({ subscriptionId: id, sourceExecutionId: Number(execution.id), expectedCurrentPrice: source.action.newPrice,
            listPrice: source.action.listPrice, registration: { label: String(registration.label), segment: registration.segment as typeof SEGMENTS[number],
              reason: registration.reason as ReasonId, createdAt: String(registration.created_at) } });
        }
        if (!targets.length) throw new ProposalError("No verified registered discount targets remain eligible.", "NO_TARGETS");
        const action = RevertActionSchema.parse({ type: "subscription_price_revert", sourceProposalId: source.id, sourceActionHash: source.actionHash, targets });
        const id = `prop_${randomUUID()}`;
        await tx.execute(`INSERT INTO proposals (id,created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status)
          VALUES (?,?,?,?,?,?,?,?,'proposed')`, [id, now(), `Restore verified discount from ${source.id}`, JSON.stringify(source.strategy), "null",
            action.type, JSON.stringify(action), hashAction(action)]);
        await auditOn(tx, "proposal.revert_created", id, { sourceProposalId: source.id, sourceActionHash: source.actionHash, targets: targets.map((target) => target.subscriptionId) });
        return proposalOn(tx, id);
      });
    },
    async createResetProposal(canonicalListPrice: string, snapshots: ResetAction["targets"]): Promise<Proposal> {
      const action = ResetActionSchema.parse({ type: "subscription_price_reset", canonicalListPrice, targets: snapshots });
      return authoritativeWrite(connection, async (tx) => {
        if (!sameUsdAmount(currentMerchant().twin.params.listPrice.toFixed(2), canonicalListPrice))
          throw new ProposalError("Canonical list price changed.", "INVALID_STATE");
        for (const target of action.targets) {
          const expected = PILOT_COHORT.find((pilot) => pilot.label === target.registration.label);
          const actual = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [target.subscriptionId]))[0];
          const sameLabel = await tx.query("SELECT subscription_id FROM sandbox_subscribers WHERE label=?", [target.registration.label]);
          if (sameLabel.length !== 1 || !expected || !actual || expected.segment !== target.registration.segment || expected.reason !== target.registration.reason ||
            actual.label !== expected.label || actual.segment !== expected.segment || actual.reason !== expected.reason || actual.created_at !== target.registration.createdAt)
            throw new ProposalError("Reset target is not a current registered demo pilot.", "INVALID_STATE");
        }
        const id = `prop_${randomUUID()}`;
        await tx.execute(`INSERT INTO proposals (id,created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status)
          VALUES (?,?,?,?,?,?,?,?,'proposed')`, [id, now(), "Restore current demo pilots to canonical list price", "null", "null",
            action.type, JSON.stringify(action), hashAction(action)]);
        await auditOn(tx, "proposal.reset_created", id, { targets: action.targets.map((target) => target.subscriptionId), canonicalListPrice });
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
    async listOutstandingProposals(limit = 20, before?: ProposalCursor): Promise<{ proposals: Proposal[]; nextCursor: ProposalCursor | null }> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        (before && (!Number.isFinite(Date.parse(before.createdAt)) || !/^prop_[0-9a-f-]{36}$/.test(before.id))))
        throw new ProposalError("Invalid outstanding proposal page.", "INVALID_STATE");
      return authoritativeWrite(connection, async (tx) => {
        const rows = await tx.query(`SELECT * FROM proposals WHERE
          ((action_type IN ('subscription_price_revert','subscription_price_reset') AND status IN ('proposed','approved','executing')) OR
           (action_type='subscription_price_override' AND status IN ('approved','executing')))
          ${before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
          ORDER BY created_at DESC,id DESC LIMIT ?`, before ? [before.createdAt, before.createdAt, before.id, limit + 1] : [limit + 1]);
        const proposals = rows.slice(0, limit).map((row) => parseProposal(row, String(row.id)));
        const last = proposals.at(-1);
        return { proposals, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
      });
    },
    /** Approval binds to the exact action payload the merchant saw. */
    async approveProposal(id: string, actionHash: string, approvedBy: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const p = await proposalOn(tx, id);
        if (p.action.type === "subscription_price_reset") throw new ProposalError("Reset requires its explicit administrator confirmation.", "INVALID_STATE");
        if (p.actionHash !== actionHash) throw new ProposalError("Approved payload does not match the proposal.", "HASH_MISMATCH");
        const res = await tx.execute("UPDATE proposals SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'proposed' AND action_hash = ?", [now(), approvedBy, id, actionHash]);
        if (res.rowsAffected !== 1) throw new ProposalError(`Proposal is ${p.status}, not awaiting approval.`, "INVALID_STATE");
        await auditOn(tx, "proposal.approved", id, { approvedBy, actionHash });
        return proposalOn(tx, id);
      });
    },
    async approveResetProposal(id: string, actionHash: string, approvedBy: string): Promise<Proposal> {
      return authoritativeWrite(connection, async (tx) => {
        const p = await proposalOn(tx, id);
        if (p.action.type !== "subscription_price_reset" || p.status !== "proposed") throw new ProposalError("Reset is not awaiting confirmation.", "INVALID_STATE");
        if (p.actionHash !== actionHash || hashAction(p.action) !== actionHash) throw new ProposalError("Reset payload hash changed.", "HASH_MISMATCH");
        const result = await tx.execute("UPDATE proposals SET status='approved',approved_at=?,approved_by=? WHERE id=? AND status='proposed' AND action_hash=?", [now(), approvedBy, id, actionHash]);
        if (result.rowsAffected !== 1) throw new ProposalError("Reset approval lost.", "INVALID_STATE");
        await auditOn(tx, "proposal.reset_approved", id, { approvedBy, actionHash });
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
      const result = await authoritativeWrite(connection, async (tx) => {
        const p = await proposalOn(tx, id);
        if (p.status !== "approved") throw new ProposalError(`Proposal is ${p.status}; only an approved proposal can be executed, once.`, "INVALID_STATE");
        const fail = async (reason: string) => {
          await tx.execute("DELETE FROM active_target_claims WHERE proposal_id=?", [id]);
          await tx.execute("UPDATE proposals SET status='failed',completed_at=? WHERE id=? AND status='approved'", [now(), id]);
          await auditOn(tx, "proposal.preflight_failed", id, { reason });
          return null;
        };
        const targets = p.action.type === "subscription_price_override" ? p.action.targets : p.action.targets.map((target) => target.subscriptionId);
        if (p.action.type === "subscription_price_reset") {
          const action = ResetActionSchema.safeParse(p.action);
          if (!action.success || hashAction(p.action) !== p.actionHash || !sameUsdAmount(currentMerchant().twin.params.listPrice.toFixed(2), p.action.canonicalListPrice))
            return fail("invalid_or_stale_reset");
          for (const target of action.data.targets) {
            const expected = PILOT_COHORT.find((pilot) => pilot.label === target.registration.label);
            const actual = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [target.subscriptionId]))[0];
            const sameLabel = await tx.query("SELECT subscription_id FROM sandbox_subscribers WHERE label=?", [target.registration.label]);
            if (sameLabel.length !== 1 || !expected || !actual || expected.segment !== target.registration.segment || expected.reason !== target.registration.reason ||
              actual.label !== expected.label || actual.segment !== expected.segment || actual.reason !== expected.reason || actual.created_at !== target.registration.createdAt)
              return fail("reset_registration_changed");
          }
        } else if (p.action.type === "subscription_price_revert") {
          const action = RevertActionSchema.safeParse(p.action);
          if (!action.success || hashAction(p.action) !== p.actionHash) return fail("invalid_revert_action");
          const source = await proposalOn(tx, action.data.sourceProposalId);
          if (source.action.type !== "subscription_price_override" || !["succeeded", "partially_failed"].includes(source.status) ||
            source.actionHash !== action.data.sourceActionHash || hashAction(source.action) !== source.actionHash) return fail("stale_source");
          for (const target of action.data.targets) {
            const registration = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [target.subscriptionId]))[0];
            if (!registration || registration.label !== target.registration.label || registration.segment !== target.registration.segment ||
              registration.reason !== target.registration.reason || registration.created_at !== target.registration.createdAt ||
              !source.action.targets.includes(target.subscriptionId) || source.action.newPrice !== target.expectedCurrentPrice || source.action.listPrice !== target.listPrice) return fail("registration_or_source_changed");
            const execution = (await tx.query("SELECT proposal_id,target_id,operation,ok,verified,response_json,created_at FROM executions WHERE id=?", [target.sourceExecutionId]))[0];
            const latest = (await tx.query("SELECT id FROM executions WHERE target_id=? AND ok=1 AND verified=1 ORDER BY id DESC LIMIT 1", [target.subscriptionId]))[0];
            if (!execution || execution.proposal_id !== source.id || execution.target_id !== target.subscriptionId ||
              execution.operation !== "PATCH subscription fixed_price" || Number(execution.ok) !== 1 || Number(execution.verified) !== 1 ||
              Date.parse(target.registration.createdAt) > Date.parse(String(execution.created_at)) || Number(latest?.id) !== target.sourceExecutionId) return fail("source_execution_changed");
            try { if (!sameUsdAmount(JSON.parse(String(execution.response_json)).observed?.regularPrice, target.expectedCurrentPrice)) return fail("source_price_changed"); }
            catch { return fail("source_execution_invalid"); }
          }
        } else {
          const action = PriceOverrideActionSchema.safeParse(p.action);
          if (!action.success || hashAction(p.action) !== p.actionHash) return fail("invalid_discount_action");
          for (const target of action.data.targets) {
            const registration = (await tx.query("SELECT segment,reason FROM sandbox_subscribers WHERE subscription_id=?", [target]))[0];
            if (!registration || registration.segment !== action.data.segment ||
              (action.data.reason !== "any" && registration.reason !== action.data.reason)) return fail("registration_changed");
          }
        }
        // Imported older ledgers can have unresolved executions without a claims table.
        const executing = await tx.query("SELECT id,action_json FROM proposals WHERE status='executing' AND id<>?", [id]);
        for (const row of executing) {
          let prior: ProposalAction;
          try { prior = JSON.parse(String(row.action_json)); } catch { return fail("unreadable_executing_action"); }
          const priorTargets = prior.type === "subscription_price_override" ? prior.targets : prior.targets.map((target) => target.subscriptionId);
          if (!priorTargets || !Array.isArray(priorTargets) || priorTargets.some((target) => targets.includes(target))) return fail("unresolved_target");
        }
        for (const target of targets) {
          const reserved = await tx.execute("INSERT OR IGNORE INTO active_target_claims (target_id,proposal_id,claimed_at) VALUES (?,?,?)", [target, id, now()]);
          if (reserved.rowsAffected !== 1) return fail("target_claimed");
        }
        const res = await tx.execute("UPDATE proposals SET status = 'executing' WHERE id = ? AND status = 'approved'", [id]);
        if (res.rowsAffected !== 1) throw new ProposalError("Proposal claim lost.", "INVALID_STATE");
        await auditOn(tx, "proposal.executing", id, null);
        return proposalOn(tx, id);
      });
      if (!result) throw new ProposalError("Preflight failed before PayPal mutation; create and approve a fresh proposal.", "INVALID_STATE");
      return result;
    },
    async validateTargetForExecution(proposal: Proposal, subscriptionId: string): Promise<boolean> {
      return authoritativeWrite(connection, async (tx) => {
        if (proposal.status !== "executing") return false;
        const claim = (await tx.query("SELECT proposal_id FROM active_target_claims WHERE target_id=?", [subscriptionId]))[0];
        if (claim?.proposal_id !== proposal.id) return false;
        const action = proposal.action;
        if (action.type === "subscription_price_override") {
          if (!action.targets.includes(subscriptionId)) return false;
          const pilot = (await tx.query("SELECT segment,reason FROM sandbox_subscribers WHERE subscription_id=?", [subscriptionId]))[0];
          return !!pilot && pilot.segment === action.segment && (action.reason === "any" || pilot.reason === action.reason);
        }
        const pilot = (await tx.query("SELECT label,segment,reason,created_at FROM sandbox_subscribers WHERE subscription_id=?", [subscriptionId]))[0];
        if (action.type === "subscription_price_reset") {
          const target = action.targets.find((candidate) => candidate.subscriptionId === subscriptionId);
          if (!target) return false;
          const expected = PILOT_COHORT.find((member) => member.label === target.registration.label);
          const sameLabel = await tx.query("SELECT subscription_id FROM sandbox_subscribers WHERE label=?", [target.registration.label]);
          return sameLabel.length === 1 && !!expected && expected.segment === target.registration.segment && expected.reason === target.registration.reason &&
            sameUsdAmount(currentMerchant().twin.params.listPrice.toFixed(2), action.canonicalListPrice) &&
            !!pilot && pilot.label === expected.label && pilot.segment === expected.segment && pilot.reason === expected.reason &&
            pilot.created_at === target.registration.createdAt;
        }
        const target = action.targets.find((candidate) => candidate.subscriptionId === subscriptionId);
        if (!target) return false;
        const latest = (await tx.query("SELECT id FROM executions WHERE target_id=? AND ok=1 AND verified=1 ORDER BY id DESC LIMIT 1", [subscriptionId]))[0];
        return !!pilot && pilot.label === target.registration.label && pilot.segment === target.registration.segment &&
          pilot.reason === target.registration.reason && pilot.created_at === target.registration.createdAt && Number(latest?.id) === target.sourceExecutionId;
      });
    },
    async finishExecution(id: string, status: "succeeded" | "partially_failed" | "failed", revertAfter: string | null, summary?: { succeeded: number; total: number }): Promise<void> {
      await authoritativeWrite(connection, async (tx) => {
        const action = (await proposalOn(tx, id)).action;
        if (action.type !== "subscription_price_override" && revertAfter !== null) throw new ProposalError("A recovery cannot schedule a revert.", "INVALID_STATE");
        const res = await tx.execute("UPDATE proposals SET status = ?, completed_at = ?, revert_after = ? WHERE id = ? AND status = 'executing'", [status, now(), revertAfter, id]);
        if (res.rowsAffected !== 1) throw new ProposalError("Only an executing proposal can be completed.", "INVALID_STATE");
        await tx.execute("DELETE FROM active_target_claims WHERE proposal_id=?", [id]);
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
export const createRevertProposal = async (sourceProposalId: string) => (await runtimeRepository()).createRevertProposal(sourceProposalId);
export const createResetProposal = async (listPrice: string, snapshots: ResetAction["targets"]) => (await runtimeRepository()).createResetProposal(listPrice, snapshots);
export const getProposal = async (id: string) => (await runtimeRepository()).getProposal(id);
export const listProposals = async (limit?: number) => (await runtimeRepository()).listProposals(limit);
export const listOutstandingProposals = async (limit?: number, before?: ProposalCursor) => (await runtimeRepository()).listOutstandingProposals(limit, before);
export const approveProposal = async (id: string, actionHash: string, approvedBy: string) => (await runtimeRepository()).approveProposal(id, actionHash, approvedBy);
export const approveResetProposal = async (id: string, actionHash: string, approvedBy: string) => (await runtimeRepository()).approveResetProposal(id, actionHash, approvedBy);
export const rejectProposal = async (id: string, reason: string) => (await runtimeRepository()).rejectProposal(id, reason);
export const claimForExecution = async (id: string) => (await runtimeRepository()).claimForExecution(id);
export const validateTargetForExecution = async (proposal: Proposal, subscriptionId: string) => (await runtimeRepository()).validateTargetForExecution(proposal, subscriptionId);
export const finishExecution = async (id: string, status: "succeeded" | "partially_failed" | "failed", revertAfter: string | null, summary?: { succeeded: number; total: number }) => (await runtimeRepository()).finishExecution(id, status, revertAfter, summary);

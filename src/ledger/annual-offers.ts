import "server-only";
import { z } from "zod";
import { SEGMENTS } from "@/twin/types";
import type { TargetOutcome } from "@/execution/outcomes";
import { isPayPalApprovalUrl } from "@/paypal/approval-link";
import type { PlanSnapshot } from "@/paypal/plans";
import { AnnualOfferActionSchema } from "./annual-offer-action";
import { countResolvedOffers, offerView, parseIsoInstant, type AnnualOfferView, type OfferRead, type OfferRecord, type SegmentOfferCounts } from "./annual-offer-status";
import { now } from "./db";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor } from "./connection";
import { auditOn, authoritativeWrite } from "./operations";

// Annual-plan offers and the PayPal reads that resolve them. The approval link is a per-subscriber
// secret: it is written only to annual_offers.approval_url and read only by listAnnualOfferLinks.
// Status is always derived from the reads (annual-offer-status.ts), never stored.

export const ANNUAL_REVISE_OPERATION = "POST subscription revise (annual plan)";
export const ANNUAL_OFFER_LIMITATION = "Sandbox demonstration with very few offers. A switch counts only when PayPal reads the subscription back ACTIVE on the offered annual plan; a decline counts only after the offer window plus six hours and a confirming read. Customers chose whether to switch, so this is not a randomized uptake estimate.";

export interface IssuedOffer {
  proposalId: string; subscriptionId: string; segment: OfferRecord["segment"]; annualPlanId: string;
  approvalUrl: string; offeredAt: string; expiresAt: string; request: unknown; outcome: TargetOutcome;
}
/** Administrator only: an open offer with its secret approval link. */
export interface AnnualOfferLink extends AnnualOfferView { approvalUrl: string; annualPrice: string; discountPct: number }
export interface AnnualOfferEvidence { offers: SegmentOfferCounts[]; limitation: string }
export interface OfferReadInput { status: string; planId: string | null; debugId: string | null }

const runtime = async (connection?: LedgerConnection) => connection ?? await runtimeLedgerConnection();
const exposesLink = (value: unknown, link?: string) => {
  const text = JSON.stringify(value ?? null);
  return text.includes("ba_token") || (!!link && text.includes(link));
};

async function insertExecution(tx: LedgerExecutor, proposalId: string, request: unknown, outcome: TargetOutcome, recordedAt: string) {
  return tx.execute(
    `INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, http_status, debug_id, response_json, verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [proposalId, outcome.subscriptionId, ANNUAL_REVISE_OPERATION, JSON.stringify(request ?? null), outcome.ok ? 1 : 0, outcome.httpStatus, outcome.debugId, JSON.stringify(outcome), recordedAt],
  );
}

/** One transaction: execution record (verified = 0; the switch is verified only by later reads), offer with its secret link, and audit entry. */
export async function recordAnnualOffer(offer: IssuedOffer, connection?: LedgerConnection): Promise<number> {
  const offeredMs = parseIsoInstant(offer.offeredAt);
  const expiresMs = parseIsoInstant(offer.expiresAt);
  if (offeredMs === null || expiresMs === null) throw new RangeError("Offer times must be ISO-8601 instants.");
  if (expiresMs <= offeredMs) throw new RangeError("An offer window must end after it opens.");
  const issued = offer.outcome.offer;
  if (!offer.outcome.ok || !issued || offer.outcome.subscriptionId !== offer.subscriptionId ||
    issued.annualPlanId !== offer.annualPlanId || issued.expiresAt !== offer.expiresAt) throw new RangeError("Only an issued offer for this target can be recorded.");
  if (!isPayPalApprovalUrl(offer.approvalUrl)) throw new Error("Only a PayPal approval link can be stored.");
  if (exposesLink([offer.request, offer.outcome], offer.approvalUrl)) throw new Error("An approval link may be stored only in annual_offers.");
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const execution = await insertExecution(tx, offer.proposalId, offer.request, offer.outcome, offer.offeredAt);
    if (execution.lastInsertRowid === undefined) throw new Error("Execution record was not created.");
    const inserted = await tx.execute(
      `INSERT INTO annual_offers (proposal_id, execution_id, subscription_id, segment, annual_plan_id, approval_url, offered_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [offer.proposalId, execution.lastInsertRowid, offer.subscriptionId, offer.segment, offer.annualPlanId, offer.approvalUrl, offer.offeredAt, offer.expiresAt],
    );
    if (inserted.lastInsertRowid === undefined) throw new Error("Offer record was not created.");
    const offerId = Number(inserted.lastInsertRowid);
    await auditOn(tx, "annual_offer.issued", offer.proposalId, { targetId: offer.subscriptionId, offerId, annualPlanId: offer.annualPlanId, expiresAt: offer.expiresAt });
    return offerId;
  });
}

/** A target that received no offer: skipped, refused, or left unresolved for the operator. */
export async function recordAnnualTarget(proposalId: string, request: unknown, outcome: TargetOutcome, connection?: LedgerConnection, recordedAt = now()): Promise<void> {
  if (outcome.offer || exposesLink([request, outcome])) throw new Error("Only a target without an offer or link is recorded here.");
  if (parseIsoInstant(recordedAt) === null) throw new RangeError("recordedAt must be an ISO-8601 instant.");
  await authoritativeWrite(await runtime(connection), async (tx) => {
    await insertExecution(tx, proposalId, request, outcome, recordedAt);
    await auditOn(tx, "execution.target_recorded", proposalId, { targetId: outcome.subscriptionId, ok: outcome.ok, verified: false });
  });
}

/** Audit the verified yearly plan read-back before any revise. */
export async function recordAnnualPlan(proposalId: string, plan: PlanSnapshot, debugId: string | null, connection?: LedgerConnection): Promise<void> {
  await authoritativeWrite(await runtime(connection), (tx) => auditOn(tx, "annual_plan.verified", proposalId,
    { planId: plan.planId, price: plan.price, currency: plan.currency, intervalUnit: plan.intervalUnit, debugId }));
}

/**
 * Append-only: every successful GET appends one read to each offer the subscription received,
 * resolved or not, so a late switch still wins. Returns the number of reads appended.
 */
export async function appendOfferReads(subscriptionId: string, read: OfferReadInput, observedAt: string, connection?: LedgerConnection): Promise<number> {
  if (parseIsoInstant(observedAt) === null) throw new RangeError("observedAt must be an ISO-8601 instant.");
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const offers = await tx.query("SELECT id FROM annual_offers WHERE subscription_id = ? ORDER BY id", [subscriptionId]);
    for (const offer of offers) {
      await tx.execute("INSERT INTO annual_offer_reads (offer_id, observed_at, status, plan_id, debug_id) VALUES (?, ?, ?, ?, ?)",
        [offer.id, observedAt, read.status, read.planId, read.debugId]);
    }
    return offers.length;
  });
}

const Segment = z.enum(SEGMENTS);
type StoredOffer = { record: OfferRecord; reads: OfferRead[] };

/** Never selects approval_url. */
async function offerRecords(tx: LedgerExecutor): Promise<StoredOffer[]> {
  const rows = await tx.query("SELECT id, proposal_id, subscription_id, segment, annual_plan_id, offered_at, expires_at FROM annual_offers ORDER BY id");
  const reads = await tx.query("SELECT offer_id, observed_at, status, plan_id FROM annual_offer_reads ORDER BY id");
  const byOffer = new Map<number, OfferRead[]>();
  for (const r of reads) {
    const id = Number(r.offer_id);
    const list = byOffer.get(id) ?? [];
    list.push({ observedAt: String(r.observed_at), status: String(r.status), planId: r.plan_id === null ? null : String(r.plan_id) });
    byOffer.set(id, list);
  }
  return rows.map((row) => ({
    record: {
      id: Number(row.id), proposalId: String(row.proposal_id), subscriptionId: String(row.subscription_id), segment: Segment.parse(row.segment),
      annualPlanId: String(row.annual_plan_id), offeredAt: String(row.offered_at), expiresAt: String(row.expires_at),
    },
    reads: byOffer.get(Number(row.id)) ?? [],
  }));
}

/** Public view: derived status only, never the approval link. */
export async function listAnnualOfferViews(at = new Date(), connection?: LedgerConnection): Promise<AnnualOfferView[]> {
  return authoritativeWrite(await runtime(connection), async (tx) => (await offerRecords(tx)).map(({ record, reads }) => offerView(record, reads, at)));
}

/** Administrator only: links of offers whose window is still open (pending), with the approved price. */
export async function listAnnualOfferLinks(at = new Date(), connection?: LedgerConnection): Promise<AnnualOfferLink[]> {
  return authoritativeWrite(await runtime(connection), async (tx) => {
    const pending = (await offerRecords(tx)).map(({ record, reads }) => offerView(record, reads, at)).filter((view) => view.status === "pending");
    if (pending.length === 0) return [];
    // Read secrets only for offers whose window is still open.
    const secrets = new Map((await tx.query(
      `SELECT o.id, o.approval_url, p.action_json FROM annual_offers o JOIN proposals p ON p.id = o.proposal_id
       WHERE o.id IN (${pending.map(() => "?").join(", ")}) ORDER BY o.id`,
      pending.map((view) => view.id),
    )).map((row) => [Number(row.id), row]));
    return pending.map((view) => {
      const row = secrets.get(view.id);
      if (!row) throw new Error("Annual offer is missing its proposal.");
      const action = AnnualOfferActionSchema.parse(JSON.parse(String(row.action_json)));
      return { ...view, approvalUrl: String(row.approval_url), annualPrice: action.annualPrice, discountPct: action.discountPct };
    });
  });
}

/**
 * Subscribers who may not receive another offer: anything short of a confirmed decline (pending,
 * awaiting final check, invalid, switched). Takes an executor so a claim can check it in its own transaction.
 */
export async function openOfferSubscriptionIds(tx: LedgerExecutor, at: Date): Promise<Set<string>> {
  return new Set((await offerRecords(tx))
    .filter(({ record, reads }) => offerView(record, reads, at).outcome !== "declined")
    .map(({ record }) => record.subscriptionId));
}

/** Every yearly plan an offer was made on; price changes and reset refuse subscribers on these plans. */
export async function listAnnualPlanIds(connection?: LedgerConnection): Promise<Set<string>> {
  return authoritativeWrite(await runtime(connection), async (tx) =>
    new Set((await tx.query("SELECT DISTINCT annual_plan_id FROM annual_offers")).map((row) => String(row.annual_plan_id))));
}

/** Per-segment accepted / declined / unresolved counts; only resolved offers feed the twin. */
export async function readAnnualOfferEvidence(connection?: LedgerConnection, at = new Date().toISOString()): Promise<AnnualOfferEvidence> {
  const atMs = parseIsoInstant(at);
  if (atMs === null) throw new RangeError("Evidence time must be an ISO-8601 instant.");
  const instant = new Date(atMs);
  return authoritativeWrite(await runtime(connection), async (tx) => ({
    offers: countResolvedOffers((await offerRecords(tx)).map(({ record, reads }) => ({ segment: record.segment, outcome: offerView(record, reads, instant).outcome }))),
    limitation: ANNUAL_OFFER_LIMITATION,
  }));
}

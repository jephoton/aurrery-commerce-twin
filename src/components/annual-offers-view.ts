import { isDefinitiveFailure, outcomeStatusText, type TargetOutcome } from "@/execution/outcomes";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import type { Strategy } from "@/twin/interventions";

/** Compact UTC display for stored ISO instants. */
export const formatUtc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export const DEFAULT_OFFER_WINDOW_DAYS = 7;

/** The merchant's offer window as whole days from 1 to 30 (what POST /api/proposals accepts). */
export function clampOfferWindowDays(raw: string): number {
  const value = Math.round(Number(raw));
  return Number.isFinite(value) ? Math.min(30, Math.max(1, value)) : 1;
}

/** The preparation request body; the offer window is sent only for annual strategies, which the route requires. */
export const proposalBody = (objective: string, strategy: Strategy, offerWindowDays: number) =>
  ({ objective, strategy, ...(strategy.intervention.kind === "annual_plan" ? { offerWindowDays } : {}) });

/** Report column headings: an annual row shows the price read before the offer and the offer result, not a verification. */
export const reportColumns = (annual: boolean) =>
  annual ? { price: "Price before offer", result: "Result" } : { price: "Price now (read back)", result: "Verified" };

export interface OutcomeCells { price: string; status: string; verified: string; tone: "positive" | "negative" | "muted" }

/**
 * One execution-report row. An annual offer is issued, never verified at once: the customer decides in PayPal
 * and a later status read confirms any switch. A refused annual target shows its reason, not the read-back status.
 */
export function outcomeCells(outcome: TargetOutcome, annual: boolean): OutcomeCells {
  const price = outcome.observed?.regularPrice ? `$${outcome.observed.regularPrice}` : "—";
  if (annual && outcome.offer)
    return { price: "—", status: `Offer issued · window closes ${formatUtc(outcome.offer.expiresAt)}`, verified: "customer decides", tone: "muted" };
  if (annual) {
    // Only a definitive PayPal rejection, or a refusal before any PayPal call (no status, no debug ID), proves no offer exists.
    const noOffer = isDefinitiveFailure(outcome.httpStatus) || (outcome.httpStatus === null && outcome.debugId === null);
    return { price, status: outcome.error ?? outcome.observed?.status ?? "—", verified: noOffer ? "no offer" : "unconfirmed", tone: "negative" };
  }
  return { price, status: outcomeStatusText(outcome) ?? "—", verified: outcome.verified ? "yes" : "no", tone: outcome.verified ? "positive" : "negative" };
}

/** "Offer window closed", never "link dead": a link's real lifetime is untested (decision 0008). */
export function offerStatusLabel(offer: Pick<AnnualOfferView, "status" | "outcome">): string {
  if (offer.status === "switched") return "Switched (verified by PayPal)";
  if (offer.status === "pending") return "Pending customer decision";
  if (offer.status === "invalid") return "Needs administrator check (invalid deadline)";
  return offer.outcome === "declined" ? "Offer window closed · declined" : "Offer window closed · awaiting final check";
}

export function offerCounts(offers: Pick<AnnualOfferView, "outcome">[]) {
  return {
    accepted: offers.filter((o) => o.outcome === "accepted").length,
    declined: offers.filter((o) => o.outcome === "declined").length,
    awaiting: offers.filter((o) => o.outcome === "unresolved").length,
  };
}

/** One display-only draft from GET /api/annual-offers/links (administrators only). Its message carries a secret link. */
export interface OfferDraft { id: number; subscriptionId: string; label: string | null; expiresAt: string; message: string }

/** A draft whose window closed while on screen: only its name is kept, never the message or link. */
export interface ClosedDraft { id: number; name: string }

/** Drafts (or the failure) recorded against the fetch key they were requested for. */
export interface FetchedDrafts { key: string; drafts: OfferDraft[] | null; closed: ClosedDraft[]; error: string | null }

/** A draft's display name: its label, then the cohort label, then the subscription id. */
export const draftName = (draft: Pick<OfferDraft, "label" | "subscriptionId">, labels: Record<string, string>) =>
  draft.label ?? labels[draft.subscriptionId] ?? draft.subscriptionId;

/**
 * Identifies one drafts fetch: a new status refresh, a changed pending set or any administrator access change
 * (sign-in or sign-out) is a new fetch. Empty means fetch nothing: visitors, an unreadable status, or no pending
 * offer (decision 5: links only while pending).
 */
export function draftsFetchKey(input: {
  canReview: boolean; unavailable: boolean; revision: number; accessEpoch: number; offers: Pick<AnnualOfferView, "id" | "status">[];
}): string {
  const pending = input.offers.filter((offer) => offer.status === "pending").map((offer) => offer.id).join(",");
  return input.canReview && !input.unavailable && pending ? `${input.accessEpoch}.${input.revision}:${pending}` : "";
}

const pendingIds = (offers: Pick<AnnualOfferView, "id" | "status">[]) =>
  new Set(offers.filter((offer) => offer.status === "pending").map((offer) => offer.id));

/**
 * Drafts safe to show now: fetched for exactly the current key (so a refetch, failure or access change hides
 * the previous links at once) and still pending in the latest status read.
 */
export function visibleDrafts(fetched: FetchedDrafts | null, key: string, offers: Pick<AnnualOfferView, "id" | "status">[]): OfferDraft[] {
  if (!key || !fetched || fetched.key !== key || !fetched.drafts) return [];
  const pending = pendingIds(offers);
  return fetched.drafts.filter((draft) => pending.has(draft.id));
}

/** Drafts whose window closed on screen and whose offer the latest status read still calls pending. */
export function closedDrafts(fetched: FetchedDrafts | null, key: string, offers: Pick<AnnualOfferView, "id" | "status">[]): ClosedDraft[] {
  if (!key || !fetched || fetched.key !== key) return [];
  const pending = pendingIds(offers);
  return fetched.closed.filter((draft) => pending.has(draft.id));
}

/** Splits drafts at `nowMs`: closed ones keep only a name. `nextCloseAt` is the next open draft's window close. */
export function pruneDrafts(drafts: OfferDraft[], closed: ClosedDraft[], nowMs: number, labels: Record<string, string>) {
  const open = drafts.filter((draft) => Date.parse(draft.expiresAt) > nowMs);
  const newlyClosed = drafts.filter((draft) => !open.includes(draft)).map((draft) => ({ id: draft.id, name: draftName(draft, labels) }));
  const nextCloseAt = open.length ? Math.min(...open.map((draft) => Date.parse(draft.expiresAt))) : null;
  return { open, closed: [...closed, ...newlyClosed], nextCloseAt };
}

/** A 401 means the administrator session ended; anything else is a fixed, link-free message. */
export const draftsErrorMessage = (status: number | null) =>
  status === 401 ? "Your administrator session has ended. Sign in again to see the customer messages." : "Customer messages are unavailable.";

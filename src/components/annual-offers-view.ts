import { isDefinitiveFailure, outcomeStatusText, type TargetOutcome } from "@/execution/outcomes";
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
    const noOffer = outcome.httpStatus === null || isDefinitiveFailure(outcome.httpStatus);
    return { price, status: outcome.error ?? outcome.observed?.status ?? "—", verified: noOffer ? "no offer" : "unconfirmed", tone: "negative" };
  }
  return { price, status: outcomeStatusText(outcome) ?? "—", verified: outcome.verified ? "yes" : "no", tone: outcome.verified ? "positive" : "negative" };
}

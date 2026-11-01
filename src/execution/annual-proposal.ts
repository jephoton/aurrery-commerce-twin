import "server-only";
import { annualIneligibility } from "@/ledger/annual-offer-action";
import { getSetting } from "@/ledger/operations";
import {
  createAnnualOfferProposal, createProposal, listSandboxSubscribers, ProposalError,
  type CreateAnnualProposalInput, type CreateProposalInput, type Proposal, type SandboxSubscriber,
} from "@/ledger/proposals";
import { paypalConfigured } from "@/paypal/client";
import { getPlan, type PlanSnapshot } from "@/paypal/plans";
import { getSubscription, type Result, type SubscriptionSnapshot } from "@/paypal/subscriptions";
import type { Strategy } from "@/twin/interventions";
import type { StrategyResult } from "@/twin/simulate";
import { WorkerTaskError } from "@/twin/worker-client";

// Annual targets need live PayPal facts (ACTIVE, list price, monthly plan), unlike discounts, which
// snapshot the registry. Preparation only reads PayPal, outside any transaction; the repository then
// re-checks the registry, claims and open offers in one transaction and stores the exact hashed payload.

export const DEFAULT_OFFER_WINDOW_DAYS = 7;

export interface AnnualProposalInput { objective: string | null; strategy: Strategy; result: StrategyResult; listPrice: number; offerWindowDays: number }
export interface AnnualPreparationDependencies {
  configured: () => boolean;
  setting: (key: string) => Promise<string | null>;
  getPlan: (planId: string) => Promise<Result<PlanSnapshot>>;
  list: () => Promise<SandboxSubscriber[]>;
  read: (subscriptionId: string) => Promise<Result<SubscriptionSnapshot>>;
  create: (input: CreateAnnualProposalInput) => Promise<Proposal>;
}

export const PAYPAL_NOT_CONFIGURED_MESSAGE = "PayPal Sandbox is not configured; annual offers need live eligibility reads.";

const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new WorkerTaskError("ABORTED"); };

/**
 * Live eligibility at build time: same subscription, ACTIVE, on the registered monthly plan, at list price by cents.
 * Reads only. Any failed read proposes nothing, so a PayPal blip never silently narrows the targets.
 */
export async function prepareAnnualOfferProposalWith(input: AnnualProposalInput, deps: AnnualPreparationDependencies, signal?: AbortSignal): Promise<Proposal> {
  const iv = input.strategy.intervention;
  if (iv.kind !== "annual_plan") throw new ProposalError("Not an annual-plan strategy.", "NOT_EXECUTABLE");
  if (!deps.configured()) throw new ProposalError(PAYPAL_NOT_CONFIGURED_MESSAGE, "NOT_EXECUTABLE");
  throwIfAborted(signal);
  const [monthlyPlanId, productId] = await Promise.all([deps.setting("paypal.plan_id"), deps.setting("paypal.product_id")]);
  if (!monthlyPlanId || !productId) throw new ProposalError("The monthly plan and product are not registered; run paypal:setup.", "NOT_EXECUTABLE");
  const monthly = await deps.getPlan(monthlyPlanId);
  if (!monthly.ok || monthly.value.productId !== productId) throw new ProposalError("The registered monthly plan could not be verified against the product.", "NOT_EXECUTABLE");
  const listPrice = input.listPrice.toFixed(2);
  const segments = iv.segments as readonly string[];
  const pilots = (await deps.list()).filter((s) => segments.includes(s.segment));
  throwIfAborted(signal);
  // In parallel; results keep registry order, so the targets are deterministic.
  const reads = await Promise.all(pilots.map((pilot) => deps.read(pilot.subscriptionId).catch(() => null)));
  const unread = reads.filter((read) => !read?.ok).length;
  if (unread > 0) throw new ProposalError(`PayPal could not be read for ${unread} pilot(s); nothing was proposed. Try again.`, "NOT_EXECUTABLE");
  const eligibleIds = pilots.filter((pilot, i) => {
    const read = reads[i];
    return read?.ok === true && annualIneligibility(read.value, { subscriptionId: pilot.subscriptionId, monthlyPlanId, listPrice }) === null;
  }).map((pilot) => pilot.subscriptionId);
  throwIfAborted(signal);
  return deps.create({ ...input, productId, monthlyPlanId, eligibleIds });
}

export const prepareAnnualOfferProposal = (input: AnnualProposalInput, signal?: AbortSignal) => prepareAnnualOfferProposalWith(input, {
  configured: paypalConfigured, setting: getSetting, getPlan, list: listSandboxSubscribers, read: getSubscription, create: createAnnualOfferProposal,
}, signal);

/** The single "propose this strategy" entry point for the API and the agent. */
export async function proposeStrategy(input: CreateProposalInput & { offerWindowDays?: number }, signal?: AbortSignal): Promise<Proposal> {
  if (input.strategy.intervention.kind !== "annual_plan") return createProposal(input);
  return prepareAnnualOfferProposal({ objective: input.objective, strategy: input.strategy, result: input.result, listPrice: input.listPrice,
    offerWindowDays: input.offerWindowDays ?? DEFAULT_OFFER_WINDOW_DAYS }, signal);
}

import { compareStrategies } from "@/twin/simulate";
import { currentMerchant } from "@/merchant";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { initializeLedgerSchema, type LedgerConnection } from "@/ledger/connection";
import { createProposalRepository } from "@/ledger/proposals";
import { appendOfferReads, recordAnnualOffer } from "@/ledger/annual-offers";
import { offerExpiry } from "@/ledger/annual-offer-status";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";

// Shared offline fixture for annual-offer tests. Not a test file: Vitest includes only *.test.ts.

export const FIXTURE_MONTHLY_PLAN = "P-MONTHLY000000000000000001";
export const FIXTURE_ANNUAL_PLAN = "P-ANNUAL0000000000000000001";
export const FIXTURE_PRODUCT = "PROD-RIDGELINE0000000001";
/** Fake approval link; the token is not real. */
export const fixtureLink = (subscriptionId: string) =>
  `https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-FIXTURE${subscriptionId.replace("I-", "")}`;

/**
 * Registers Pilot D as I-PILOTD, then proposes, approves, claims and issues a one-target annual offer
 * through the real repository and recorder; optionally records a switched read.
 */
export async function seedAnnualOffer(connection: LedgerConnection, options: { offeredAt?: string; switchedAt?: string } = {}) {
  await initializeLedgerSchema(connection);
  const repo = createProposalRepository(connection);
  const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
  await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTD", ...PILOT_COHORT.find((pilot) => pilot.segment === "core")! });
  await connection.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('paypal.plan_id', ?)", [FIXTURE_MONTHLY_PLAN]);
  const result = compareStrategies(currentMerchant().twin, [strategy], { runs: 2, horizonMonths: 1 }).strategies[1];
  const proposal = await repo.createAnnualOfferProposal({
    objective: "Annual fixture", strategy, result, listPrice: 24, productId: FIXTURE_PRODUCT,
    monthlyPlanId: FIXTURE_MONTHLY_PLAN, offerWindowDays: 7, eligibleIds: ["I-PILOTD"],
  });
  await repo.approveProposal(proposal.id, proposal.actionHash, "fixture administrator");
  await repo.claimForExecution(proposal.id);
  const offeredAt = options.offeredAt ?? "2026-11-01T00:00:00.000Z";
  const expiresAt = offerExpiry(offeredAt, 7);
  const offerId = await recordAnnualOffer({
    proposalId: proposal.id, subscriptionId: "I-PILOTD", segment: "core", annualPlanId: FIXTURE_ANNUAL_PLAN, approvalUrl: fixtureLink("I-PILOTD"),
    offeredAt, expiresAt, request: { subscriptionId: "I-PILOTD", operation: "revise", planId: FIXTURE_ANNUAL_PLAN },
    outcome: {
      subscriptionId: "I-PILOTD", ok: true, httpStatus: 200, debugId: "dbg-fixture", verified: false, observed: null, error: null,
      offer: { annualPlanId: FIXTURE_ANNUAL_PLAN, expiresAt },
    },
  }, connection);
  await repo.finishExecution(proposal.id, "succeeded", null, { succeeded: 1, total: 1 });
  if (options.switchedAt) await appendOfferReads("I-PILOTD", { status: "ACTIVE", planId: FIXTURE_ANNUAL_PLAN, debugId: "dbg-read" }, options.switchedAt, connection);
  return { proposal, offerId, expiresAt };
}

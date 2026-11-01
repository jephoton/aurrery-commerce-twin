import "server-only";
import { currentMerchant } from ".";
import { readDiscountOutcomes, OUTCOME_LIMITATION } from "@/ledger/discount-outcomes";
import { ANNUAL_OFFER_LIMITATION, readAnnualOfferEvidence } from "@/ledger/annual-offers";
import type { LedgerConnection } from "@/ledger/connection";
import { updateAnnualUptake, updateDiscountEffect } from "@/twin/calibrate";

/**
 * Request-owned copy calibrated once against the canonical baseline, never a mutable singleton.
 * Discount outcomes and resolved annual offers are separate evidence, each with its own limitation;
 * unresolved offers are counted for display but never move the twin.
 */
export async function observedMerchant(connection?: LedgerConnection, now?: string) {
  const canonical = structuredClone(currentMerchant());
  const evidence = await readDiscountOutcomes(connection, now);
  const discount = updateDiscountEffect(canonical.twin, evidence.observations);
  for (const change of discount.changes) discount.twin.provenance[change.parameter].note += ` ${OUTCOME_LIMITATION}`;
  const offers = await readAnnualOfferEvidence(connection, now);
  const learned = updateAnnualUptake(discount.twin, offers.offers.map(({ segment, accepted, declined }) => ({ segment, accepted, declined })));
  for (const change of learned.changes) learned.twin.provenance[change.parameter].note += ` ${ANNUAL_OFFER_LIMITATION}`;
  return { ...canonical, twin: learned.twin, changes: discount.changes, evidence, annual: { offers: offers.offers, changes: learned.changes, limitation: offers.limitation } };
}

import "server-only";
import { currentMerchant } from ".";
import { readDiscountOutcomes, OUTCOME_LIMITATION } from "@/ledger/discount-outcomes";
import type { LedgerConnection } from "@/ledger/connection";
import { updateDiscountEffect } from "@/twin/calibrate";

/** Request-owned copy calibrated once against the canonical baseline, never a mutable singleton. */
export async function observedMerchant(connection?: LedgerConnection, now?: string) {
  const canonical = structuredClone(currentMerchant());
  const evidence = await readDiscountOutcomes(connection, now);
  const updated = updateDiscountEffect(canonical.twin, evidence.observations);
  for (const change of updated.changes) updated.twin.provenance[change.parameter].note += ` ${OUTCOME_LIMITATION}`;
  return { ...canonical, ...updated, evidence };
}

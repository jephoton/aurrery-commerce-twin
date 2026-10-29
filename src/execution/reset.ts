import "server-only";
import type { SandboxSubscriber, ResetAction, Proposal } from "@/ledger/proposals";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import { sameUsdAmount, usdCents } from "@/paypal/prices";
import { createResetProposal, ProposalError, ResetRegistrationSnapshotSchema } from "@/ledger/proposals";
import { runtimeLedgerConnection } from "@/ledger/connection";
import { authoritativeWrite } from "@/ledger/operations";
import { getSubscription } from "@/paypal/subscriptions";
import { currentMerchant } from "@/merchant";

export type ResetPreview = { proposal: Proposal | null; skipped: { label: string; subscriptionId: string | null; reason: "already_list_price" | "inactive" | "unregistered" }[] };
export type ResetDependencies = {
  list: () => Promise<SandboxSubscriber[]>;
  registrations: () => Promise<Record<string, string>>;
  read: (id: string) => Promise<Result<SubscriptionSnapshot>>;
  create: (price: string, targets: ResetAction["targets"]) => Promise<Proposal>;
  listPrice: () => number;
};

export async function previewDemoResetWith(deps: ResetDependencies): Promise<ResetPreview> {
  const canonicalListPrice = deps.listPrice().toFixed(2);
  if (usdCents(canonicalListPrice) === null || usdCents(canonicalListPrice) === 0)
    throw new ProposalError("Canonical list price is invalid.", "INVALID_STATE");
  const registered = await deps.list();
  const dates = await deps.registrations();
  // Validate every expected registration before any PayPal read or skip report.
  // A pilot can be skipped at its current price/status only after its authority is valid.
  const resolved = PILOT_COHORT.map((member) => {
    const matches = registered.filter((row) => row.label === member.label);
    if (matches.length > 1) throw new ProposalError("Duplicate pilot registration.", "INVALID_STATE");
    if (!matches.length) return { member, pilot: null };
    const pilot = matches[0];
    const snapshot = ResetRegistrationSnapshotSchema.safeParse({ subscriptionId: pilot.subscriptionId, registration: {
      label: pilot.label, segment: pilot.segment, reason: pilot.reason, createdAt: dates[pilot.subscriptionId],
    } });
    if (!snapshot.success || snapshot.data.registration.segment !== member.segment || snapshot.data.registration.reason !== member.reason)
      throw new ProposalError("Pilot registration is inconsistent.", "INVALID_STATE");
    return { member, pilot: snapshot.data };
  });
  const ids = resolved.flatMap(({ pilot }) => pilot ? [pilot.subscriptionId] : []);
  if (new Set(ids).size !== ids.length) throw new ProposalError("Duplicate pilot identity.", "INVALID_STATE");
  const targets: ResetAction["targets"] = [];
  const skipped: ResetPreview["skipped"] = [];
  for (const { member, pilot } of resolved) {
    if (!pilot) { skipped.push({ label: member.label, subscriptionId: null, reason: "unregistered" }); continue; }
    const read = await deps.read(pilot.subscriptionId);
    if (!read.ok || read.value.id !== pilot.subscriptionId) throw new ProposalError("Pilot PayPal status could not be verified.", "INVALID_STATE");
    if (read.value.status !== "ACTIVE") { skipped.push({ label: member.label, subscriptionId: pilot.subscriptionId, reason: "inactive" }); continue; }
    if (usdCents(read.value.regularPrice) === null) throw new ProposalError("Pilot price could not be verified.", "INVALID_STATE");
    if (sameUsdAmount(read.value.regularPrice, canonicalListPrice)) { skipped.push({ label: member.label, subscriptionId: pilot.subscriptionId, reason: "already_list_price" }); continue; }
    targets.push({ subscriptionId: pilot.subscriptionId, expectedCurrentPrice: read.value.regularPrice!,
      registration: pilot.registration });
  }
  return { proposal: targets.length ? await deps.create(canonicalListPrice, targets) : null, skipped };
}

export async function previewDemoReset(): Promise<ResetPreview> {
  // Read one raw registry snapshot. The general display reader normalizes invalid legacy
  // reasons, which must never turn malformed reset authority into a valid no-op.
  const rows = await authoritativeWrite(await runtimeLedgerConnection(), (tx) =>
    tx.query("SELECT subscription_id,label,segment,reason,created_at FROM sandbox_subscribers ORDER BY rowid"));
  const registered = rows.map((row) => ({ subscriptionId: String(row.subscription_id), label: String(row.label),
    segment: String(row.segment), reason: String(row.reason) as SandboxSubscriber["reason"] }));
  const dates = Object.fromEntries(rows.map((row) => [String(row.subscription_id), String(row.created_at)]));
  return previewDemoResetWith({ list: async () => registered, read: getSubscription, create: createResetProposal,
    listPrice: () => currentMerchant().twin.params.listPrice,
    registrations: async () => dates,
  });
}

import "server-only";
import { listSandboxSubscribers, registerSandboxSubscriber, replaceSandboxSubscription } from "@/ledger/proposals";
import { getSetting } from "@/ledger/operations";
import { recordObservation } from "@/execution/execute";
import { paypal } from "./client";
import { getSubscription, type SubscriptionSnapshot } from "./subscriptions";
import type { PayPalFailure } from "./client";

export const PILOT_COHORT = [
  { label: "Pilot A: \"honestly it's just too expensive right now\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot B: \"can't justify $24 a month anymore\"", segment: "cancel_intent", reason: "price" },
  { label: "Pilot C: \"moving abroad next month\"", segment: "cancel_intent", reason: "other" },
  { label: "Pilot D: loyal, 14 months", segment: "core", reason: "other" },
] as const;

function readFailure(id: string, error: PayPalFailure): string {
  return `PayPal read failed for ${id} (HTTP ${error.httpStatus ?? "unavailable"}; ${error.name}${error.debugId ? `; debug ${error.debugId}` : ""})`;
}

function approvalLink(raw: unknown): string | undefined {
  const links = (raw as { links?: { rel?: string; href?: string }[] } | null)?.links;
  return links?.find((link) => link.rel === "approve")?.href;
}

function verifyReadbackId(snapshot: SubscriptionSnapshot, expectedId: string): void {
  // The wrapper's normalized ID can fall back to the requested ID. Require PayPal's actual ID too.
  const actualId = (snapshot.raw as { id?: unknown } | null)?.id;
  if (snapshot.id !== expectedId || actualId !== expectedId) {
    throw new Error(`Subscription read-back ID missing or mismatched for ${expectedId}; no registration changed.`);
  }
}

function describe(label: string, snapshot: SubscriptionSnapshot, fallback?: unknown): string {
  const status = `${label} ${snapshot.id} ${snapshot.status}`;
  if (snapshot.status !== "APPROVAL_PENDING") return status;
  const approve = approvalLink(snapshot.raw) ?? approvalLink(fallback);
  if (!approve) throw new Error(`${snapshot.id} is APPROVAL_PENDING but has no approval link; rerun setup to read its current link.`);
  return `${status}\n  approve as a sandbox buyer: ${approve}`;
}

/** Replays a missing pilot only on explicit opt-in, using its recorded creation intent. */
export async function setupPilots(options: {
  planId: string;
  returnUrl: string;
  recoverMissing?: boolean;
  onMessage?: (message: string) => void;
}): Promise<string[]> {
  const registered = await listSandboxSubscribers();
  for (const member of PILOT_COHORT) {
    if (registered.filter((row) => row.label === member.label).length > 1) {
      throw new Error(`Multiple registrations for ${member.label}; resolve duplicate labels before setup.`);
    }
  }
  const messages: string[] = [];
  for (const [i, member] of PILOT_COHORT.entries()) {
    const existing = registered.find((row) => row.label === member.label);
    let snapshot: SubscriptionSnapshot | undefined;
    if (existing) {
      const read = await getSubscription(existing.subscriptionId);
      if (read.ok) {
        verifyReadbackId(read.value, existing.subscriptionId);
        snapshot = read.value;
      } else {
        if (read.error.httpStatus !== 404) throw new Error(readFailure(existing.subscriptionId, read.error));
        if (!options.recoverMissing) {
          throw new Error(`${readFailure(existing.subscriptionId, read.error)}. Rerun with --recover-missing to replay only confirmed missing pilots using their recorded creation request IDs.`);
        }
      }
    }
    let created: unknown;
    if (!snapshot) {
      const requestId = await getSetting(`paypal.pilot.${i}.request_id`) ?? `aurrery-ridgeline-sub-${i}-v1`;
      const returnUrl = await getSetting(`paypal.pilot.${i}.return_url`) ?? options.returnUrl;
      const response = await paypal().subscriptions.createSubscription({
        paypalRequestId: requestId,
        prefer: "return=representation",
        body: {
          planId: options.planId,
          customId: `pilot-${i}`,
          applicationContext: { brandName: "Ridgeline Roasters", returnUrl, cancelUrl: returnUrl },
        },
      });
      created = response.result;
      const id = response.result.id;
      if (!id) throw new Error(`Create subscription returned no ID for ${member.label}; no registration changed.`);
      const read = await getSubscription(id);
      if (!read.ok) throw new Error(`Subscription read-back failed; no registration changed. ${readFailure(id, read.error)}`);
      verifyReadbackId(read.value, id);
      snapshot = read.value;
      // Validate pending approval instructions before making the new registration durable.
      describe(member.label, snapshot, created);
      if (existing) await replaceSandboxSubscription(existing.subscriptionId, existing.label, id);
      else await registerSandboxSubscriber({ ...member, subscriptionId: id });
    }
    const message = describe(member.label, snapshot, created);
    messages.push(message);
    options.onMessage?.(message);
  }
  return messages;
}

export async function syncPilots(onMessage?: (message: string) => void): Promise<void> {
  let failed = 0;
  for (const subscriber of await listSandboxSubscribers()) {
    const read = await getSubscription(subscriber.subscriptionId);
    if (!read.ok) {
      failed++;
      onMessage?.(readFailure(subscriber.subscriptionId, read.error));
      continue;
    }
    await recordObservation(read.value, "paypal.sync");
    onMessage?.(`${subscriber.subscriptionId} ${subscriber.segment}/${subscriber.reason} ${read.value.status} price ${read.value.regularPrice ?? "(plan default)"} overridden ${read.value.planOverridden} next ${read.value.nextBillingTime}`);
  }
  if (failed) throw new Error(`${failed} subscription read(s) failed during sync; resolve failures before executing changes.`);
}

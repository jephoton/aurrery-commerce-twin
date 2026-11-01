import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createLocalConnection } from "@/ledger/connection";
import { OUTCOME_LIMITATION } from "@/ledger/discount-outcomes";
import { ANNUAL_OFFER_LIMITATION } from "@/ledger/annual-offers";
import { seedAnnualOffer } from "@/test/annual-offer-fixture";
import { currentMerchant } from ".";
import { observedMerchant } from "./observed";
import { ObservedSnapshotSchema, toObservedSnapshot } from "./observed-snapshot";

async function view(switchedAt?: string) {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db);
    await seedAnnualOffer(connection, { switchedAt });
    return await observedMerchant(connection, "2026-11-02T00:00:00.000Z");
  } finally { db.close(); }
}

it("learns core annual uptake from a verified switch on a request-owned copy, separate from discount changes", async () => {
  const before = currentMerchant().twin.params.segments.core.annualUptake;
  const observed = await view("2026-11-01T00:10:00.000Z");
  expect(observed.twin.params.segments.core.annualUptake).toEqual({ alpha: before.alpha + 1, beta: before.beta });
  expect(currentMerchant().twin.params.segments.core.annualUptake).toEqual(before);
  expect(currentMerchant().twin.provenance).not.toHaveProperty(["segments.core.annualUptake"]);
  expect(observed.changes).toEqual([]);
  expect(observed.annual.offers).toEqual([{ segment: "core", accepted: 1, declined: 0, unresolved: 0 }]);
  expect(observed.annual.changes.map((change) => change.parameter)).toEqual(["segments.core.annualUptake"]);
  expect(observed.annual.limitation).toBe(ANNUAL_OFFER_LIMITATION);
  const note = observed.twin.provenance["segments.core.annualUptake"];
  expect(note).toMatchObject({ source: "observed", evidenceCount: 1 });
  expect(note.note).toContain("Core");
  expect(note.note).toContain("not a randomized");
  expect(note.note).not.toContain(OUTCOME_LIMITATION);
  const snapshot = toObservedSnapshot(observed);
  expect(snapshot.annual?.changes).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toMatch(/ba_token|https?:/);
});

it("leaves the twin unchanged while every offer is unresolved", async () => {
  const observed = await view();
  expect(observed.annual.offers).toEqual([{ segment: "core", accepted: 0, declined: 0, unresolved: 1 }]);
  expect(observed.annual.changes).toEqual([]);
  expect(observed.twin.params.segments.core.annualUptake).toEqual(currentMerchant().twin.params.segments.core.annualUptake);
  expect(observed.twin.provenance).not.toHaveProperty(["segments.core.annualUptake"]);
  expect(observed.twin.provenance.annualUptake.note).not.toContain("no annual plan has been tried");
});

it("still accepts run snapshots recorded before annual evidence existed", () => {
  const legacy = { evidence: { episodes: 0, cancellations: 0, censoredEpisodes: 0, subscriberMonths: 0, posteriorSubscriberMonths: 0, posteriorCancellations: 0, limitation: "x" }, changes: [], provenance: {} };
  expect(ObservedSnapshotSchema.parse(legacy)).not.toHaveProperty("annual");
});

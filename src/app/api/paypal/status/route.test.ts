import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";

const mocks = vi.hoisted(() => ({ getSubscription: vi.fn(), configured: vi.fn(() => true), recordObservation: vi.fn(), calls: [] as string[] }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => { mocks.calls.push("connection"); }) }));
vi.mock("@/paypal/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/client")>()), paypalConfigured: mocks.configured }));
vi.mock("@/execution/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/execution/execute")>();
  mocks.recordObservation.mockImplementation(actual.recordObservation);
  return { ...actual, recordObservation: mocks.recordObservation };
});
vi.mock("@/paypal/subscriptions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/subscriptions")>()), getSubscription: mocks.getSubscription }));

import { ledger } from "@/ledger/db";
import { createLocalConnection, runtimeLedgerConnection } from "@/ledger/connection";
import { createProposalRepository } from "@/ledger/proposals";
import { createHostingStore } from "@/hosting/store";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import { appendOfferReads, listAnnualOfferViews } from "@/ledger/annual-offers";
import { FIXTURE_ANNUAL_PLAN, FIXTURE_MONTHLY_PLAN, seedAnnualOffer } from "@/test/annual-offer-fixture";
import { GET } from "./route";

const HOUR = 3_600_000;
const live = (id: string, planId: string): Result<SubscriptionSnapshot> => ({ ok: true, debugId: "dbg-status",
  value: { id, status: "ACTIVE", planId, planOverridden: false, regularPrice: planId === FIXTURE_ANNUAL_PLAN ? "244.8" : "24.0", nextBillingTime: "2026-11-30T10:00:00Z", lastPayment: null, raw: {} } });
const status = async () => (await GET(new Request("http://localhost/api/paypal/status"))).json();
const reads = () => ledger().prepare("SELECT status, plan_id, debug_id FROM annual_offer_reads ORDER BY id").all();
const observedAt = () => (ledger().prepare("SELECT observed_at FROM annual_offer_reads ORDER BY id").all() as { observed_at: string }[]).map((r) => r.observed_at);
const clear = () => ledger().exec("DELETE FROM annual_offer_reads; DELETE FROM annual_offers; DELETE FROM active_target_claims; DELETE FROM executions; DELETE FROM observations; DELETE FROM audit_events; DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM kv;");
/** Re-seed an offer whose window plus grace has passed, with a confirming monthly read: a confirmed decline. */
const seedDeclined = async () => {
  clear();
  const connection = await runtimeLedgerConnection();
  await seedAnnualOffer(connection, { offeredAt: new Date(Date.now() - 7 * 24 * HOUR - 7 * HOUR).toISOString() });
  await appendOfferReads("I-PILOTD", { status: "ACTIVE", planId: FIXTURE_MONTHLY_PLAN, debugId: "dbg-confirm" }, new Date(Date.now() - 600_000).toISOString(), connection);
  expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ status: "expired", outcome: "declined", needsRead: false })]);
};

afterEach(() => { vi.unstubAllEnvs(); });

beforeEach(async () => {
  clear();
  mocks.getSubscription.mockReset();
  mocks.configured.mockReturnValue(true);
  mocks.calls.length = 0;
  mocks.recordObservation.mockClear();
  await seedAnnualOffer(await runtimeLedgerConnection(), { offeredAt: new Date(Date.now() - HOUR).toISOString() });
});

it("appends a read per offer on each successful GET and reports the switch without any link", async () => {
  mocks.getSubscription.mockImplementation(async (id: string) => { mocks.calls.push("paypal"); return live(id, FIXTURE_ANNUAL_PLAN); });
  const body = await status();
  await status();
  expect(mocks.calls.slice(0, 2)).toEqual(["connection", "paypal"]);
  expect(body.annualOffers).toEqual([expect.objectContaining({ subscriptionId: "I-PILOTD", status: "switched", outcome: "accepted", needsRead: false })]);
  expect(body.subscriptions[0].live).toMatchObject({ annualPlan: true, regularPrice: "244.8" });
  expect(JSON.stringify(body)).not.toMatch(/ba_token|BA-FIXTURE|paypal\.com|approval/i);
  expect(reads()).toEqual([
    { status: "ACTIVE", plan_id: FIXTURE_ANNUAL_PLAN, debug_id: "dbg-status" },
    { status: "ACTIVE", plan_id: FIXTURE_ANNUAL_PLAN, debug_id: "dbg-status" },
  ]);
  for (const at of observedAt()) expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

it("returns annual evidence counts, uptake changes and limitation built after the offer reads, with no link", async () => {
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_ANNUAL_PLAN));
  const body = await status();
  expect(body.annualEvidence.offers).toEqual([expect.objectContaining({ segment: expect.any(String), accepted: 1, declined: 0, unresolved: 0 })]);
  expect(body.annualEvidence.changes).toEqual([expect.objectContaining({ parameter: expect.stringMatching(/^segments\..+\.annualUptake$/) })]);
  expect(body.annualEvidence.limitation).toContain("not a randomized uptake estimate");
  expect(JSON.stringify(body.annualEvidence)).not.toMatch(/ba_token|BA-FIXTURE|paypal\.com|approval|https?:/i);
});

it("records nothing for a failed GET and keeps the offer pending", async () => {
  mocks.getSubscription.mockResolvedValue({ ok: false, error: { httpStatus: 503, name: "UNAVAILABLE", message: "down", debugId: null, details: null } });
  const body = await status();
  expect(reads()).toEqual([]);
  expect(body.subscriptions[0]).toMatchObject({ error: "Live status unavailable." });
  expect(body.annualOffers[0]).toMatchObject({ status: "pending", needsRead: true });
});

it("still reads a registered subscriber after a confirmed decline, because a stale link can still be approved", async () => {
  await seedDeclined();
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_ANNUAL_PLAN));
  const body = await status();
  expect(reads()).toHaveLength(2);
  expect(body.annualOffers).toEqual([expect.objectContaining({ status: "switched", outcome: "accepted" })]);
});

it("still reads a subscription with an open offer after it left the pilot registry", async () => {
  ledger().exec("DELETE FROM sandbox_subscribers;");
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_MONTHLY_PLAN));
  const body = await status();
  expect(mocks.getSubscription).toHaveBeenCalledWith("I-PILOTD");
  expect(body.subscriptions).toEqual([]);
  expect(reads()).toEqual([{ status: "ACTIVE", plan_id: FIXTURE_MONTHLY_PLAN, debug_id: "dbg-status" }]);
});

it("does not read an unregistered subscriber whose decline is confirmed", async () => {
  await seedDeclined();
  ledger().exec("DELETE FROM sandbox_subscribers;");
  const body = await status();
  expect(mocks.getSubscription).not.toHaveBeenCalled();
  expect(reads()).toHaveLength(1);
  expect(body.annualOffers).toEqual([expect.objectContaining({ outcome: "declined" })]);
});

it("reads nothing from PayPal when it is not configured, yet still reports offer views", async () => {
  mocks.configured.mockReturnValue(false);
  const body = await status();
  expect(mocks.getSubscription).not.toHaveBeenCalled();
  expect(reads()).toEqual([]);
  expect(body).toMatchObject({ configured: false, annualOffers: [expect.objectContaining({ status: "pending" })] });
  expect(JSON.stringify(body)).not.toMatch(/ba_token|BA-FIXTURE/);
});

it("still records the offer read when the observation write fails after a successful GET", async () => {
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_ANNUAL_PLAN));
  mocks.recordObservation.mockRejectedValueOnce(new Error("observation storage failed"));
  await GET(new Request("http://localhost/api/paypal/status"));
  expect(reads()).toEqual([{ status: "ACTIVE", plan_id: FIXTURE_ANNUAL_PLAN, debug_id: "dbg-status" }]);
});

it("records nothing when PayPal returns a different subscription than the one requested", async () => {
  mocks.getSubscription.mockImplementation(async () => live("I-SOMEONEELSE", FIXTURE_ANNUAL_PLAN));
  const body = await status();
  expect(reads()).toEqual([]);
  expect(mocks.recordObservation).not.toHaveBeenCalled();
  expect(body.subscriptions[0]).toMatchObject({ subscriptionId: "I-PILOTD", error: "Live status unavailable." });
  expect(body.annualOffers[0]).toMatchObject({ status: "pending", needsRead: true });
});

it("reads registered and unregistered needs-read subscriptions in one PayPal round", async () => {
  ledger().exec("DELETE FROM sandbox_subscribers;");
  await createProposalRepository(await runtimeLedgerConnection()).registerSandboxSubscriber({ subscriptionId: "I-PILOTA", ...PILOT_COHORT[0] });
  let inFlight = 0;
  let maxInFlight = 0;
  mocks.getSubscription.mockImplementation(async (id: string) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return live(id, FIXTURE_MONTHLY_PLAN);
  });
  const body = await status();
  expect(mocks.getSubscription.mock.calls.map(([id]) => id).sort()).toEqual(["I-PILOTA", "I-PILOTD"]);
  expect(maxInFlight).toBe(2);
  expect(body.subscriptions).toEqual([expect.objectContaining({ subscriptionId: "I-PILOTA" })]);
  expect(reads()).toEqual([{ status: "ACTIVE", plan_id: FIXTURE_MONTHLY_PLAN, debug_id: "dbg-status" }]);
});

it("appends no reads when hosted admission rejects the poll", async () => {
  const secret = "s".repeat(48);
  vi.stubEnv("HOSTED_DEMO", "true"); vi.stubEnv("RENDER", "false"); vi.stubEnv("APP_URL", "https://example.test");
  vi.stubEnv("HOSTED_SECRET", secret); vi.stubEnv("ADMIN_PASSWORD", "p".repeat(40));
  // Satisfies hosted configuration only: the in-memory ledger is already open and stays in use.
  vi.stubEnv("LEDGER_PATH", join(tmpdir(), "aurrery-status-route-unused.sqlite"));
  const store = createHostingStore(createLocalConnection(ledger()), secret);
  for (let i = 0; i < 30; i++) expect((await store.admit("poll", "unverified-proxy-client")).allowed).toBe(true);
  mocks.getSubscription.mockImplementation(async (id: string) => live(id, FIXTURE_ANNUAL_PLAN));
  const response = await GET(new Request("https://example.test/api/paypal/status"));
  expect(response.status).toBe(429);
  expect(mocks.getSubscription).not.toHaveBeenCalled();
  expect(reads()).toEqual([]);
});

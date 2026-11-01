import { beforeEach, expect, it, vi } from "vitest";
import type { Result, SubscriptionSnapshot } from "@/paypal/subscriptions";

const mocks = vi.hoisted(() => ({ getSubscription: vi.fn(), configured: vi.fn(() => true), calls: [] as string[] }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => { mocks.calls.push("connection"); }) }));
vi.mock("@/paypal/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/client")>()), paypalConfigured: mocks.configured }));
vi.mock("@/paypal/subscriptions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/subscriptions")>()), getSubscription: mocks.getSubscription }));

import { ledger } from "@/ledger/db";
import { runtimeLedgerConnection } from "@/ledger/connection";
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

beforeEach(async () => {
  clear();
  mocks.getSubscription.mockReset();
  mocks.configured.mockReturnValue(true);
  mocks.calls.length = 0;
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

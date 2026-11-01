import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  calls: [] as string[], listFails: false,
  errorLink: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TESTERROR",
}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => { mocks.calls.push("connection"); }) }));
// Visitors' status refresh must not reach PayPal from this file.
vi.mock("@/paypal/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/paypal/client")>()), paypalConfigured: () => false }));
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return {
    ...actual,
    listAnnualOfferLinks: vi.fn(async (...args: Parameters<typeof actual.listAnnualOfferLinks>) => {
      mocks.calls.push("links");
      if (mocks.listFails) throw new Error(`storage failed near ${mocks.errorLink}`);
      return actual.listAnnualOfferLinks(...args);
    }),
  };
});

import { ledger } from "@/ledger/db";
import { createLocalConnection, runtimeLedgerConnection } from "@/ledger/connection";
import { appendOfferReads, listAnnualOfferViews } from "@/ledger/annual-offers";
import { createHostingStore } from "@/hosting/store";
import { FIXTURE_MONTHLY_PLAN, fixtureLink, seedAnnualOffer } from "@/test/annual-offer-fixture";
import { GET as status } from "@/app/api/paypal/status/route";
import { GET } from "./route";

const HOUR = 3_600_000;
const LINK = /ba_token|BA-FIXTURE|BA-TEST|paypal\.com/i;
const dir = mkdtempSync(join(tmpdir(), "aurrery-offer-links-"));
const origin = "https://example.test";
const url = `${origin}/api/annual-offers/links`;
const request = (cookie?: string) => new Request(url, { headers: cookie ? { cookie } : undefined });
const adminCookie = async () => `__Host-aurrery-admin=${await createHostingStore(createLocalConnection(ledger()), "s".repeat(48)).createSession("p".repeat(40))}`;
const clear = () => ledger().exec("DELETE FROM annual_offer_reads; DELETE FROM annual_offers; DELETE FROM active_target_claims; DELETE FROM executions; DELETE FROM observations; DELETE FROM audit_events; DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM kv;");
const seedPending = async () => seedAnnualOffer(await runtimeLedgerConnection(), { offeredAt: new Date(Date.now() - HOUR).toISOString() });
const adminOffers = async () => {
  const response = await GET(request(await adminCookie()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).offers as { id: number; subscriptionId: string; label: string | null; expiresAt: string; message: string }[];
};

beforeAll(() => {
  vi.stubEnv("HOSTED_DEMO", "true"); vi.stubEnv("RENDER", "false"); vi.stubEnv("APP_URL", origin);
  vi.stubEnv("HOSTED_SECRET", "s".repeat(48)); vi.stubEnv("ADMIN_PASSWORD", "p".repeat(40));
  vi.stubEnv("LEDGER_PATH", join(dir, "ledger.sqlite"));
});
beforeEach(async () => {
  await runtimeLedgerConnection();
  clear();
  mocks.calls.length = 0;
  mocks.listFails = false;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => { ledger().close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("hosted visitors", () => {
  it("get the existing unauthorized response, with no link or hint of one, before any secret is read", async () => {
    await seedPending();
    const forged = `__Host-aurrery-admin=${"A".repeat(43)}`;
    for (const response of [await GET(request()), await GET(request("__Host-aurrery-admin=fake")), await GET(request(forged))]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "ADMIN_REQUIRED" });
    }
    expect(mocks.calls).not.toContain("links");
  });

  it("see the same public status payload, which never carries a link while an offer is open", async () => {
    await seedPending();
    const response = await status(new Request(`${origin}/api/paypal/status`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.annualOffers).toEqual([expect.objectContaining({ subscriptionId: "I-PILOTD", status: "pending" })]);
    expect(JSON.stringify(body)).not.toMatch(LINK);
  });
});

describe("administrators", () => {
  it("get an uncached draft carrying the link of each pending offer, after connection()", async () => {
    const { offerId, expiresAt } = await seedPending();
    const offers = await adminOffers();
    expect(mocks.calls.slice(0, 2)).toEqual(["connection", "links"]);
    expect(offers).toEqual([{
      id: offerId, subscriptionId: "I-PILOTD", label: expect.stringContaining("Pilot D"), expiresAt,
      message: expect.stringContaining(fixtureLink("I-PILOTD")),
    }]);
    expect(offers[0].message).toContain("Ridgeline Roasters");
    expect(offers[0].message).toContain("next renewal date");
    expect(offers[0].message).toContain("$244.80 a year");
    expect(offers[0].message).toContain("UTC");
  });

  it("get no link for a switched offer", async () => {
    await seedAnnualOffer(await runtimeLedgerConnection(), { offeredAt: new Date(Date.now() - 2 * HOUR).toISOString(), switchedAt: new Date(Date.now() - HOUR).toISOString() });
    expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ status: "switched" })]);
    expect(await adminOffers()).toEqual([]);
  });

  it("get no link once the offer window has closed, confirmed or not", async () => {
    const connection = await runtimeLedgerConnection();
    // Past the window and its six-hour grace: unresolved until a confirming read, then a confirmed decline.
    await seedAnnualOffer(connection, { offeredAt: new Date(Date.now() - 7 * 24 * HOUR - 7 * HOUR).toISOString() });
    expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ status: "expired", outcome: "unresolved" })]);
    expect(await adminOffers()).toEqual([]);
    await appendOfferReads("I-PILOTD", { status: "ACTIVE", planId: FIXTURE_MONTHLY_PLAN, debugId: "dbg-confirm" }, new Date(Date.now() - 600_000).toISOString(), connection);
    expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ status: "expired", outcome: "declined" })]);
    expect(await adminOffers()).toEqual([]);
  });

  it("get no link for an offer whose stored window is unreadable", async () => {
    const { offerId } = await seedPending();
    ledger().prepare("UPDATE annual_offers SET expires_at = 'not a time' WHERE id = ?").run(offerId);
    expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ status: "invalid" })]);
    expect(await adminOffers()).toEqual([]);
  });

  it("get drafts for pending offers only when closed and open offers coexist", async () => {
    const connection = await runtimeLedgerConnection();
    await seedAnnualOffer(connection, { offeredAt: new Date(Date.now() - 7 * 24 * HOUR - 7 * HOUR).toISOString() });
    await appendOfferReads("I-PILOTD", { status: "ACTIVE", planId: FIXTURE_MONTHLY_PLAN, debugId: "dbg-confirm" }, new Date(Date.now() - 600_000).toISOString(), connection);
    expect(await listAnnualOfferViews()).toEqual([expect.objectContaining({ outcome: "declined" })]);
    const { offerId } = await seedPending();
    expect((await listAnnualOfferViews()).map((view) => view.status).sort()).toEqual(["expired", "pending"]);
    const offers = await adminOffers();
    expect(offers.map((offer) => offer.id)).toEqual([offerId]);
    expect(offers[0].message).toContain(fixtureLink("I-PILOTD"));
  });

  it("get a fixed error that never carries a link, and nothing is logged", async () => {
    await seedPending();
    mocks.listFails = true;
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const response = await GET(request(await adminCookie()));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "INTERNAL", message: "Request unavailable." });
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});

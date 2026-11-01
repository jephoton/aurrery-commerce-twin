import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import type { TargetOutcome } from "@/execution/outcomes";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "./annual-offer-action";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema, type LedgerConnection, type LedgerExecutor } from "./connection";
import { assertCanonicalTargetSchema } from "./import";
import {
  appendOfferReads, listAnnualOfferLinks, listAnnualOfferViews, listAnnualPlanIds, openOfferSubscriptionIds,
  readAnnualOfferEvidence, recordAnnualOffer, recordAnnualTarget,
} from "./annual-offers";

const PROPOSAL = "prop_00000000-0000-4000-8000-0000000000a1";
const ANNUAL = "P-ANNUAL0000000000000000001";
const MONTHLY = "P-MONTHLY000000000000000001";
const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST";
const OFFERED = "2026-11-01T00:00:00.000Z";
const EXPIRES = "2026-11-08T00:00:00.000Z";
const CREATED = "2026-10-22T00:00:00.000Z";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7, eligible: [
  { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other", createdAt: CREATED },
  { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: CREATED },
] });
const dir = mkdtempSync(join(tmpdir(), "aurrery-annual-offers-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows libSQL handles may outlive close(). */ } });

async function seed(connection: LedgerConnection) {
  await initializeLedgerSchema(connection);
  const json = JSON.stringify(action);
  await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,'executing')",
    [PROPOSAL, OFFERED, JSON.stringify(strategy), "{}", action.type, json, createHash("sha256").update(json).digest("hex")]);
}
const issued = (subscriptionId: string): TargetOutcome => ({ subscriptionId, ok: true, httpStatus: 200, debugId: "dbg-revise", verified: false, observed: null, error: null, offer: { annualPlanId: ANNUAL, expiresAt: EXPIRES } });
const offer = (subscriptionId: string) => ({ proposalId: PROPOSAL, subscriptionId, segment: "core" as const, annualPlanId: ANNUAL, approvalUrl: `${LINK}${subscriptionId.slice(2)}`,
  offeredAt: OFFERED, expiresAt: EXPIRES, request: { subscriptionId, operation: "revise", planId: ANNUAL }, outcome: issued(subscriptionId) });
const read = (status: string, planId: string | null) => ({ status, planId, debugId: "dbg-read" });

/** Wraps every transaction handle so a test can observe or alter individual statements. */
function intercept(connection: LedgerConnection, hook: (sql: string, args: readonly unknown[], run: () => ReturnType<LedgerExecutor["execute"]>) => ReturnType<LedgerExecutor["execute"]>): LedgerConnection {
  return {
    ...connection,
    transaction: (callback) => connection.transaction((tx) => {
      const execute: LedgerExecutor["execute"] = (sql, args = []) => hook(sql, args, () => tx.execute(sql, args));
      return callback({ execute, query: async (sql, args) => (await execute(sql, args)).rows, executeMultiple: (sql) => tx.executeMultiple(sql) });
    }),
  };
}
const counts = async (c: LedgerConnection) => Promise.all(["executions", "annual_offers", "audit_events"].map(async (table) => (await c.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n));

async function withLocal(work: (connection: LedgerConnection) => Promise<void>) {
  const db = new DatabaseSync(":memory:");
  try { const connection = createLocalConnection(db); await seed(connection); await work(connection); } finally { db.close(); }
}

describe("annual offer records", () => {
  it("records the execution, offer and audit together and keeps the link out of every other column", () => withLocal(async (c) => {
    const id = await recordAnnualOffer(offer("I-PILOTD"), c);
    expect(await c.query("SELECT subscription_id,segment,annual_plan_id,approval_url,offered_at,expires_at FROM annual_offers WHERE id=?", [id]))
      .toEqual([{ subscription_id: "I-PILOTD", segment: "core", annual_plan_id: ANNUAL, approval_url: `${LINK}PILOTD`, offered_at: OFFERED, expires_at: EXPIRES }]);
    expect(await c.query("SELECT target_id,operation,ok,http_status,verified,created_at FROM executions"))
      .toEqual([{ target_id: "I-PILOTD", operation: "POST subscription revise (annual plan)", ok: 1, http_status: 200, verified: 0, created_at: OFFERED }]);
    const elsewhere = JSON.stringify([await c.query("SELECT * FROM executions"), await c.query("SELECT * FROM audit_events")]);
    expect(elsewhere).toContain("annual_offer.issued");
    expect(elsewhere).not.toContain("ba_token");
  }));

  it("refuses a second revise record for the same target in one proposal and rolls back", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await expect(recordAnnualOffer(offer("I-PILOTD"), c)).rejects.toThrow();
    expect(await c.query("SELECT COUNT(*) AS n FROM annual_offers")).toEqual([{ n: 1 }]);
    expect(await c.query("SELECT COUNT(*) AS n FROM executions")).toEqual([{ n: 1 }]);
    expect(await c.query("SELECT COUNT(*) AS n FROM audit_events")).toEqual([{ n: 1 }]);
  }));

  it("refuses to store a link anywhere but annual_offers", () => withLocal(async (c) => {
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), request: { link: LINK } }, c)).rejects.toThrow(/only in annual_offers/);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), outcome: { ...issued("I-PILOTD"), error: `${LINK}PILOTD` } }, c)).rejects.toThrow(/only in annual_offers/);
    await expect(recordAnnualTarget(PROPOSAL, {}, { ...issued("I-PILOTD"), ok: false, offer: undefined, error: LINK }, c)).rejects.toThrow();
    expect(await c.query("SELECT COUNT(*) AS n FROM executions")).toEqual([{ n: 0 }]);
  }));

  it("refuses an offer whose link, times or outcome do not describe this issued offer", () => withLocal(async (c) => {
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), approvalUrl: "https://paypal.example.com/update?ba_token=BA-TEST" }, c)).rejects.toThrow(/PayPal approval link/);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), offeredAt: "2026-11-01 00:00" }, c)).rejects.toThrow(RangeError);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), outcome: issued("I-PILOTE") }, c)).rejects.toThrow(RangeError);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), outcome: { ...issued("I-PILOTD"), offer: { annualPlanId: ANNUAL, expiresAt: OFFERED } } }, c)).rejects.toThrow(RangeError);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), outcome: { ...issued("I-PILOTD"), ok: false } }, c)).rejects.toThrow(RangeError);
    expect(await c.query("SELECT COUNT(*) AS n FROM annual_offers")).toEqual([{ n: 0 }]);
  }));

  it("records a target that received no offer without a link", () => withLocal(async (c) => {
    await recordAnnualTarget(PROPOSAL, { subscriptionId: "I-PILOTD" }, { ...issued("I-PILOTD"), ok: false, httpStatus: 422, offer: undefined, error: "PayPal refused the switch." }, c, OFFERED);
    expect(await c.query("SELECT target_id,operation,ok,http_status,verified,created_at FROM executions"))
      .toEqual([{ target_id: "I-PILOTD", operation: "POST subscription revise (annual plan)", ok: 0, http_status: 422, verified: 0, created_at: OFFERED }]);
    expect(await c.query("SELECT COUNT(*) AS n FROM annual_offers")).toEqual([{ n: 0 }]);
  }));

  it("appends one read per offer on every successful GET, even after the offer resolved", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    expect(await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c)).toBe(1);
    expect(await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:20:00.000Z", c)).toBe(1);
    expect(await appendOfferReads("I-UNKNOWN", read("ACTIVE", MONTHLY), "2026-11-01T00:20:00.000Z", c)).toBe(0);
    await expect(appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01 00:30", c)).rejects.toThrow(RangeError);
    expect(await c.query("SELECT observed_at,status,plan_id,debug_id FROM annual_offer_reads ORDER BY id")).toHaveLength(2);
    const [view] = await listAnnualOfferViews(new Date("2026-11-02T00:00:00Z"), c);
    expect(view).toMatchObject({ subscriptionId: "I-PILOTD", status: "switched", outcome: "accepted", resolvedAt: "2026-11-01T00:10:00.000Z" });
    expect(JSON.stringify(view)).not.toContain("ba_token");
  }));

  it("counts learning outcomes per segment and frees a subscriber only after a confirmed decline", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await recordAnnualOffer(offer("I-PILOTE"), c);
    await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c);
    expect(await readAnnualOfferEvidence(c, "2026-11-02T00:00:00.000Z")).toEqual({
      offers: [{ segment: "core", accepted: 1, declined: 0, unresolved: 1 }], limitation: expect.stringContaining("not a randomized"),
    });
    expect(await openOfferSubscriptionIds(c, new Date("2026-11-02T00:00:00Z"))).toEqual(new Set(["I-PILOTD", "I-PILOTE"]));
    // Expired but not yet confirmed: still open.
    expect(await openOfferSubscriptionIds(c, new Date("2026-11-08T08:00:00Z"))).toEqual(new Set(["I-PILOTD", "I-PILOTE"]));
    await appendOfferReads("I-PILOTE", read("ACTIVE", MONTHLY), "2026-11-08T07:00:00.000Z", c);
    expect((await readAnnualOfferEvidence(c, "2026-11-08T08:00:00.000Z")).offers).toEqual([{ segment: "core", accepted: 1, declined: 1, unresolved: 0 }]);
    expect(await openOfferSubscriptionIds(c, new Date("2026-11-08T08:00:00Z"))).toEqual(new Set(["I-PILOTD"]));
    expect(await listAnnualPlanIds(c)).toEqual(new Set([ANNUAL]));
  }));

  it("serves links only while an offer window is open, with the approved price", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    await recordAnnualOffer(offer("I-PILOTE"), c);
    await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c);
    expect(await listAnnualOfferLinks(new Date("2026-11-02T00:00:00Z"), c)).toEqual([
      expect.objectContaining({ subscriptionId: "I-PILOTE", status: "pending", approvalUrl: `${LINK}PILOTE`, annualPrice: "244.80", discountPct: 15 }),
    ]);
    expect(await listAnnualOfferLinks(new Date("2026-11-09T00:00:00Z"), c)).toEqual([]);
  }));

  it("adds the offer tables to an existing ledger that predates them, leaving its rows intact", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      await seed(connection);
      await connection.executeMultiple("DROP TABLE annual_offer_reads; DROP TABLE annual_offers;");
      await initializeLedgerSchema(connection);
      await expect(connection.transaction((tx) => assertCanonicalTargetSchema(tx))).resolves.toBeUndefined();
      expect(await connection.query("SELECT id FROM proposals")).toEqual([{ id: PROPOSAL }]);
      await recordAnnualOffer(offer("I-PILOTD"), connection);
      expect(await listAnnualPlanIds(connection)).toEqual(new Set([ANNUAL]));
    } finally { db.close(); }
  });

  it("rolls back the execution and audit when the offer insert fails after the execution insert", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTE"), c);
    const before = await counts(c);
    await expect(recordAnnualOffer({ ...offer("I-PILOTD"), segment: "vip" as never }, c)).rejects.toThrow();
    expect(await counts(c)).toEqual(before);
    expect(await c.query("SELECT target_id FROM executions")).toEqual([{ target_id: "I-PILOTE" }]);
  }));

  it("refuses an offer row without an id and rolls back", () => withLocal(async (c) => {
    const missing = intercept(c, async (sql, _args, run) => {
      const result = await run();
      return /INSERT INTO annual_offers/.test(sql) ? { rows: result.rows, rowsAffected: result.rowsAffected } : result;
    });
    await expect(recordAnnualOffer(offer("I-PILOTD"), missing)).rejects.toThrow(/offer record/i);
    expect(await counts(c)).toEqual([0, 0, 0]);
  }));

  it("refuses an offer window that does not end after it opens, and a non-ISO evidence time", () => withLocal(async (c) => {
    const closed = (expiresAt: string) => ({ ...offer("I-PILOTD"), expiresAt, outcome: { ...issued("I-PILOTD"), offer: { annualPlanId: ANNUAL, expiresAt } } });
    await expect(recordAnnualOffer(closed(OFFERED), c)).rejects.toThrow(RangeError);
    await expect(recordAnnualOffer(closed("2026-10-31T00:00:00.000Z"), c)).rejects.toThrow(RangeError);
    expect(await counts(c)).toEqual([0, 0, 0]);
    await expect(readAnnualOfferEvidence(c, "2026-11-02")).rejects.toThrow(RangeError);
    await expect(readAnnualOfferEvidence(c, "Nov 2 2026")).rejects.toThrow(RangeError);
  }));

  it("reads approval links only for pending offers", () => withLocal(async (c) => {
    await recordAnnualOffer(offer("I-PILOTD"), c);
    const pendingId = await recordAnnualOffer(offer("I-PILOTE"), c);
    await appendOfferReads("I-PILOTD", read("ACTIVE", ANNUAL), "2026-11-01T00:10:00.000Z", c);
    const secretReads: unknown[][] = [];
    const watched = intercept(c, (sql, args, run) => { if (/approval_url/.test(sql)) secretReads.push([...args]); return run(); });
    expect(await listAnnualOfferLinks(new Date("2026-11-02T00:00:00Z"), watched)).toHaveLength(1);
    expect(secretReads).toEqual([[pendingId]]);
    secretReads.length = 0;
    expect(await listAnnualOfferLinks(new Date("2026-11-09T00:00:00Z"), watched)).toEqual([]);
    expect(secretReads).toEqual([]);
  }));

  it("rolls back a partial offer write through a checked libSQL connection", async () => {
    const client = createClient({ url: `file:${join(dir, "libsql-rollback.sqlite")}` });
    try {
      const c = createLibsqlConnection(client);
      await seed(c);
      await expect(recordAnnualOffer({ ...offer("I-PILOTD"), segment: "vip" as never }, c)).rejects.toThrow();
      expect(await counts(c)).toEqual([0, 0, 0]);
    } finally { client.close(); }
  });

  it("records offers and reads through a checked libSQL connection", async () => {
    const client = createClient({ url: `file:${join(dir, "libsql.sqlite")}` });
    try {
      const c = createLibsqlConnection(client);
      await seed(c);
      await recordAnnualOffer(offer("I-PILOTD"), c);
      await appendOfferReads("I-PILOTD", read("APPROVAL_PENDING", MONTHLY), "2026-11-01T00:10:00.000Z", c);
      expect(await listAnnualOfferViews(new Date("2026-11-02T00:00:00Z"), c)).toEqual([expect.objectContaining({ status: "pending", needsRead: true })]);
      expect(await listAnnualOfferLinks(new Date("2026-11-02T00:00:00Z"), c)).toEqual([expect.objectContaining({ approvalUrl: `${LINK}PILOTD`, annualPrice: "244.80" })]);
      expect(await openOfferSubscriptionIds(c, new Date("2026-11-02T00:00:00Z"))).toEqual(new Set(["I-PILOTD"]));
    } finally { client.close(); }
  });
});

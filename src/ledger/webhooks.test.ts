import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createLocalConnection, initializeLedgerSchema } from "./connection";
import { ingestVerifiedWebhook, listSafeObservations } from "./webhooks";
import { recordObservation } from "@/execution/execute";

const at = "2026-10-26T12:00:00.000Z";
const event = (id: string, type: string, resource: Record<string, unknown>, time = at) => ({ id, event_type: type, create_time: time, resource });

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  await initializeLedgerSchema(connection);
  await connection.execute("INSERT INTO sandbox_subscribers (subscription_id,label,segment,reason,created_at) VALUES (?,?,?,?,?)", ["I-PILOT", "Pilot", "core", "price", at]);
  return { db, connection };
}

it("stores one verified subscription fact and no duplicate evidence under concurrent delivery", async () => {
  const { db, connection } = await fixture();
  try {
    const payload = event("WH-SYNTHETIC-1", "BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-PILOT", payer: { email_address: "private@example.test" } });
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestVerifiedWebhook(connection, payload, "2026-10-27T00:00:00.000Z")));
    expect(results.filter((result) => result === "observed")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(7);
    expect(await connection.query("SELECT COUNT(*) AS n FROM observations")).toEqual([{ n: 1 }]);
    expect(await connection.query("SELECT event_id,event_type,event_at,received_at,subscription_id,disposition FROM paypal_webhook_events")).toEqual([{ event_id: "WH-SYNTHETIC-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", event_at: at, received_at: "2026-10-27T00:00:00.000Z", subscription_id: "I-PILOT", disposition: "observed" }]);
    expect(JSON.stringify(await listSafeObservations(connection))).not.toContain("private@example.test");
  } finally { db.close(); }
});

it("uses sale agreement ID, stores payment completion as a fact with unknown regular price, and keeps event time", async () => {
  const { db, connection } = await fixture();
  try {
    expect(await ingestVerifiedWebhook(connection, event("WH-SYNTHETIC-SALE", "PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "I-PILOT", amount: { total: "9.99" } }, "2026-10-25T00:00:00Z"), "2026-10-27T00:00:00Z")).toBe("observed");
    expect(await connection.query("SELECT subscription_id,observed_at,status,regular_price,source FROM observations")).toEqual([{ subscription_id: "I-PILOT", observed_at: "2026-10-25T00:00:00.000Z", status: "PAYMENT_COMPLETED", regular_price: null, source: "paypal.webhook" }]);
    expect(await connection.query("SELECT received_at FROM paypal_webhook_events")).toEqual([{ received_at: "2026-10-27T00:00:00.000Z" }]);
  } finally { db.close(); }
});

it("ignores unregistered or unsupported events and preserves out-of-order facts", async () => {
  const { db, connection } = await fixture();
  try {
    expect(await ingestVerifiedWebhook(connection, event("WH-SYNTHETIC-2", "BILLING.SUBSCRIPTION.CANCELLED", { id: "I-OTHER" }), at)).toBe("ignored");
    expect(await ingestVerifiedWebhook(connection, event("WH-SYNTHETIC-3", "BILLING.SUBSCRIPTION.UPDATED", { id: "I-PILOT" }), at)).toBe("ignored");
    await ingestVerifiedWebhook(connection, event("WH-SYNTHETIC-4", "BILLING.SUBSCRIPTION.CANCELLED", { id: "I-PILOT" }, "2026-10-27T00:00:00Z"), at);
    await ingestVerifiedWebhook(connection, event("WH-SYNTHETIC-5", "BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-PILOT" }, "2026-10-26T00:00:00Z"), at);
    expect((await listSafeObservations(connection)).map((row) => row.status)).toEqual(["CANCELLED", "ACTIVE"]);
    expect(await connection.query("SELECT disposition,ignored_reason FROM paypal_webhook_events ORDER BY event_id LIMIT 2")).toEqual([{ disposition: "ignored", ignored_reason: "unregistered_subscription" }, { disposition: "ignored", ignored_reason: "unsupported_type" }]);
  } finally { db.close(); }
});

it("rolls back event ID when observation write fails and accepts a retry", async () => {
  const { db, connection } = await fixture();
  try {
    db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    const payload = event("WH-SYNTHETIC-6", "BILLING.SUBSCRIPTION.SUSPENDED", { id: "I-PILOT" });
    await expect(ingestVerifiedWebhook(connection, payload, at)).rejects.toThrow();
    expect(await connection.query("SELECT COUNT(*) AS n FROM paypal_webhook_events")).toEqual([{ n: 0 }]);
    db.exec("DROP TRIGGER fail_observation;");
    expect(await ingestVerifiedWebhook(connection, payload, at)).toBe("observed");
  } finally { db.close(); }
});

it("does not write a second observation when the unique event ID is already claimed", async () => {
  const { db, connection } = await fixture();
  try {
    const payload = event("WH-SYNTHETIC-7", "BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-PILOT" });
    await ingestVerifiedWebhook(connection, payload, at);
    const before = await connection.query("SELECT * FROM observations");
    expect(await ingestVerifiedWebhook(connection, { ...payload, resource: { id: "I-OTHER" } }, at)).toBe("duplicate");
    expect(await connection.query("SELECT * FROM observations")).toEqual(before);
  } finally { db.close(); }
});

it("keeps explicit PayPal polling observations separate from deduplicated webhook events", async () => {
  const { db, connection } = await fixture();
  try {
    const payload = event("WH-SYNTHETIC-8", "PAYMENT.SALE.COMPLETED", { id: "SALE-8", billing_agreement_id: "I-PILOT" });
    await ingestVerifiedWebhook(connection, payload, at);
    await recordObservation({ id: "I-PILOT", status: "ACTIVE", regularPrice: "24.00", planId: "P-SYNTHETIC", planOverridden: false,
      nextBillingTime: null, lastPayment: null, raw: null }, "paypal.status", connection);
    expect(await ingestVerifiedWebhook(connection, payload, at)).toBe("duplicate");
    expect(await connection.query("SELECT COUNT(*) AS n FROM paypal_webhook_events")).toEqual([{ n: 1 }]);
    expect(await connection.query("SELECT source,status,regular_price FROM observations ORDER BY id")).toEqual([
      { source: "paypal.webhook", status: "PAYMENT_COMPLETED", regular_price: null },
      { source: "paypal.status", status: "ACTIVE", regular_price: "24.00" },
    ]);
  } finally { db.close(); }
});

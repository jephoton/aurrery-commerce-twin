import "server-only";
import { runtimeLedgerConnection, type LedgerConnection } from "./connection";
import { authoritativeWrite } from "./operations";

export type WebhookEvent = {
  id: string;
  event_type: string;
  create_time: string;
  resource: Record<string, unknown>;
};

export class InvalidWebhookEvent extends Error {
  constructor() { super("Invalid webhook event"); this.name = "InvalidWebhookEvent"; }
}

const STATUS: Record<string, string> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "ACTIVE",
  "BILLING.SUBSCRIPTION.CANCELLED": "CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED": "SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED": "EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "PAYMENT_FAILED",
  "PAYMENT.SALE.COMPLETED": "PAYMENT_COMPLETED",
};

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) throw new InvalidWebhookEvent();
  const time = new Date(value);
  if (!Number.isFinite(time.valueOf())) throw new InvalidWebhookEvent();
  return time.toISOString();
}

function normalize(input: unknown, receivedAt: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidWebhookEvent();
  const value = input as Partial<WebhookEvent>;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.id) ||
    typeof value.event_type !== "string" || !/^[A-Z][A-Z0-9_.-]{0,79}$/.test(value.event_type)) throw new InvalidWebhookEvent();
  const resource = value.resource && typeof value.resource === "object" && !Array.isArray(value.resource) ? value.resource : null;
  const sale = value.event_type.startsWith("PAYMENT.SALE.");
  const rawId = resource?.[sale ? "billing_agreement_id" : "id"];
  const subscriptionId = typeof rawId === "string" && /^I-[A-Z0-9]{1,120}$/.test(rawId) ? rawId : null;
  return { id: value.id, type: value.event_type, eventAt: timestamp(value.create_time), receivedAt: timestamp(receivedAt), subscriptionId, status: STATUS[value.event_type] ?? null };
}

/** The caller has already received exact SUCCESS from PayPal for the original full event. */
export async function ingestVerifiedWebhook(connection: LedgerConnection, event: unknown, receivedAt: string): Promise<"observed" | "ignored" | "duplicate"> {
  const fact = normalize(event, receivedAt);
  return authoritativeWrite(connection, async (tx) => {
    const claim = await tx.execute(
      `INSERT INTO paypal_webhook_events (event_id,event_type,event_at,received_at,subscription_id,disposition,ignored_reason)
       VALUES (?,?,?,?,?,'ignored','processing') ON CONFLICT(event_id) DO NOTHING`,
      [fact.id, fact.type, fact.eventAt, fact.receivedAt, fact.subscriptionId],
    );
    if (claim.rowsAffected === 0) return "duplicate";
    const registered = fact.subscriptionId ? (await tx.query("SELECT 1 FROM sandbox_subscribers WHERE subscription_id = ?", [fact.subscriptionId])).length > 0 : false;
    const reason = !fact.status ? "unsupported_type" : !fact.subscriptionId ? "missing_subscription_id" : !registered ? "unregistered_subscription" : null;
    let observationId: number | null = null;
    if (!reason && fact.subscriptionId && fact.status) {
      const inserted = await tx.execute(
        `INSERT INTO observations (subscription_id, observed_at, status, regular_price, plan_overridden, last_payment_json, source)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'paypal.webhook')`,
        [fact.subscriptionId, fact.eventAt, fact.status],
      );
      observationId = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(observationId) || observationId <= 0) throw new Error("Observation insert failed");
    }
    await tx.execute(
      `UPDATE paypal_webhook_events SET disposition=?,ignored_reason=?,observation_id=? WHERE event_id=?`,
      [reason ? "ignored" : "observed", reason, observationId, fact.id],
    );
    return reason ? "ignored" : "observed";
  });
}

/** Safe, bounded projection; payment details and raw provider data never cross this API. */
export async function listSafeObservations(connection?: LedgerConnection, limit = 100) {
  connection ??= await runtimeLedgerConnection();
  const cap = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await connection.query(
    `SELECT o.id,o.subscription_id,o.observed_at,o.status,o.regular_price,o.plan_overridden,o.source,
            e.event_id,e.event_type,e.received_at
       FROM observations o LEFT JOIN paypal_webhook_events e ON e.observation_id = o.id
      ORDER BY o.observed_at DESC, o.id DESC LIMIT ?`, [cap],
  );
  return rows.map((row) => ({
    id: Number(row.id), subscriptionId: String(row.subscription_id), observedAt: String(row.observed_at),
    status: String(row.status), regularPrice: row.regular_price === null ? null : String(row.regular_price),
    planOverridden: row.plan_overridden === null ? null : Boolean(row.plan_overridden),
    source: String(row.source), eventId: row.event_id === null ? null : String(row.event_id),
    eventType: row.event_type === null ? null : String(row.event_type),
    receivedAt: row.received_at === null ? null : String(row.received_at),
  }));
}

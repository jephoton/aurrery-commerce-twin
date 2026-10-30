import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { ingestVerifiedWebhook, InvalidWebhookEvent } from "@/ledger/webhooks";
import { createWebhookPost, verifySandboxWebhook, type WebhookHeaders } from "./webhooks";

const headers = {
  "paypal-transmission-id": "T-SYNTHETIC-1", "paypal-transmission-time": "2026-10-27T00:00:00Z",
  "paypal-transmission-sig": "c3ludGhldGljLXNpZ25hdHVyZQ==", "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-SYNTHETIC",
  "paypal-auth-algo": "SHA256withRSA", "content-type": "application/json",
};
const event = { id: "WH-SYNTHETIC", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", create_time: "2026-10-26T00:00:00Z", resource: { id: "I-PILOT", payer: { email_address: "private@example.test" } } };
const request = (body: string, overrides: Record<string, string> = {}) => new Request("https://example.test/api/paypal/webhook", { method: "POST", headers: { ...headers, ...overrides }, body });

beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

it("logs only fixed result lines after verified ingestion commits, including genuine ledger duplicates", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  try {
    const logCountsAtCommit: number[] = [];
    await initializeLedgerSchema(connection);
    await connection.execute("INSERT INTO sandbox_subscribers (subscription_id,label,segment,reason,created_at) VALUES (?,?,?,?,?)",
      ["I-PILOT", "Pilot", "core", "price", "2026-10-27T00:00:00.000Z"]);
    const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", admit: async () => null,
      fetch: async () => new Response('{"verification_status":"SUCCESS"}'),
      ingest: async (payload, receivedAt) => {
        const result = await ingestVerifiedWebhook(connection, payload, receivedAt);
        // The handler must not log before ingestion has completed its transaction.
        logCountsAtCommit.push(vi.mocked(console.info).mock.calls.length);
        return result;
      } });
    for (const [payload, result] of [[event, "observed"], [event, "duplicate"], [{ ...event, id: "WH-IGNORED", event_type: "UNSUPPORTED.EVENT" }, "ignored"]] as const) {
      const response = await post(request(JSON.stringify(payload)));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result });
    }
    expect(console.info).toHaveBeenNthCalledWith(1, "paypal.webhook result=observed");
    expect(console.info).toHaveBeenNthCalledWith(2, "paypal.webhook result=duplicate");
    expect(console.info).toHaveBeenNthCalledWith(3, "paypal.webhook result=ignored");
    expect(console.info).toHaveBeenCalledTimes(3);
    expect(logCountsAtCommit).toEqual([0, 1, 2]);
    expect(await connection.query("SELECT COUNT(*) AS n FROM observations")).toEqual([{ n: 1 }]);
  } finally { db.close(); }
});

it.each(["FAILURE", "success", "SUCCESS ", null])("does not log an ingestion result for verification status %j", async (verification_status) => {
  const ingest = vi.fn(async () => "observed");
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", admit: async () => null, ingest,
    fetch: async () => new Response(JSON.stringify({ verification_status })) });
  expect((await post(request(JSON.stringify(event)))).status).toBe(verification_status === "FAILURE" ? 403 : 503);
  expect(ingest).not.toHaveBeenCalled();
  expect(console.info).not.toHaveBeenCalled();
});

it.each([new InvalidWebhookEvent(), new Error("private storage failure")])("does not log an ingestion result when ingestion fails with %s", async (error) => {
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", admit: async () => null,
    fetch: async () => new Response('{"verification_status":"SUCCESS"}'), ingest: async () => { throw error; } });
  expect((await post(request(JSON.stringify(event)))).status).toBe(error instanceof InvalidWebhookEvent ? 400 : 503);
  expect(console.info).not.toHaveBeenCalled();
});

it.each(["observed\nprivate@example.test", "toString", { result: "observed", private: "private@example.test" }, null])("suppresses unknown injected result %j without changing its response", async (result) => {
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", admit: async () => null,
    fetch: async () => new Response('{"verification_status":"SUCCESS"}'), ingest: async () => result });
  const response = await post(request(JSON.stringify(event)));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result });
  expect(console.info).not.toHaveBeenCalled();
});

it("preserves the committed ingestion and HTTP200 acknowledgement when result logging throws", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  try {
    await initializeLedgerSchema(connection);
    vi.mocked(console.info).mockImplementation(() => { throw new Error("private log sink failure"); });
    const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", admit: async () => null,
      fetch: async () => new Response('{"verification_status":"SUCCESS"}'),
      ingest: (payload, receivedAt) => ingestVerifiedWebhook(connection, payload, receivedAt) });
    for (const result of ["ignored", "duplicate"]) {
      const response = await post(request(JSON.stringify(event)));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result });
    }
    expect(console.info).toHaveBeenCalledTimes(2);
    expect(await connection.query("SELECT COUNT(*) AS n FROM paypal_webhook_events")).toEqual([{ n: 1 }]);
  } finally { db.close(); }
});

it("rejects missing signature headers before token or verification HTTP", async () => {
  const token = vi.fn(async () => "synthetic-token");
  const fetch = vi.fn<typeof globalThis.fetch>();
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token, fetch, admit: async () => null, ingest: vi.fn() });
  const req = new Request("https://example.test/api/paypal/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  expect((await post(req)).status).toBe(400);
  expect(token).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("passes the original full parsed event to sandbox verification and gates ingestion on exact SUCCESS", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 }));
  const ingest = vi.fn(async () => "observed" as const);
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", fetch, admit: async () => null, ingest });
  expect((await post(request(JSON.stringify(event)))).status).toBe(200);
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(fetch.mock.calls[0][0]).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
  expect(sent.webhook_event).toEqual(event);
  expect(sent.webhook_event.resource.payer.email_address).toBe("private@example.test");
  expect(ingest).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 }));
  expect((await post(request(JSON.stringify(event)))).status).toBe(403);
  expect(ingest).toHaveBeenCalledOnce();
});

it("posts the original validated event JSON verbatim, including spacing, escapes and numeric spelling", async () => {
  const original = '{ "id":"WH-SYNTHETIC", "event_type":"BILLING.SUBSCRIPTION.ACTIVATED", "create_time":"2026-10-26T00:00:00Z", "resource":{"id":"I-PILOT","note":"\\u00e9","quantity":1.00} }';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"verification_status":"SUCCESS"}', { status: 200 }));
  const ingest = vi.fn(async () => "observed" as const);
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", fetch, admit: async () => null, ingest });
  const res = await post(request(original, { "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-SYNTHETIC" }));
  expect(res.status).toBe(200);
  const body = String(fetch.mock.calls[0][1]?.body);
  expect(body).toContain(`"webhook_event":${original}}`);
  expect(ingest).toHaveBeenCalledWith(JSON.parse(original), expect.any(String));
});

it("returns retryable 503 for auth/network/malformed verification and leaves event ID unconsumed", async () => {
  const ingest = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("private provider body"))
    .mockResolvedValueOnce(new Response("<private>", { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 }));
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", fetch, admit: async () => null, ingest });
  for (let i = 0; i < 2; i++) {
    const res = await post(request(JSON.stringify(event)));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/private/);
  }
  expect(ingest).not.toHaveBeenCalled();
  expect((await post(request(JSON.stringify(event)))).status).toBe(200);
  expect(ingest).toHaveBeenCalledOnce();
});

it("returns retryable 503 when sandbox OAuth fails without consuming the event", async () => {
  const ingest = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => { throw new Error("synthetic private token error"); }, fetch, admit: async () => null, ingest });
  const res = await post(request(JSON.stringify(event)));
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain("private");
  expect(fetch).not.toHaveBeenCalled();
  expect(ingest).not.toHaveBeenCalled();
});

it("rejects malformed and oversized input without verification", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", fetch, admit: async () => null, ingest: vi.fn() });
  expect((await post(request("not json"))).status).toBe(400);
  expect((await post(request("x".repeat(262_145)))).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds verification response body even when the fake transport ignores abort", async () => {
  const eventHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key.startsWith("paypal-"))) as WebhookHeaders;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ start() { /* deliberately never closes */ } }), { status: 200 }));
  await expect(verifySandboxWebhook(eventHeaders, JSON.stringify(event), "WH-CONFIGURED", "synthetic-token", fetch, 25)).rejects.toThrow();
});

it("admits cross-origin delivery only after bounded header/body checks and still requires verification", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 }));
  const admit = vi.fn(async () => null);
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token: async () => "synthetic-token", fetch, admit, ingest: vi.fn() });
  expect((await post(request(JSON.stringify(event), { origin: "https://elsewhere.test" }))).status).toBe(403);
  expect(admit).toHaveBeenCalledOnce();
});

it("does not call OAuth or verification after durable admission rejects a request", async () => {
  const token = vi.fn(async () => "synthetic-token");
  const fetch = vi.fn<typeof globalThis.fetch>();
  const post = createWebhookPost({ webhookId: "WH-CONFIGURED", token, fetch,
    admit: async () => Response.json({ error: "RATE_LIMITED" }, { status: 429 }), ingest: vi.fn() });
  expect((await post(request(JSON.stringify(event)))).status).toBe(429);
  expect(token).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

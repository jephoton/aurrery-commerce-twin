import { expect, it, vi } from "vitest";
import { createWebhookPost, verifySandboxWebhook, type WebhookHeaders } from "./webhooks";

const headers = {
  "paypal-transmission-id": "T-SYNTHETIC-1", "paypal-transmission-time": "2026-10-27T00:00:00Z",
  "paypal-transmission-sig": "c3ludGhldGljLXNpZ25hdHVyZQ==", "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-SYNTHETIC",
  "paypal-auth-algo": "SHA256withRSA", "content-type": "application/json",
};
const event = { id: "WH-SYNTHETIC", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", create_time: "2026-10-26T00:00:00Z", resource: { id: "I-PILOT", payer: { email_address: "private@example.test" } } };
const request = (body: string, overrides: Record<string, string> = {}) => new Request("https://example.test/api/paypal/webhook", { method: "POST", headers: { ...headers, ...overrides }, body });

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

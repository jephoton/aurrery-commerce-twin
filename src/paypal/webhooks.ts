import "server-only";
import { admitWebhookRequest } from "@/hosting/guard";
import { runtimeLedgerConnection } from "@/ledger/connection";
import { ingestVerifiedWebhook, InvalidWebhookEvent } from "@/ledger/webhooks";

const BASE = "https://api-m.sandbox.paypal.com";
const VERIFY_URL = `${BASE}/v1/notifications/verify-webhook-signature`;
const TOKEN_URL = `${BASE}/v1/oauth2/token`;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_VERIFY_BYTES = 4096;
const MAX_TOKEN_BYTES = 8192;
const HTTP_TIMEOUT_MS = 10_000;

export type WebhookHeaders = {
  "paypal-transmission-id": string;
  "paypal-transmission-time": string;
  "paypal-transmission-sig": string;
  "paypal-cert-url": string;
  "paypal-auth-algo": string;
};

class UpstreamUnavailable extends Error {
  constructor() { super("Sandbox webhook verification unavailable"); }
}

function boundedHeaders(headers: Headers): WebhookHeaders | null {
  const id = headers.get("paypal-transmission-id");
  const time = headers.get("paypal-transmission-time");
  const sig = headers.get("paypal-transmission-sig");
  const cert = headers.get("paypal-cert-url");
  const algo = headers.get("paypal-auth-algo");
  if (!id || !/^[A-Za-z0-9-]{1,128}$/.test(id) || !time || time.length > 64 || !Number.isFinite(Date.parse(time)) ||
    !sig || !/^[A-Za-z0-9+/=]{8,2048}$/.test(sig) || algo !== "SHA256withRSA" ||
    !cert || cert.length > 512) return null;
  let url: URL;
  try { url = new URL(cert); } catch { return null; }
  if (url.protocol !== "https:" || !["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"].includes(url.hostname) || url.port || url.username || url.password ||
    !/^\/v1\/notifications\/certs\/[A-Za-z0-9-]{1,128}$/.test(url.pathname) || url.search || url.hash) return null;
  return { "paypal-transmission-id": id, "paypal-transmission-time": time, "paypal-transmission-sig": sig,
    "paypal-cert-url": cert, "paypal-auth-algo": algo };
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamUnavailable()), timeoutMs);
    onAbort = () => reject(new UpstreamUnavailable());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw new RangeError("Body too large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try { void reader.cancel().catch(() => {}); } catch { /* Preserve the original result. */ }
    try { reader.releaseLock(); } catch { /* A timed-out read may still own the lock. */ }
  }
}

async function sandboxPost(url: string, init: RequestInit, fetcher: typeof globalThis.fetch, maxBytes: number, timeoutMs: number): Promise<unknown> {
  if (url !== VERIFY_URL && url !== TOKEN_URL) throw new UpstreamUnavailable();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new UpstreamUnavailable()); }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url, { ...init, method: "POST", redirect: "error", signal: abort.signal }), interrupted]);
    if (response.status !== 200 || Number(response.headers.get("content-length")) > maxBytes) throw new UpstreamUnavailable();
    const bytes = await Promise.race([readBounded(response.body, maxBytes, timeoutMs, abort.signal), interrupted]);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new UpstreamUnavailable(); }
  } catch { throw new UpstreamUnavailable(); }
  finally { if (timer) clearTimeout(timer); abort.abort(); }
}

let cachedToken: { value: string; expiresAt: number } | null = null;
async function sandboxToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new UpstreamUnavailable();
  const token = await sandboxPost(TOKEN_URL, {
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }, globalThis.fetch, MAX_TOKEN_BYTES, HTTP_TIMEOUT_MS) as { access_token?: unknown; expires_in?: unknown };
  if (typeof token.access_token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token.access_token) ||
    typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new UpstreamUnavailable();
  cachedToken = { value: token.access_token, expiresAt: Date.now() + Math.max(0, token.expires_in - 60) * 1000 };
  return cachedToken.value;
}

export async function verifySandboxWebhook(headers: WebhookHeaders, originalEventJson: string, webhookId: string, token: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch, timeoutMs = HTTP_TIMEOUT_MS): Promise<boolean> {
  const metadata = JSON.stringify({
    auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"], webhook_id: webhookId,
  });
  // PayPal verifies the event's original JSON representation. The validated raw
  // object is inserted as a JSON value, with no parse/stringify round trip.
  const body = `${metadata.slice(0, -1)},"webhook_event":${originalEventJson}}`;
  const result = await sandboxPost(VERIFY_URL, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  }, fetcher, MAX_VERIFY_BYTES, timeoutMs);
  if (!result || typeof result !== "object" || Array.isArray(result) || !(["SUCCESS", "FAILURE"].includes(String((result as { verification_status?: unknown }).verification_status)))) throw new UpstreamUnavailable();
  return (result as { verification_status: string }).verification_status === "SUCCESS";
}

type Dependencies = {
  webhookId?: string;
  token?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  admit?: (request: Request) => Promise<Response | null>;
  ingest?: (event: unknown, receivedAt: string) => Promise<unknown>;
};

/** Server-only injection point. The route exports only its handler, never test controls. */
export function createWebhookPost(deps: Dependencies = {}) {
  return async (request: Request): Promise<Response> => {
    const parsed = boundedHeaders(request.headers);
    if (!parsed || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      return Response.json({ error: "INVALID_WEBHOOK" }, { status: 400 });
    if (Number(request.headers.get("content-length")) > MAX_EVENT_BYTES)
      return Response.json({ error: "WEBHOOK_TOO_LARGE" }, { status: 413 });
    let original: unknown;
    let originalJson: string;
    try {
      const body = await readBounded(request.body, MAX_EVENT_BYTES, HTTP_TIMEOUT_MS, request.signal);
      originalJson = new TextDecoder("utf-8", { fatal: true }).decode(body);
      original = JSON.parse(originalJson);
      if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("invalid JSON root");
    } catch (error) {
      return Response.json({ error: error instanceof RangeError ? "WEBHOOK_TOO_LARGE" : "INVALID_WEBHOOK" }, { status: error instanceof RangeError ? 413 : 400 });
    }
    const admission = await (deps.admit ?? admitWebhookRequest)(request);
    if (admission) return admission;
    const webhookId = deps.webhookId ?? process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId || !/^[A-Za-z0-9-]{1,128}$/.test(webhookId)) return Response.json({ error: "WEBHOOK_UNAVAILABLE" }, { status: 503 });
    let verified: boolean;
    try { verified = await verifySandboxWebhook(parsed, originalJson, webhookId, await (deps.token ?? sandboxToken)(), deps.fetch ?? globalThis.fetch); }
    catch { return Response.json({ error: "WEBHOOK_VERIFICATION_UNAVAILABLE" }, { status: 503 }); }
    if (!verified) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 403 });
    try {
      const result = await (deps.ingest ?? (async (event, receivedAt) => ingestVerifiedWebhook(await runtimeLedgerConnection(), event, receivedAt)))(original, new Date().toISOString());
      if (result === "observed" || result === "ignored" || result === "duplicate") {
        try { console.info(`paypal.webhook result=${result}`); }
        catch { /* Operational evidence must not change a committed ingestion's acknowledgement. */ }
      }
      return Response.json({ result }, { status: 200 });
    } catch (error) {
      if (error instanceof InvalidWebhookEvent) return Response.json({ error: "INVALID_WEBHOOK" }, { status: 400 });
      return Response.json({ error: "WEBHOOK_STORAGE_UNAVAILABLE" }, { status: 503 });
    }
  };
}

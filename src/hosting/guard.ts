import { runtimeLedgerConnection } from "@/ledger/connection";
import { hostedConfig, type HostedConfig } from "./config";
import { createHostingStore, type LimitKind } from "./store";

export const SESSION_COOKIE = "__Host-aurrery-admin";
type Store = ReturnType<typeof createHostingStore>;

export function parseSessionCookie(header: string | null): string | null {
  const entry = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

export function invalidHostedOrigin(request: Request, config: HostedConfig): Response | null {
  return config.hosted && request.method !== "GET" && request.headers.get("origin") !== config.origin
    ? Response.json({ error: "INVALID_ORIGIN" }, { status: 403 }) : null;
}

export async function guardHostedRequest(request: Request, options: { admin?: boolean; limit?: LimitKind }, config: HostedConfig, store: Store): Promise<Response | null> {
  if (!config.hosted) return null;
  const originError = invalidHostedOrigin(request, config);
  if (originError) return originError;
  if (options.admin && !await store.isSessionValid(parseSessionCookie(request.headers.get("cookie")), config.adminPassword)) return Response.json({ error: "ADMIN_REQUIRED" }, { status: 401 });
  if (options.limit) {
    // Render's forwarded-client header contract has not been established. All visitors
    // share a conservative client bucket; global buckets still bound aggregate use.
    const admission = await store.admit(options.limit, "unverified-proxy-client");
    if (!admission.allowed) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(admission.retryAfter) } });
  }
  return null;
}

export async function hostedRuntime(config: HostedConfig = hostedConfig()): Promise<{ config: HostedConfig; store: Store | null }> {
  return { config, store: config.hosted ? createHostingStore(await runtimeLedgerConnection(), config.secret) : null };
}

export async function admitHostedRequest(request: Request, options: { admin?: boolean; limit?: LimitKind } = {}): Promise<Response | null> {
  try {
    const config = hostedConfig();
    if (!config.hosted) return null;
    const originError = invalidHostedOrigin(request, config);
    if (originError) return originError;
    if (options.admin) {
      const token = parseSessionCookie(request.headers.get("cookie"));
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Response.json({ error: "ADMIN_REQUIRED" }, { status: 401 });
    }
    const { store } = await hostedRuntime(config);
    return store ? await guardHostedRequest(request, options, config, store) : null;
  } catch {
    return Response.json({ error: "HOSTED_UNAVAILABLE" }, { status: 503 });
  }
}

/** Public signed deliveries use a durable global quota and never inherit browser Origin/session checks. */
export async function admitWebhookRequest(): Promise<Response | null> {
  try {
    const config = hostedConfig();
    const store = createHostingStore(await runtimeLedgerConnection(), config.hosted ? config.secret : "local-webhook-global");
    const admission = await store.admit("webhook", "global");
    return admission.allowed ? null : Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(admission.retryAfter) } });
  } catch { return Response.json({ error: "WEBHOOK_UNAVAILABLE" }, { status: 503 }); }
}

export const sessionCookieOptions = { httpOnly: true, secure: true, sameSite: "strict" as const, path: "/", maxAge: 2 * 60 * 60 };

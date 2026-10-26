import { ledger } from "@/ledger/db";
import { hostedConfig, type HostedConfig } from "./config";
import { createHostingStore, type LimitKind } from "./store";

export const SESSION_COOKIE = "__Host-aurrery-admin";
type Store = ReturnType<typeof createHostingStore>;

export function parseSessionCookie(header: string | null): string | null {
  const entry = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

export function guardHostedRequest(request: Request, options: { admin?: boolean; limit?: LimitKind }, config: HostedConfig, store: Store): Response | null {
  if (!config.hosted) return null;
  if (request.method !== "GET" && request.headers.get("origin") !== config.origin) return Response.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  if (options.admin && !store.isSessionValid(parseSessionCookie(request.headers.get("cookie")), config.adminPassword)) return Response.json({ error: "ADMIN_REQUIRED" }, { status: 401 });
  if (options.limit) {
    // Render's forwarded-client header contract has not been established. All visitors
    // share a conservative client bucket; global buckets still bound aggregate use.
    const admission = store.admit(options.limit, "unverified-proxy-client");
    if (!admission.allowed) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(admission.retryAfter) } });
  }
  return null;
}

export function hostedRuntime(): { config: HostedConfig; store: Store | null } {
  const config = hostedConfig();
  return { config, store: config.hosted ? createHostingStore(ledger(), config.secret) : null };
}

export function admitHostedRequest(request: Request, options: { admin?: boolean; limit?: LimitKind } = {}): Response | null {
  try {
    const { config, store } = hostedRuntime();
    return store ? guardHostedRequest(request, options, config, store) : null;
  } catch {
    return Response.json({ error: "HOSTED_UNAVAILABLE" }, { status: 503 });
  }
}

export const sessionCookieOptions = { httpOnly: true, secure: true, sameSite: "strict" as const, path: "/", maxAge: 2 * 60 * 60 };

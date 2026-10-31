import "server-only";
import { ApiError, Client, Environment, ResponseValidationError, SubscriptionsController } from "@paypal/paypal-server-sdk";

// PayPal access is sandbox-only by construction: there is no code path to the live environment.

export function paypalConfigured(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

let cached: { client: Client; subscriptions: SubscriptionsController } | null = null;

export function paypal() {
  if (!paypalConfigured()) {
    throw new Error("PayPal sandbox credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");
  }
  if (!cached) {
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: process.env.PAYPAL_CLIENT_ID!,
        oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET!,
      },
      environment: Environment.Sandbox,
      timeout: 15000,
    });
    cached = { client, subscriptions: new SubscriptionsController(client) };
  }
  return cached;
}

export interface PayPalFailure {
  httpStatus: number | null;
  name: string;
  message: string;
  debugId: string | null;
  details: unknown;
  /** PayPal may have acted; reconcile by reading back, never retry blindly. */
  ambiguous?: true;
}

/** Normalise SDK and network errors into something we can store and show verbatim. */
export function toFailure(error: unknown): PayPalFailure {
  if (error instanceof ResponseValidationError) {
    // The SDK message can embed the response JSON (approval links), so it is never copied.
    return {
      httpStatus: typeof error.statusCode === "number" ? error.statusCode : null,
      name: "RESPONSE_VALIDATION_ERROR",
      message: "PayPal returned a response that did not match the expected schema.",
      debugId: error.headers?.["paypal-debug-id"] ?? null,
      details: null,
      ambiguous: true,
    };
  }
  if (error instanceof ApiError) {
    const body = typeof error.body === "string" ? safeJson(error.body) : error.result;
    const b = (body ?? {}) as { name?: string; message?: string; debug_id?: string; details?: unknown };
    return {
      httpStatus: error.statusCode,
      name: b.name ?? "PAYPAL_API_ERROR",
      message: b.message ?? error.message,
      debugId: b.debug_id ?? error.headers?.["paypal-debug-id"] ?? null,
      details: b.details ?? body,
    };
  }
  return { httpStatus: null, name: "NETWORK_OR_CLIENT_ERROR", message: error instanceof Error ? error.message : String(error), debugId: null, details: null };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

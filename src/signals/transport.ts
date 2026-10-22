import "server-only";

export type ProviderName = "gemini" | "groq";
export interface ProviderConfig {
  provider: ProviderName;
  model?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tests may shorten the limit; no caller can extend it beyond 60 seconds. */
  timeoutMs?: number;
}
export type ErrorCategory = "configuration" | "auth" | "model" | "request" | "quota" | "network" | "timeout" | "server" | "malformed_json" | "envelope" | "response_size";
export interface QuotaViolation { quotaMetric?: string; quotaId?: string; quotaValue?: string; quotaLimitValue?: string; model?: string; location?: string }
export interface SafeProviderError {
  provider: ProviderName;
  model: string;
  category: ErrorCategory;
  status?: number;
  retryCount: number;
  quota: Record<string, string>;
  quotaViolations?: QuotaViolation[];
}
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface AttemptMetric { latencyMs: number; usage: Usage; error?: SafeProviderError; quota: Record<string, string>; quotaViolations?: QuotaViolation[]; status?: number }
export interface ProviderMetrics { latencyMs: number; retries: number; usage: Usage; attempts: AttemptMetric[] }
export interface ProviderResult { payload?: unknown; metrics: ProviderMetrics; error?: SafeProviderError; terminal: boolean }
export const emptyMetrics = (): ProviderMetrics => ({ latencyMs: 0, retries: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, attempts: [] });

const MAX_RESPONSE_BYTES = 256_000;
const QUOTA_HEADERS = ["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"];
class TransportFailure extends Error {
  constructor(readonly category: ErrorCategory) { super(category); }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function usageFrom(raw: unknown, provider: ProviderName): Usage {
  const root = object(raw);
  const usage = object(provider === "gemini" ? root?.usageMetadata : root?.usage);
  return {
    inputTokens: numeric(provider === "gemini" ? usage?.promptTokenCount : usage?.prompt_tokens),
    outputTokens: numeric(provider === "gemini" ? usage?.candidatesTokenCount : usage?.completion_tokens),
    totalTokens: numeric(provider === "gemini" ? usage?.totalTokenCount : usage?.total_tokens),
  };
}
function quotaViolationsFrom(raw: unknown, key: string): QuotaViolation[] | undefined {
  const details = object(object(raw)?.error)?.details;
  if (!Array.isArray(details)) return undefined;
  const result: QuotaViolation[] = [];
  for (const detail of details.slice(0, 20)) {
    const entry = object(detail);
    if (entry?.["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(entry.violations)) continue;
    for (const raw of entry.violations.slice(0, 20)) {
      const violation = object(raw);
      if (!violation) continue;
      const safe: QuotaViolation = {};
      const dimensions = object(violation.quotaDimensions);
      for (const name of ["quotaMetric", "quotaId", "quotaValue", "quotaLimitValue", "model", "location"] as const) {
        const value = name === "model" || name === "location" ? dimensions?.[name] : violation[name];
        const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
        const pattern = name === "quotaValue" || name === "quotaLimitValue" ? /^\d+(?:\.\d+)?$/ : /^[a-zA-Z0-9_./-]+$/;
        if (text && text.length <= 200 && pattern.test(text) && !text.includes(key)) safe[name] = text;
      }
      if (Object.keys(safe).length) result.push(safe);
    }
  }
  return result.length ? result : undefined;
}
function clientErrorCategory(status: number): ErrorCategory {
  return status === 429 ? "quota" : status === 401 || status === 403 ? "auth" : status === 404 ? "model" : "request";
}
function quotaHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of QUOTA_HEADERS) {
    const value = headers.get(name)?.trim();
    // Do not trust arbitrary strings even in an allowlisted response header.
    if (value && value.length <= 80 && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d)?)+$/.test(value)) result[name] = value;
    else if (name === "retry-after" && value && Number.isFinite(Date.parse(value))) result[name] = new Date(value).toISOString();
  }
  return result;
}
function retryDelay(headers?: Headers): number {
  const value = headers?.get("retry-after");
  if (!value) return 250;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(10_000, delay)) : 250;
}
async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancel(); throw new TransportFailure("response_size"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Reusable server-only HTTP boundary. It never returns request objects or raw exceptions. */
export function createTransport(config: ProviderConfig) {
  const env = config.env ?? process.env;
  const provider = config.provider;
  const requestedModel = config.model ?? env[provider === "gemini" ? "GEMINI_MODEL" : "GROQ_MODEL"] ?? (provider === "gemini" ? "gemini-3.8-flash" : "openai/gpt-oss-120b");
  const validModel = /^[a-zA-Z0-9_./-]{1,120}$/.test(requestedModel);
  const model = validModel ? requestedModel : "invalid-model";
  const key = provider === "gemini" ? env.GEMINI_API_KEY?.trim() || env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() : env.GROQ_API_KEY?.trim();
  const fetcher = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = Math.max(1, Math.min(60_000, config.timeoutMs ?? 60_000));
  const url = provider === "gemini" ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` : "https://api.groq.com/openai/v1/chat/completions";
  return {
    provider,
    model,
    async send(body: unknown): Promise<ProviderResult> {
      const metrics = emptyMetrics();
      if (!key || !validModel) return { metrics, terminal: true, error: { provider, model, category: "configuration", retryCount: 0, quota: {} } };
      const started = performance.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const metric: AttemptMetric = { latencyMs: 0, quota: {}, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        const attemptStart = performance.now();
        let headers: Headers | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let payload: unknown;
        let category: ErrorCategory | undefined;
        try {
          const request = async () => {
            const response = await fetcher(url, {
              method: "POST",
              headers: provider === "gemini" ? { "content-type": "application/json", "x-goog-api-key": key } : { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify(provider === "groq" ? { ...object(body), model } : body),
              signal: controller.signal,
              redirect: "error",
            });
            if (controller.signal.aborted) throw new TransportFailure("timeout");
            headers = response.headers;
            metric.status = response.status;
            metric.quota = quotaHeaders(headers);
            const text = await readBounded(response, controller.signal);
            if (controller.signal.aborted) throw new TransportFailure("timeout");
            try { payload = JSON.parse(text) as unknown; }
            catch { if (response.ok) throw new TransportFailure("malformed_json"); }
            metric.usage = usageFrom(payload, provider);
            if (provider === "gemini" && response.status === 429) metric.quotaViolations = quotaViolationsFrom(payload, key);
            if (!response.ok) throw new TransportFailure(response.status >= 500 ? "server" : clientErrorCategory(response.status));
          };
          await Promise.race([
            request(),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new TransportFailure("timeout")); controller.abort(); }, timeoutMs); }),
          ]);
        } catch (error: unknown) {
          // A received auth/model/quota rejection is terminal even if reading its body fails.
          category = metric.status && metric.status >= 400 && metric.status < 500
            ? clientErrorCategory(metric.status)
            : error instanceof TransportFailure ? error.category : "network";
        } finally {
          if (timer) clearTimeout(timer);
          metric.latencyMs = performance.now() - attemptStart;
        }
        if (category) metric.error = { provider, model, category, status: metric.status, retryCount: attempt, quota: metric.quota, ...(metric.quotaViolations ? { quotaViolations: metric.quotaViolations } : {}) };
        metrics.attempts.push(metric);
        for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) metrics.usage[field] += metric.usage[field];
        metrics.latencyMs = performance.now() - started;
        metrics.retries = attempt;
        if (!category) return { payload, metrics, terminal: false };
        if (attempt === 0 && ["network", "timeout", "server"].includes(category)) { await sleep(retryDelay(headers)); continue; }
        return { metrics, error: metric.error, terminal: !["malformed_json", "envelope", "response_size"].includes(category) };
      }
      throw new Error("Unreachable transport state");
    },
  };
}

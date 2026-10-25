import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "./contracts";
import type { ProviderName } from "@/signals/transport";

export class RunLimitError extends Error {
  constructor(readonly code: "BUSY" | "CANCELLED" | "DEADLINE" | "TOKEN_LIMIT") { super(code); }
}
export interface AgentLease { release(): void; readonly active: boolean }
let activeLease: AgentLease | undefined;
const claimed = new WeakSet<AgentLease>();
export function claimAgentLease(lease: AgentLease) {
  if (lease !== activeLease || !lease.active || claimed.has(lease)) throw new RunLimitError("BUSY");
  claimed.add(lease);
}
/** Reserve before starting an HTTP stream; ownership transfers to runAgent. */
export function acquireAgentLease(): AgentLease {
  if (activeLease?.active) throw new RunLimitError("BUSY");
  let active = true;
  const lease: AgentLease = { get active() { return active; }, release() { active = false; if (activeLease === lease) activeLease = undefined; } };
  activeLease = lease;
  return lease;
}
export const createTokenWindow = () => ({ entries: [] as { at: number; tokens: number }[] });
export type TokenWindow = ReturnType<typeof createTokenWindow>;
export interface RequestUsage { kind: "model" | "classification"; reservation: number; reportedTokens?: number; status?: number }
const processWindow = createTokenWindow();
export interface RateProfile { tokensPerMinute: number; requestsPerMinute?: number }
/** Explicit Gemini opt-in is bounded by the reviewed configuration envelope, not an account-wide default. */
export function selectedAgentRateProfile(provider: ProviderName, env: Record<string, string | undefined>): RateProfile {
  if (provider !== "gemini") return { tokensPerMinute: 8000 };
  function setting(name: string, fallback: number, maximum: number) {
    const text = env[name]?.trim();
    if (text === undefined) return fallback;
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("configuration");
    return value;
  }
  return { tokensPerMinute: setting("GEMINI_AGENT_TPM", 8000, 250000), requestsPerMinute: setting("GEMINI_AGENT_RPM", 5, 15) };
}
export interface BudgetOptions {
  signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  emit?: (event: AgentEvent) => void; window?: TokenWindow; maxTokens?: number; maxDurationMs?: number;
  /** Internal pacing configuration. The runner derives its profile only from selected server settings. */
  rateProfile?: RateProfile;
}
export function createRunBudget(options: BudgetOptions = {}) {
  const { tokensPerMinute, requestsPerMinute } = options.rateProfile ?? { tokensPerMinute: 8000 };
  if (!Number.isInteger(tokensPerMinute) || tokensPerMinute < 1 || tokensPerMinute > 250000 || (requestsPerMinute !== undefined && (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 15))) throw new Error("configuration");
  const now = options.now ?? Date.now;
  const started = now();
  const duration = Math.max(1, Math.min(600000, options.maxDurationMs ?? 600000));
  const tokenLimit = Math.max(1, Math.min(32000, options.maxTokens ?? 32000));
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), duration);
  timer.unref?.();
  const window = options.window ?? processWindow;
  let accountedTokens = 0, httpRequests = 0, reportedTokens = 0;
  const requests: RequestUsage[] = [];
  let exhausted = false;
  function check() {
    if (options.signal?.aborted) throw new RunLimitError("CANCELLED");
    if (controller.signal.aborted || now() - started >= duration) throw new RunLimitError("DEADLINE");
    if (exhausted || accountedTokens > tokenLimit) throw new RunLimitError("TOKEN_LIMIT");
  }
  async function sleep(ms: number) {
    check();
    if (now() - started + ms >= duration) throw new RunLimitError("DEADLINE");
    await (options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(ms, signal);
    check();
  }
  async function pace(tokens: number) {
    check();
    tokens = Math.ceil(tokens);
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > tokensPerMinute || accountedTokens + tokens > tokenLimit) { exhausted = true; throw new RunLimitError("TOKEN_LIMIT"); }
    for (;;) {
      check();
      window.entries = window.entries.filter((entry) => now() - entry.at < 60000);
      let rollingTokens = window.entries.reduce((sum, e) => sum + e.tokens, 0);
      let rollingRequests = window.entries.length;
      const fits = () => rollingTokens + tokens <= tokensPerMinute && (requestsPerMinute === undefined || rollingRequests < requestsPerMinute);
      if (fits()) break;
      let durationMs = 1;
      // Wait directly for the earliest expiration that satisfies both constraints.
      for (const entry of [...window.entries].sort((a, b) => a.at - b.at)) {
        rollingTokens -= entry.tokens; rollingRequests--;
        durationMs = Math.max(1, 60000 - (now() - entry.at));
        if (fits()) break;
      }
      options.emit?.({ type: "wait", durationMs, message: "Pacing the shared provider token and request budget." });
      await sleep(durationMs);
    }
    check();
  }
  let preparedTokens = 0;
  async function prepare(body: unknown) { preparedTokens = estimateRequest(JSON.stringify(body)); await pace(preparedTokens); }
  async function retrySleep(ms: number) { await sleep(ms); if (preparedTokens) await pace(preparedTokens); }
  async function reserve(tokens: number) {
    await pace(tokens);
    const entry = { at: now(), tokens: Math.ceil(tokens) };
    window.entries.push(entry); accountedTokens += tokens; httpRequests++;
    let settled = false;
    return (actual?: number) => {
      if (settled) return;
      settled = true;
      if (actual && Number.isFinite(actual) && actual > 0) {
        accountedTokens += actual - entry.tokens; entry.tokens = actual; reportedTokens += actual;
      }
    };
  }
  return { signal, check, sleep, reserve, prepare, retrySleep, requests, counters: () => ({ accountedTokens, reportedTokens, httpRequests, elapsedMs: now() - started }), close() { clearTimeout(timer); } };
}

function estimateRequest(body: string) {
  let output = 4096;
  try {
    const parsed = JSON.parse(body);
    const limit = parsed.max_completion_tokens ?? parsed.generationConfig?.maxOutputTokens;
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) output = Math.ceil(limit);
  } catch { /* Conservative fallback. */ }
  return Math.ceil(Buffer.byteLength(body, "utf8") / 3) + output + 128;
}
function requestKind(body: string): RequestUsage["kind"] {
  try {
    const parsed = JSON.parse(body);
    if (parsed.response_format || parsed.generationConfig?.responseFormat) return "classification";
  } catch { /* Unknown requests retain conservative model accounting. */ }
  return "model";
}

/** Every HTTP attempt, including classifier calls and retries, shares this boundary. */
export function budgetedFetch(fetcher: typeof fetch, budget: ReturnType<typeof createRunBudget>): typeof fetch {
  return async (input, init) => {
    budget.check();
    const body = typeof init?.body === "string" ? init.body : "";
    // UTF-8 / 3 plus framing is deliberately above the usual English token estimate.
    const reservation = estimateRequest(body);
    const settle = await budget.reserve(reservation);
    budget.check();
    const record: RequestUsage = { kind: requestKind(body), reservation };
    budget.requests.push(record);
    const signal = init?.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal;
    const response = await fetcher(input, { ...init, signal });
    record.status = response.status;
    budget.check();
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let abort: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => { void reader.cancel().catch(() => {}); controller.error(new RunLimitError("CANCELLED")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const part = await reader.read();
          if (signal.aborted) return;
          if (part.done) {
            signal.removeEventListener("abort", abort);
            if (size <= 256000) {
              try {
                const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const usage = raw?.usage;
                // Gemini's total includes thinking; prompt + candidate tokens alone undercounts it.
                const actual = raw?.usageMetadata?.totalTokenCount ?? usage?.total_tokens ?? (typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number" ? usage.prompt_tokens + usage.completion_tokens : undefined);
                settle(typeof actual === "number" ? actual : undefined);
                if (typeof actual === "number" && Number.isFinite(actual) && actual > 0) record.reportedTokens = actual;
              } catch { settle(); }
            }
            controller.close();
          } else {
            size += part.value.byteLength;
            if (size <= 256000) chunks.push(part.value);
            controller.enqueue(part.value);
          }
        } catch { signal.removeEventListener("abort", abort); controller.error(new Error("Response unavailable")); }
      },
      cancel() { signal.removeEventListener("abort", abort); return reader.cancel(); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "./contracts";

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
export interface BudgetOptions {
  signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  emit?: (event: AgentEvent) => void; window?: TokenWindow; maxTokens?: number; maxDurationMs?: number;
}
export function createRunBudget(options: BudgetOptions = {}) {
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
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > 8000 || accountedTokens + tokens > tokenLimit) { exhausted = true; throw new RunLimitError("TOKEN_LIMIT"); }
    for (;;) {
      check();
      window.entries = window.entries.filter((entry) => now() - entry.at < 60000);
      if (window.entries.reduce((sum, e) => sum + e.tokens, 0) + tokens <= 8000) break;
      const durationMs = Math.max(1, 60000 - (now() - window.entries[0].at));
      options.emit?.({ type: "wait", durationMs, message: "Pacing Groq token allowance." });
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
  try { const parsed = JSON.parse(body); output = parsed.max_completion_tokens ?? output; } catch { /* Conservative fallback. */ }
  return Math.ceil(Buffer.byteLength(body, "utf8") / 3) + output + 128;
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
    const record: RequestUsage = { kind: body.includes('"response_format"') ? "classification" : "model", reservation };
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
                const actual = usage?.total_tokens ?? (typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number" ? usage.prompt_tokens + usage.completion_tokens : undefined);
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

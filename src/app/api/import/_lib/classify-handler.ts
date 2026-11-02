import "server-only";
import { createBudgetedClassifier } from "@/agent/budgeted-classifier";
import { acquireAgentLease, budgetedFetch, createRunBudget, selectedAgentRateProfile, type AgentLease, type TokenWindow } from "@/agent/limits";
import { selectedProvider } from "@/agent/model";
import { admitHostedRequest } from "@/hosting/guard";
import { ClassifyRequestSchema, payloadIssues } from "@/import/import-payload";
import { classifyImportedFeedback } from "@/signals/import-classify";
import { importPredictionCache, type MemoryPredictionCache } from "@/signals/memory-cache";
import { WorkerTaskError } from "@/twin/worker-client";
import { errorResponse, invalidImportResponse, readBoundedJson } from "../../_lib/http";

/** 200 rows of at most 1,000 characters, JSON-escaped (decision 4). */
export const MAX_CLASSIFY_BYTES = 640 * 1024;
export const CLASSIFY_DEADLINE_MS = 300_000;

interface Deps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  cache?: MemoryPredictionCache;
  window?: TokenWindow;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const unavailable = () => Response.json({ error: "CLASSIFIER_UNAVAILABLE", message: "Feedback classification is not configured on this server. Import without feedback, or try again later." }, { status: 503 });
const busy = () => Response.json({ error: "BUSY", message: "An agent run or another classification is active. Try again after it finishes." }, { status: 409 });
const aborted = () => Response.json({ error: "ABORTED", message: "Classification cancelled." }, { status: 408 });
const failed = () => Response.json({ error: "CLASSIFICATION_FAILED", message: "Feedback classification failed. Import without feedback, or try again later." }, { status: 502 });

/**
 * Classifies uploaded feedback (M6). Order: hosted origin and `classify` admission (never agent runs), then the
 * configuration check, the bounded body and schema, then the shared agent lease (serialized with agent runs), the
 * selected provider's rate profile and a 300 s deadline. A deadline, token or provider stop returns partial counts; a
 * client abort returns the abort response. Feedback text is never stored, logged or echoed, and the response carries
 * counts and notes only (no cache-hit count, which would reveal identical text from another uploader). Injection
 * belongs to server tests, never request JSON.
 */
export function createClassifyHandler(deps: Deps = {}) {
  return async function POST(request: Request): Promise<Response> {
    const admission = await admitHostedRequest(request, { limit: "classify" });
    if (admission) return admission;
    const env = deps.env ?? process.env;
    let selected: ReturnType<typeof selectedProvider>;
    let rateProfile: ReturnType<typeof selectedAgentRateProfile>;
    try { selected = selectedProvider(env); rateProfile = selectedAgentRateProfile(selected.provider, env); }
    catch { return unavailable(); }
    let raw: unknown;
    try { raw = await readBoundedJson(request, { maxBytes: MAX_CLASSIFY_BYTES }); }
    catch (e) { return e instanceof WorkerTaskError && e.code === "ABORTED" ? aborted() : errorResponse(e); }
    const parsed = ClassifyRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidImportResponse(payloadIssues(parsed.error));
    let lease: AgentLease;
    try { lease = acquireAgentLease(); }
    catch { return busy(); }
    let budget: ReturnType<typeof createRunBudget> | undefined;
    try {
      if (request.signal.aborted) return aborted();
      budget = createRunBudget({ signal: request.signal, rateProfile, maxDurationMs: CLASSIFY_DEADLINE_MS, window: deps.window, now: deps.now, sleep: deps.sleep });
      const fetcher = budgetedFetch(deps.fetch ?? globalThis.fetch, budget);
      const provider = createBudgetedClassifier({ ...selected, env, fetch: fetcher, sleep: budget.retrySleep }, budget, { onLimit: "stop" });
      const result = await classifyImportedFeedback(parsed.data.rows, { provider, cache: deps.cache ?? importPredictionCache });
      // The budgeted classifier reports a cancellation as a stop; the client is gone, so partial counts mean nothing.
      if (request.signal.aborted) return aborted();
      const { reasonCounts, total, accepted, unclassified, stopped, notes } = result;
      return Response.json({ reasonCounts, total, accepted, unclassified, stopped, notes, provider: selected.provider, model: selected.model });
    } catch {
      return request.signal.aborted ? aborted() : failed();
    } finally {
      budget?.close();
      lease.release();
    }
  };
}

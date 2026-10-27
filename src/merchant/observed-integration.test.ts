import { expect, it, vi } from "vitest";
import { currentMerchant } from ".";
import { STARTER_STRATEGIES } from "./candidates";
import { compareStrategies } from "@/twin/simulate";
import { readAgentStream } from "@/agent/stream";
import { createToolContext } from "@/agent/tools";
import { emptyMetrics } from "@/signals/providers";
import { feedbackCorpus } from "@/signals/corpus";

const mocks = vi.hoisted(() => ({ observed: vi.fn(), compare: vi.fn(), propose: vi.fn(), boundary: vi.fn() }));
vi.mock("./observed", () => ({ observedMerchant: mocks.observed }));
vi.mock("next/server", () => ({ connection: mocks.boundary }));
vi.mock("@/twin/worker-client", async importOriginal => ({ ...await importOriginal<object>(), runComparison: mocks.compare }));
vi.mock("@/ledger/proposals", async importOriginal => ({ ...await importOriginal<object>(), createProposal: mocks.propose }));
import { POST as simulate } from "@/app/api/simulate/route";
import { POST as propose } from "@/app/api/proposals/route";
import { GET as twinGet } from "@/app/api/twin/route";
import { runAgent } from "@/agent/run";

it("uses the same request-time observed parameters in manual/proposal/API/agent paths", async () => {
  const observed = currentMerchant();
  observed.twin.params.offerChurnRelativeRisk.price = { shape: 11, rate: 23 };
  observed.twin.provenance["offerChurnRelativeRisk.price"] = { source: "observed", note: "Fixture measured effect", evidenceCount: .5 };
  mocks.observed.mockResolvedValue({ ...observed, evidence: { subscriberMonths: .5 }, changes: [] });
  const strategy = STARTER_STRATEGIES.find(s => s.intervention.kind === "targeted_discount")!;
  mocks.compare.mockImplementation((twin, strategies) => compareStrategies(twin, strategies, { runs: 2, horizonMonths: 1 }));
  mocks.propose.mockResolvedValue({ id: "fixture" });
  await simulate(new Request("http://localhost/api/simulate", { method: "POST", body: JSON.stringify({ strategies: [strategy] }) }));
  await propose(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ strategy }) }));
  expect(mocks.compare.mock.calls.map(call => call[0])).toEqual([observed.twin, observed.twin]);
  expect((await (await twinGet()).json()).twin).toEqual(observed.twin);
  expect(mocks.boundary).toHaveBeenCalled();
  let received: unknown;
  await runAgent({ objective: "Fixture", env: { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake" }, model: { async respond() { return { message: { role: "assistant", content: "No proposal." }, metrics: emptyMetrics() }; } }, createTools(options) { received = options.twin; return createToolContext(options); } });
  expect(received).toEqual(observed.twin);
  mocks.observed.mockClear();
  await runAgent({ objective: "Injected fixture", env: { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake" }, readMerchant: async () => ({ twin: observed.twin }), model: { async respond() { return { message: { role: "assistant", content: "No proposal." }, metrics: emptyMetrics() }; } }, createTools(options) { received = options.twin; return createToolContext(options); } });
  expect(mocks.observed).not.toHaveBeenCalled();
});

it("classification preserves measured effect parameters and fractional stream provenance", async () => {
  const twin = currentMerchant().twin;
  twin.params.offerChurnRelativeRisk.price = { shape: 11, rate: 23 };
  twin.provenance["offerChurnRelativeRisk.price"] = { source: "observed", note: "Fixture effect", evidenceCount: .5 };
  const events: unknown[] = [];
  const context = createToolContext({ twin, provider: { provider: "groq", model: "fixture", classify: vi.fn() }, registry: () => [], emit: event => events.push(event), classify: async () => ({ accepted: feedbackCorpus.map(m => ({ id: m.id, intent: "cancel", reason: "price", confidence: .9 })), total: 200, cacheHits: 0, unclassified: [], diagnostics: [], schemaValidCount: 200, batches: [], metrics: emptyMetrics(), stopped: false }) });
  expect(await context.dispatch("classify_feedback", {})).toMatchObject({ ok: true });
  expect(context.state.twin.params.offerChurnRelativeRisk.price).toEqual(twin.params.offerChurnRelativeRisk.price);
  const classification = events.find((e: unknown) => (e as { type: string }).type === "classification");
  const stream = [classification, { type: "done", status: "incomplete" }].map((event, i) => JSON.stringify({ runId: "fixture", seq: i + 1, event })).join("\n") + "\n";
  await expect(readAgentStream(new Response(stream), { onEvent() {} })).resolves.toMatchObject({ status: "incomplete" });
});

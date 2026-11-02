import { expect, it, vi } from "vitest";
import type { AgentEvent } from "./contracts";
import { createTokenWindow } from "./limits";
import type { AgentModel, AssistantMessage } from "./model";
import { AGENT_INSTRUCTION, runAgent } from "./run";
import { TOOL_DEFINITIONS } from "./tools";
import { buildImportedTwin } from "@/import/imported-twin";
import { SAMPLE_REASON_COUNTS } from "@/import/sample-merchant";
import { ledger } from "@/ledger/db";
import { listProposals } from "@/ledger/proposals";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { emptyMetrics } from "@/signals/providers";
import { samplePayload } from "@/test/import-fixture";
import { compareStrategies } from "@/twin/simulate";
import { stressTest } from "@/twin/stress";

// An imported run must never read Ridgeline's observed ledger evidence.
const reads = vi.hoisted(() => ({ discount: 0, annual: 0 }));
vi.mock("@/ledger/discount-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/discount-outcomes")>();
  return { ...actual, readDiscountOutcomes: vi.fn(async (...args: Parameters<typeof actual.readDiscountOutcomes>) => { reads.discount++; return actual.readDiscountOutcomes(...args); }) };
});
vi.mock("@/ledger/annual-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ledger/annual-offers")>();
  return { ...actual, readAnnualOfferEvidence: vi.fn(async (...args: Parameters<typeof actual.readAnnualOfferEvidence>) => { reads.annual++; return actual.readAnnualOfferEvidence(...args); }) };
});

const env = { AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: "fake-key" };
const call = (id: string, name: string, args: unknown = {}): AssistantMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const pick = STARTER_STRATEGIES[0];
const description = (definitions: typeof TOOL_DEFINITIONS, name: string) => definitions.find((d) => d.function.name === name)?.function.description;

it("runs an imported merchant simulate-only: no observed evidence, no proposal, complete after recommend", async () => {
  ledger().exec("DELETE FROM proposals;");
  reads.discount = 0; reads.annual = 0;
  const built = buildImportedTwin(samplePayload());
  if (!built.ok) throw new Error("The sample must build.");
  const sequence = [
    call("state", "get_merchant_state"), call("classify", "classify_feedback"),
    call("rules", "set_decision_rules", { discountBudget: 1000, maxProbWorse: 1, horizonMonths: 1 }),
    call("compare", "simulate_strategies", { strategies: [pick] }), call("stress", "stress_test", { strategyId: pick.id }),
    call("recommend", "recommend", { strategyId: pick.id, rationale: "At-risk leavers mostly cite price", tradeoffs: "Discount cost" }),
    say("Simulate-only recommendation recorded."),
  ];
  let turn = 0;
  const model = { respond: vi.fn<AgentModel["respond"]>(async () => ({ message: sequence[turn++] ?? say("Done"), metrics: emptyMetrics() })) };
  const propose = vi.fn();
  const readMerchant = vi.fn();
  const events: AgentEvent[] = [];
  const result = await runAgent({
    objective: "Find the most valuable way to keep at-risk subscribers", env, window: createTokenWindow(), model, emit: (e) => events.push(e), readMerchant,
    imported: { twin: built.twin, reasonCounts: SAMPLE_REASON_COUNTS, feedbackRows: 40, reasonTargeting: true },
    toolOptions: {
      propose,
      simulate: (t, candidates, options) => compareStrategies(t, candidates, { ...options, runs: 20 }),
      stress: (t, strategy, options) => stressTest(t, strategy, { ...options, runs: 20 }),
    },
  });
  expect(result).toMatchObject({ status: "complete", reason: "COMPLETE" });
  expect(result.proposalId).toBeUndefined();
  expect(reads).toEqual({ discount: 0, annual: 0 });
  expect(readMerchant).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
  expect(events.some((e) => e.type === "observed_snapshot" || e.type === "proposal")).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "recommendation", simulateOnly: true }));
  expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("Imported merchant: simulate only") }));
  expect(events.at(-1)).toEqual({ type: "done", status: "complete", reason: "COMPLETE" });
  expect(await listProposals()).toHaveLength(0);
  // The turn after recommend offers no tools, exactly as after a proposal.
  expect(model.respond).toHaveBeenCalledTimes(7);
  expect(model.respond.mock.calls[6][1]).toEqual([]);
  expect(model.respond.mock.calls[6][2]).toMatchObject({ final: true });

  const [messages, definitions] = model.respond.mock.calls[0];
  const system = String(messages[0].content);
  expect(system.startsWith(AGENT_INSTRUCTION)).toBe(true);
  expect(system).toContain("Imported merchant (simulate only)");
  expect(system).toMatch(/classified before this run/);
  expect(system).toMatch(/creates no PayPal action/);
  expect(system).toMatch(/or in the tool descriptions/);
  expect(system).toMatch(/simulate only, instead of mentioning merchant approval/);
  // Imported wording for the two tools whose Ridgeline descriptions would be inaccurate; same names and schemas.
  expect(description(definitions, "classify_feedback")).toMatch(/classified before this run/);
  expect(description(definitions, "classify_feedback")).not.toMatch(/synthetic/i);
  expect(description(definitions, "recommend")).toMatch(/simulate-only/);
  expect(description(definitions, "recommend")).not.toMatch(/proposed action/);
  expect(definitions.map((d) => d.function.name)).toEqual(TOOL_DEFINITIONS.map((d) => d.function.name));
  expect(definitions.map((d) => d.function.parameters)).toEqual(TOOL_DEFINITIONS.map((d) => d.function.parameters));
});

it("keeps Ridgeline's instruction and tool descriptions unchanged", () => {
  expect(description(TOOL_DEFINITIONS, "recommend")).toBe("Create one proposed action (a retention discount or an annual-plan offer) from a classified, simulated and stressed candidate within the rules. Merchant approval is separate.");
  expect(description(TOOL_DEFINITIONS, "classify_feedback")).toBe("Classify synthetic feedback using the selected provider and cache; update reason estimates and pilot eligibility.");
  expect(AGENT_INSTRUCTION).not.toContain("Imported merchant");
});

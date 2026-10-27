import { beforeAll, describe, expect, it, vi } from "vitest";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import { ledger } from "./db";
import type { Strategy } from "@/twin/interventions";
import {
  approveProposal,
  buildAction,
  hashAction,
  PriceOverrideActionSchema,
  claimForExecution,
  createProposal,
  finishExecution,
  listSandboxSubscribers,
  ProposalError,
  registerSandboxSubscriber,
  rejectProposal,
} from "./proposals";

const { twin } = currentMerchant();
const strategy: Strategy = {
  id: "cancel-price-25",
  name: "25% off price-driven cancel intent for 3 months",
  intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 },
};
const result = compareStrategies(twin, [strategy], { runs: 100 }).strategies[1];

beforeAll(async () => {
  await registerSandboxSubscriber({ subscriptionId: "I-PRICE000001", label: "A", segment: "cancel_intent", reason: "price" });
  await registerSandboxSubscriber({ subscriptionId: "I-PRICE000002", label: "B", segment: "cancel_intent", reason: "price" });
  await registerSandboxSubscriber({ subscriptionId: "I-OTHER000001", label: "C", segment: "cancel_intent", reason: "other" });
  await registerSandboxSubscriber({ subscriptionId: "I-CORE0000001", label: "D", segment: "core", reason: "other" });
});

const propose = () => createProposal({ objective: "reduce churn", strategy, result, listPrice: twin.params.listPrice });
const code = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return e instanceof ProposalError ? e.code : "OTHER";
  }
  return "NO_ERROR";
};

describe("proposal lifecycle", () => {
  it("intersects a server allowlist before capping, preserves registry order, and never falls back from empty", async () => {
    expect((await buildAction(strategy, 24, ["I-PRICE000002", "I-CORE0000001", "I-PRICE000001", "I-UNKNOWN"])).targets).toEqual(["I-PRICE000001", "I-PRICE000002"]);
    expect((await buildAction(strategy, 24, ["I-PRICE000002"])).targets).toEqual(["I-PRICE000002"]);
    expect(await code(() => buildAction(strategy, 24, []))).toBe("NO_TARGETS");
    const proposal = await createProposal({ objective: "reduce churn", strategy, result, listPrice: 24, eligibleTargetIds: ["I-PRICE000002"] });
    expect(proposal.action.targets).toEqual(["I-PRICE000002"]);
    expect(proposal.actionHash).toBe(hashAction(proposal.action));
  });
  const discount = (reason: "price" | "any", campaignMonths = 0): Strategy => ({
    ...strategy,
    intervention: { kind: "targeted_discount", segment: "cancel_intent", reason, discountPct: 25, months: 3, campaignMonths },
  });

  it("includes every cancel-intent reason for any, excluding core", async () => {
    expect((await buildAction(discount("any"), 24)).targets).toEqual(["I-PRICE000001", "I-PRICE000002", "I-OTHER000001"]);
  });

  it("persists campaign metadata and binds it and reason to the approved hash", async () => {
    const p = await createProposal({ objective: null, strategy: discount("price", 6), result, listPrice: 24 });
    if (p.action.type !== "subscription_price_override") throw new Error("Expected discount action");
    expect(p.action).toMatchObject({ reason: "price", campaignMonths: 6 });
    expect(p.actionHash).toBe(hashAction(p.action));
    expect(hashAction({ ...p.action, campaignMonths: 0 })).not.toBe(p.actionHash);
    expect(hashAction({ ...p.action, reason: "any" })).not.toBe(p.actionHash);
    for (const campaignMonths of [-1, 0.5, 13]) {
      expect(PriceOverrideActionSchema.safeParse({ ...p.action, campaignMonths }).success).toBe(false);
    }
  });

  it("reports both segment and reason when that reason has no matching pilots", async () => {
    ledger().prepare("UPDATE sandbox_subscribers SET reason = 'other' WHERE reason = 'price'").run();
    try {
      expect(await code(() => buildAction(discount("price"), 24))).toBe("NO_TARGETS");
      await expect(buildAction(discount("price"), 24)).rejects.toThrow(/cancel_intent.*price/);
    } finally {
      ledger().prepare("UPDATE sandbox_subscribers SET reason = 'price' WHERE label IN ('A', 'B')").run();
    }
  });

  it("falls back to other with a warning for invalid persisted reasons, preserving order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ledger().prepare("UPDATE sandbox_subscribers SET reason = 'unknown' WHERE label = 'C'").run();
    try {
      expect((await listSandboxSubscribers()).map((s) => [s.label, s.reason])).toEqual([
        ["A", "price"], ["B", "price"], ["C", "other"], ["D", "other"],
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/invalid.*reason/i);
    } finally {
      ledger().prepare("UPDATE sandbox_subscribers SET reason = 'other' WHERE label = 'C'").run();
      warn.mockRestore();
    }
  });

  it("caps matching targets at 25 in registration order", async () => {
    try {
      for (let i = 0; i < 30; i++) {
        await registerSandboxSubscriber({ subscriptionId: `I-EXTRA${i}`, label: "extra", segment: "cancel_intent", reason: "price" });
      }
      const action = await buildAction(discount("price"), 24);
      expect(action.targets).toHaveLength(25);
      expect(action.targets).toEqual(["I-PRICE000001", "I-PRICE000002", ...Array.from({ length: 23 }, (_, i) => `I-EXTRA${i}`)]);
      expect((await buildAction(discount("price"), 24, ["I-EXTRA29"])).targets).toEqual(["I-EXTRA29"]);
    } finally {
      ledger().prepare("DELETE FROM sandbox_subscribers WHERE label = 'extra'").run();
    }
  });

  it("stores each pilot subscription's reason", async () => {
    expect((await listSandboxSubscribers()).map((s) => [s.subscriptionId, s.reason])).toEqual([
      ["I-PRICE000001", "price"],
      ["I-PRICE000002", "price"],
      ["I-OTHER000001", "other"],
      ["I-CORE0000001", "other"],
    ]);
  });

  it("targets only subscriptions in the strategy's segment, at the discounted price", async () => {
    const p = await propose();
    if (p.action.type !== "subscription_price_override") throw new Error("Expected discount action");
    expect(p.action.targets).toEqual(["I-PRICE000001", "I-PRICE000002"]);
    expect(p.action.newPrice).toBe("18.00");
    expect(p.status).toBe("proposed");
    expect(p.action).toMatchObject({ reason: "price", campaignMonths: 0 });
  });

  it("cannot execute without approval", async () => {
    expect(await code(() => propose().then((p) => claimForExecution(p.id)))).toBe("INVALID_STATE");
  });

  it("rejects approval of a payload other than the one proposed", async () => {
    const p = await propose();
    expect(await code(() => approveProposal(p.id, "0".repeat(64), "merchant"))).toBe("HASH_MISMATCH");
  });

  it("executes an approved proposal exactly once", async () => {
    const p = await propose();
    await approveProposal(p.id, p.actionHash, "merchant");
    expect(await code(() => approveProposal(p.id, p.actionHash, "merchant"))).toBe("INVALID_STATE");
    expect((await claimForExecution(p.id)).status).toBe("executing");
    expect(await code(() => claimForExecution(p.id))).toBe("INVALID_STATE");
    await finishExecution(p.id, "succeeded", null);
    expect(await code(() => claimForExecution(p.id))).toBe("INVALID_STATE");
  });

  it("cannot approve a rejected proposal", async () => {
    const p = await propose();
    await rejectProposal(p.id, "not now");
    expect(await code(() => approveProposal(p.id, p.actionHash, "merchant"))).toBe("INVALID_STATE");
  });

  it("refuses strategies with no executable PayPal action", async () => {
    const priceChange: Strategy = { id: "rise", name: "Rise", intervention: { kind: "list_price_change", newPrice: 27 } };
    expect(await code(() => createProposal({ objective: null, strategy: priceChange, result, listPrice: 24 }))).toBe("NOT_EXECUTABLE");
  });
});

import { describe, expect, it } from "vitest";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import type { Strategy } from "@/twin/interventions";
import {
  approveProposal,
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
  id: "at-risk-20",
  name: "20% off at-risk for 3 months",
  intervention: { kind: "targeted_discount", segment: "at_risk", reason: "any", discountPct: 20, months: 3 },
};
const result = compareStrategies(twin, [strategy], { runs: 100 }).strategies[1];

registerSandboxSubscriber({ subscriptionId: "I-ATRISK0001", label: "A", segment: "at_risk", reason: "price" });
registerSandboxSubscriber({ subscriptionId: "I-CORE000001", label: "D", segment: "core", reason: "other" });

const propose = () => createProposal({ objective: "reduce churn", strategy, result, listPrice: twin.params.listPrice });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ProposalError ? e.code : "OTHER";
  }
  return "NO_ERROR";
};

describe("proposal lifecycle", () => {
  it("stores each pilot subscription's reason", () => {
    expect(listSandboxSubscribers().map((s) => [s.subscriptionId, s.reason])).toEqual([
      ["I-ATRISK0001", "price"],
      ["I-CORE000001", "other"],
    ]);
  });

  it("targets only subscriptions in the strategy's segment, at the discounted price", () => {
    const p = propose();
    expect(p.action.targets).toEqual(["I-ATRISK0001"]);
    expect(p.action.newPrice).toBe("19.20");
    expect(p.status).toBe("proposed");
  });

  it("cannot execute without approval", () => {
    expect(code(() => claimForExecution(propose().id))).toBe("INVALID_STATE");
  });

  it("rejects approval of a payload other than the one proposed", () => {
    expect(code(() => approveProposal(propose().id, "0".repeat(64), "merchant"))).toBe("HASH_MISMATCH");
  });

  it("executes an approved proposal exactly once", () => {
    const p = propose();
    approveProposal(p.id, p.actionHash, "merchant");
    expect(code(() => approveProposal(p.id, p.actionHash, "merchant"))).toBe("INVALID_STATE");
    expect(claimForExecution(p.id).status).toBe("executing");
    expect(code(() => claimForExecution(p.id))).toBe("INVALID_STATE");
    finishExecution(p.id, "succeeded", null);
    expect(code(() => claimForExecution(p.id))).toBe("INVALID_STATE");
  });

  it("cannot approve a rejected proposal", () => {
    const p = propose();
    rejectProposal(p.id, "not now");
    expect(code(() => approveProposal(p.id, p.actionHash, "merchant"))).toBe("INVALID_STATE");
  });

  it("refuses strategies with no executable PayPal action", () => {
    const priceChange: Strategy = { id: "rise", name: "Rise", intervention: { kind: "list_price_change", newPrice: 27 } };
    expect(code(() => createProposal({ objective: null, strategy: priceChange, result, listPrice: 24 }))).toBe("NOT_EXECUTABLE");
  });
});

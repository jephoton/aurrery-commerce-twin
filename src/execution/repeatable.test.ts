import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { createProposalRepository, hashAction, type PriceOverrideAction } from "@/ledger/proposals";
import { executeProposalWith, recordObservation, recordTarget } from "./execute";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";

it("executes discount → restore → discount with an override remaining on the restored list price", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  try {
    await initializeLedgerSchema(connection);
    const repository = createProposalRepository(connection);
    await repository.registerSandboxSubscriber({ subscriptionId: "I-ONE", label: "Pilot", segment: "core", reason: "price" });
    const action: PriceOverrideAction = { type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00", discountPct: 25, months: 3, campaignMonths: 0, targets: ["I-ONE"] };
    const sourceId = "prop_00000000-0000-4000-8000-000000000081";
    const secondId = "prop_00000000-0000-4000-8000-000000000082";
    async function insertApproved(id: string) {
      await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [id, new Date().toISOString(), "{}", "{}", action.type, JSON.stringify(action), hashAction(action), "approved", new Date().toISOString(), "merchant"]);
    }
    await insertApproved(sourceId);
    let price = "24.0";
    let overridden = false;
    const patched: string[] = [];
    const deps = {
      claim: repository.claimForExecution, get: repository.getProposal, finish: repository.finishExecution,
      validateTarget: repository.validateTargetForExecution,
      read: async (id: string) => ({ ok: true as const, value: { id, status: "ACTIVE", regularPrice: price, planOverridden: overridden,
        nextBillingTime: null, lastPayment: null, planId: null, raw: {} } satisfies SubscriptionSnapshot, debugId: null }),
      patch: async (_id: string, amount: string) => { patched.push(amount); price = amount === "24.00" ? "24.0" : "18.0"; overridden = true;
        return { ok: true as const, value: { httpStatus: 204 }, debugId: null }; },
      record: (id: string, request: unknown, outcome: Parameters<typeof recordTarget>[2], snapshot: SubscriptionSnapshot | null) => recordTarget(id, request, outcome, snapshot, connection),
      recordObservation: (snapshot: SubscriptionSnapshot, source: string) => recordObservation(snapshot, source, connection),
    };
    const discount = await executeProposalWith(sourceId, deps);
    expect(discount.proposal.status).toBe("succeeded");
    expect(discount.outcomes[0].verified).toBe(true);
    const revert = await repository.createRevertProposal(sourceId);
    expect(revert.prediction).toBeNull();
    await repository.approveProposal(revert.id, revert.actionHash, "merchant");
    const restored = await executeProposalWith(revert.id, deps);
    expect(restored.proposal.status).toBe("succeeded");
    expect(restored.proposal.revertAfter).toBeNull();
    expect(overridden).toBe(true);
    await insertApproved(secondId);
    const second = await executeProposalWith(secondId, deps);
    expect(second.proposal.status).toBe("succeeded");
    expect(patched).toEqual(["18.00", "24.00", "18.00"]);
    expect(await connection.query("SELECT COUNT(*) AS n FROM discount_episodes")).toEqual([{ n: 2 }]);
    expect(await connection.query("SELECT COUNT(*) AS n FROM executions")).toEqual([{ n: 3 }]);
  } finally { db.close(); }
});

import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { executeProposalWith, listExecutions } from "./execute";
import type { Proposal } from "@/ledger/proposals";

it("leaves execution unresolved and never retries PayPal when recording an applied patch fails", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_override", targets: ["I-ONE", "I-TWO"], listPrice: "24.00", newPrice: "18.00", months: 3 } } as Proposal;
  const patch = vi.fn().mockResolvedValue({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const finish = vi.fn();
  await expect(executeProposalWith("p", {
    claim: async () => proposal,
    get: async () => proposal,
    finish,
    patch,
    read: vi.fn().mockImplementationOnce(async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "24.00", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null }))
      .mockImplementationOnce(async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null })),
    record: async () => { throw new Error("acknowledgement lost"); },
  })).rejects.toThrow(/reconcile/i);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(finish).not.toHaveBeenCalled();
});

it("reads execution history on an authoritative handle", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  try {
    await initializeLedgerSchema(connection);
    await connection.executeMultiple("PRAGMA foreign_keys = OFF;");
    await expect(listExecutions("p", connection)).rejects.toThrow(/foreign key/i);
  } finally { db.close(); }
});

it("does not call PayPal when a claim cannot be acknowledged", async () => {
  const patch = vi.fn();
  await expect(executeProposalWith("p", {
    claim: async () => { throw new Error("storage unavailable"); },
    get: vi.fn(), finish: vi.fn(), patch, read: vi.fn(), record: vi.fn(),
  })).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: "p" });
  expect(patch).not.toHaveBeenCalled();
});

it("finishes a known client-side PayPal failure without calling the next target twice", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_override", targets: ["I-ONE", "I-TWO"], listPrice: "24.00", newPrice: "18.00", months: 3 } } as Proposal;
  const patch = vi.fn().mockResolvedValueOnce({ ok: false, error: { httpStatus: 422, name: "UNPROCESSABLE", message: "Rejected", debugId: null } })
    .mockResolvedValueOnce({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const finish = vi.fn().mockResolvedValue(undefined);
  const report = await executeProposalWith("p", {
    claim: async () => proposal, get: async () => proposal, finish, patch,
    read: vi.fn().mockImplementationOnce(async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "24.00", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null }))
      .mockImplementationOnce(async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "24.00", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null }))
      .mockImplementationOnce(async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null })),
    record: async () => {},
  });
  expect(patch.mock.calls.map(([id]) => id)).toEqual(["I-ONE", "I-TWO"]);
  expect(finish).toHaveBeenCalledWith("p", "partially_failed", expect.any(String), { succeeded: 1, total: 2 });
  expect(report.outcomes.map((outcome) => outcome.ok)).toEqual([false, true]);
});

it("reads and records the discounted current price before reverting, then restores list price without a new schedule", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const patch = vi.fn().mockResolvedValue({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const recordObservation = vi.fn();
  const record = vi.fn();
  const finish = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null })
    .mockResolvedValueOnce({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "24.00", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null });
  await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish, patch, read, record, recordObservation });
  expect(recordObservation).toHaveBeenCalledOnce();
  expect(recordObservation.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
  expect(patch).toHaveBeenCalledWith("I-ONE", "24.00");
  expect(record).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith("p", "succeeded", null, { succeeded: 1, total: 1 });
});

it("does not PATCH after a current-price mismatch and finishes a known preflight failure", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const patch = vi.fn();
  const finish = vi.fn();
  const record = vi.fn();
  await executeProposalWith("p", {
    claim: async () => proposal, get: async () => proposal, finish, patch, record,
    read: async () => ({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "20.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }),
    recordObservation: vi.fn(),
  });
  expect(patch).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith("p", "failed", null, { succeeded: 0, total: 1 });
});

it("does not verify a PATCH read-back for a different or inactive subscription", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const read = vi.fn().mockResolvedValueOnce({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null })
    .mockResolvedValueOnce({ ok: true, value: { id: "I-OTHER", status: "SUSPENDED", regularPrice: "24.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null });
  const record = vi.fn();
  const finish = vi.fn();
  await expect(executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish,
    patch: async () => ({ ok: true, value: { httpStatus: 204 }, debugId: null }), read, record, recordObservation: vi.fn(),
  })).rejects.toThrow(/reconcile/i);
  expect(record.mock.calls[0][2].verified).toBe(false);
  expect(finish).not.toHaveBeenCalled();
});

it("does not restore a matching price that is no longer a subscription override", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const patch = vi.fn();
  await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish: vi.fn(), patch,
    read: async () => ({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "18.00", planOverridden: false, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }),
    record: vi.fn(), recordObservation: vi.fn() });
  expect(patch).not.toHaveBeenCalled();
});

it("rechecks local authority after the PayPal pre-read and stops before PATCH when registration changes", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const patch = vi.fn();
  const validateTarget = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const record = vi.fn();
  const finish = vi.fn();
  await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish, patch,
    read: async () => ({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }),
    record, recordObservation: vi.fn(), validateTarget });
  expect(validateTarget).toHaveBeenCalledTimes(2);
  expect(patch).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith("p", "failed", null, { succeeded: 0, total: 1 });
});

it("reports a partial recovery after a definitive client failure without scheduling another revert", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: ["I-ONE", "I-TWO"].map((subscriptionId) => ({ subscriptionId, expectedCurrentPrice: "18.00", listPrice: "24.00" })) } } as Proposal;
  const patch = vi.fn().mockResolvedValueOnce({ ok: false, error: { httpStatus: 422, name: "UNPROCESSABLE", message: "Rejected", debugId: null } })
    .mockResolvedValueOnce({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const read = vi.fn().mockImplementationOnce(async () => ({ ok: true, value: { id: "I-ONE", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }))
    .mockImplementationOnce(async () => ({ ok: true, value: { id: "I-TWO", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }))
    .mockImplementationOnce(async () => ({ ok: true, value: { id: "I-TWO", status: "ACTIVE", regularPrice: "24.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }));
  const finish = vi.fn();
  await executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish, patch, read, record: vi.fn(), recordObservation: vi.fn() });
  expect(patch.mock.calls.map(([id]) => id)).toEqual(["I-ONE", "I-TWO"]);
  expect(finish).toHaveBeenCalledWith("p", "partially_failed", null, { succeeded: 1, total: 2 });
});

it("stops recovery on an ambiguous PATCH acknowledgement without touching the next target", async () => {
  const proposal = { id: "p", action: { type: "subscription_price_revert", targets: ["I-ONE", "I-TWO"].map((subscriptionId) => ({ subscriptionId, expectedCurrentPrice: "18.00", listPrice: "24.00" })) } } as Proposal;
  const patch = vi.fn().mockRejectedValue(new Error("transport lost"));
  const finish = vi.fn();
  await expect(executeProposalWith("p", { claim: async () => proposal, get: async () => proposal, finish, patch,
    read: async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} }, debugId: null }),
    record: vi.fn(), recordObservation: vi.fn() })).rejects.toThrow(/reconcile/i);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(finish).not.toHaveBeenCalled();
});

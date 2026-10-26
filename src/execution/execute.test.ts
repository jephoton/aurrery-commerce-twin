import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { executeProposalWith, listExecutions } from "./execute";
import type { Proposal } from "@/ledger/proposals";

it("leaves execution unresolved and never retries PayPal when recording an applied patch fails", async () => {
  const proposal = { id: "p", action: { targets: ["I-ONE", "I-TWO"], newPrice: "18.00", months: 3 } } as Proposal;
  const patch = vi.fn().mockResolvedValue({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const finish = vi.fn();
  await expect(executeProposalWith("p", {
    claim: async () => proposal,
    get: async () => proposal,
    finish,
    patch,
    read: async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null }),
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
  const proposal = { id: "p", action: { targets: ["I-ONE", "I-TWO"], newPrice: "18.00", months: 3 } } as Proposal;
  const patch = vi.fn().mockResolvedValueOnce({ ok: false, error: { httpStatus: 422, name: "UNPROCESSABLE", message: "Rejected", debugId: null } })
    .mockResolvedValueOnce({ ok: true, value: { httpStatus: 204 }, debugId: null });
  const finish = vi.fn().mockResolvedValue(undefined);
  const report = await executeProposalWith("p", {
    claim: async () => proposal, get: async () => proposal, finish, patch,
    read: async (id) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: { id } }, debugId: null }),
    record: async () => {},
  });
  expect(patch.mock.calls.map(([id]) => id)).toEqual(["I-ONE", "I-TWO"]);
  expect(finish).toHaveBeenCalledWith("p", "partially_failed", expect.any(String), { succeeded: 1, total: 2 });
  expect(report.outcomes.map((outcome) => outcome.ok)).toEqual([false, true]);
});

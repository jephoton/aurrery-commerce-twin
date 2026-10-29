import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalConnection, initializeLedgerSchema } from "./connection";
import { createProposalRepository, ResetActionSchema } from "./proposals";
import { PILOT_COHORT } from "@/paypal/setup";
import * as merchant from "@/merchant";

afterEach(() => vi.restoreAllMocks());

it.each(["18", "18.0", "18.00"])("preserves raw captured %s and stores no simulated strategy", async (expectedCurrentPrice) => {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db); await initializeLedgerSchema(connection);
    const repo = createProposalRepository(connection);
    await repo.registerSandboxSubscriber({ subscriptionId: "I-A", ...PILOT_COHORT[0] });
    const registration = { ...PILOT_COHORT[0], createdAt: String((await connection.query("SELECT created_at FROM sandbox_subscribers"))[0].created_at) };
    const proposal = await repo.createResetProposal("24.00", [{ subscriptionId: "I-A", expectedCurrentPrice, registration }]);
    expect(proposal.strategy).toBeNull(); expect(proposal.prediction).toBeNull();
    expect(proposal.action.targets).toMatchObject([{ expectedCurrentPrice }]);
  } finally { db.close(); }
});

it("rejects rogue reset metadata and malformed or already-list prices in the strict action schema", () => {
  const target = { subscriptionId: "I-A", expectedCurrentPrice: "18.00", registration: { ...PILOT_COHORT[0], createdAt: "2026-01-01T00:00:00.000Z" } };
  for (const candidate of [
    { ...target, expectedCurrentPrice: "1.8e1" }, { ...target, expectedCurrentPrice: "24" },
    { ...target, registration: { ...target.registration, label: "rogue" } },
    { ...target, registration: { ...target.registration, reason: "other" } },
  ]) expect(ResetActionSchema.safeParse({ type: "subscription_price_reset", canonicalListPrice: "24.00", targets: [candidate] }).success).toBe(false);
});

it("checks canonical price inside the persistence transaction and rejects ambiguous labels", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db); await initializeLedgerSchema(connection);
    const repo = createProposalRepository(connection);
    await repo.registerSandboxSubscriber({ subscriptionId: "I-A", ...PILOT_COHORT[0] });
    const registration = { ...PILOT_COHORT[0], createdAt: String((await connection.query("SELECT created_at FROM sandbox_subscribers"))[0].created_at) };
    const targets = [{ subscriptionId: "I-A", expectedCurrentPrice: "18.00", registration }];
    await repo.registerSandboxSubscriber({ subscriptionId: "I-B", ...PILOT_COHORT[0] });
    await expect(repo.createResetProposal("24.00", targets)).rejects.toThrow();
    await connection.execute("DELETE FROM sandbox_subscribers WHERE subscription_id='I-B'");
    const original = connection.transaction.bind(connection);
    const canonical = merchant.currentMerchant();
    vi.spyOn(connection, "transaction").mockImplementation((work) => {
      vi.spyOn(merchant, "currentMerchant").mockReturnValue({ ...canonical, twin: { ...canonical.twin, params: { ...canonical.twin.params, listPrice: 25 } } });
      return original(work);
    });
    await expect(repo.createResetProposal("24.00", targets)).rejects.toThrow(/price changed/i);
    expect(await connection.query("SELECT * FROM proposals")).toEqual([]);
  } finally { db.close(); }
});

it("stores only current registered demo pilots at an observed off-list price with a fresh reset hash", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db);
    await initializeLedgerSchema(connection);
    const repository = createProposalRepository(connection);
    await repository.registerSandboxSubscriber({ subscriptionId: "I-PILOTA", ...PILOT_COHORT[0] });
    await repository.registerSandboxSubscriber({ subscriptionId: "I-ARBITRARY", label: "unrelated", segment: "core", reason: "other" });
    const registration = (await connection.query("SELECT created_at FROM sandbox_subscribers WHERE subscription_id='I-PILOTA'"))[0];
    const proposal = await repository.createResetProposal("24.00", [{ subscriptionId: "I-PILOTA", expectedCurrentPrice: "18.00", registration: {
      ...PILOT_COHORT[0], createdAt: String(registration.created_at),
    } }]);
    expect(proposal).toMatchObject({ status: "proposed", approvedAt: null, prediction: null, action: { type: "subscription_price_reset", canonicalListPrice: "24.00", targets: [{ subscriptionId: "I-PILOTA", expectedCurrentPrice: "18.00" }] } });
    await expect(repository.createResetProposal("24.00", [{ subscriptionId: "I-ARBITRARY", expectedCurrentPrice: "18.00", registration: {
      label: "unrelated", segment: "core", reason: "other", createdAt: String(registration.created_at),
    } }])).rejects.toThrow();
    await expect(repository.approveProposal(proposal.id, proposal.actionHash, "generic merchant")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await repository.approveResetProposal(proposal.id, proposal.actionHash, "admin (demo)");
    expect((await repository.claimForExecution(proposal.id)).status).toBe("executing");
    await repository.finishExecution(proposal.id, "succeeded", null);
    expect((await repository.getProposal(proposal.id)).revertAfter).toBeNull();
  } finally { db.close(); }
});

it.each(["canonical price", "identity", "label", "segment", "reason", "createdAt", "duplicate label"])("rejects a stale reset %s at the atomic claim", async (change) => {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = createLocalConnection(db); await initializeLedgerSchema(connection);
    const repo = createProposalRepository(connection);
    await repo.registerSandboxSubscriber({ subscriptionId: "I-A", ...PILOT_COHORT[0] });
    const createdAt = String((await connection.query("SELECT created_at FROM sandbox_subscribers"))[0].created_at);
    const proposal = await repo.createResetProposal("24.00", [{ subscriptionId: "I-A", expectedCurrentPrice: "18.00", registration: { ...PILOT_COHORT[0], createdAt } }]);
    await expect(repo.approveResetProposal(proposal.id, "0".repeat(64), "admin")).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await repo.approveResetProposal(proposal.id, proposal.actionHash, "admin");
    if (change === "canonical price") {
      const canonical = merchant.currentMerchant();
      vi.spyOn(merchant, "currentMerchant").mockReturnValue({ ...canonical, twin: { ...canonical.twin, params: { ...canonical.twin.params, listPrice: 25 } } });
    } else if (change === "duplicate label") await connection.execute("INSERT INTO sandbox_subscribers SELECT 'I-B',label,segment,reason,created_at FROM sandbox_subscribers");
    else {
      const field = { identity: "subscription_id", label: "label", segment: "segment", reason: "reason", createdAt: "created_at" }[change]!;
      await connection.execute(`UPDATE sandbox_subscribers SET ${field}=?`, [change === "reason" ? "other" : change === "segment" ? "core" : change === "createdAt" ? "2030-01-01T00:00:00.000Z" : "I-CHANGED"]);
    }
    await expect(repo.claimForExecution(proposal.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repo.getProposal(proposal.id)).status).toBe("failed");
    expect(await connection.query("SELECT * FROM active_target_claims")).toEqual([]);
    expect(await connection.query("SELECT kind FROM audit_events WHERE kind='proposal.preflight_failed'")).toHaveLength(1);
  } finally { db.close(); }
});

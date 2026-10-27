import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "./connection";
import { createProposalRepository, hashAction, type PriceOverrideAction } from "./proposals";
import { recordTarget } from "@/execution/execute";

const sourceAction: PriceOverrideAction = {
  type: "subscription_price_override", segment: "core", reason: "any", listPrice: "24.00", newPrice: "18.00",
  discountPct: 25, months: 3, campaignMonths: 0, targets: ["I-ONE", "I-TWO"],
};
const sourceId = "prop_00000000-0000-4000-8000-000000000001";

async function seed(connection: LedgerConnection) {
  await initializeLedgerSchema(connection);
  const repository = createProposalRepository(connection);
  for (const id of sourceAction.targets) await repository.registerSandboxSubscriber({ subscriptionId: id, label: id, segment: "core", reason: "price" });
  await connection.execute(
    "INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status,completed_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [sourceId, new Date().toISOString(), "{}", "{}", sourceAction.type, JSON.stringify(sourceAction), hashAction(sourceAction), "succeeded", new Date().toISOString()],
  );
  for (const id of sourceAction.targets) await connection.execute(
    "INSERT INTO executions (proposal_id,target_id,operation,request_json,ok,http_status,response_json,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [sourceId, id, "PATCH subscription fixed_price", "{}", 1, 204, JSON.stringify({ subscriptionId: id, ok: true, verified: true, observed: { regularPrice: "18.00" } }), 1, new Date().toISOString()],
  );
  return repository;
}

describe("revert proposal authority", () => {
  it("derives only verified source targets with a new unapproved hash and no forecast", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      await connection.execute("UPDATE executions SET verified=0 WHERE target_id='I-TWO'");
      const revert = await repository.createRevertProposal(sourceId);
      expect(revert.status).toBe("proposed");
      expect(revert.approvedAt).toBeNull();
      expect(revert.prediction).toBeNull();
      expect(revert.action).toMatchObject({ type: "subscription_price_revert", sourceProposalId: sourceId, sourceActionHash: hashAction(sourceAction), targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] });
      expect(revert.actionHash).toBe(hashAction(revert.action));
      await expect(repository.claimForExecution(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await expect(repository.approveProposal(revert.id, hashAction({ ...revert.action, targets: [] } as typeof revert.action), "merchant")).rejects.toMatchObject({ code: "HASH_MISMATCH" });
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      expect((await repository.claimForExecution(revert.id)).status).toBe("executing");
    } finally { db.close(); }
  });

  it("ignores a verified row with an unrelated operation and never treats a recovery as a source", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      await connection.execute("UPDATE executions SET operation='unrelated' WHERE target_id='I-TWO'");
      const revert = await repository.createRevertProposal(sourceId);
      expect(revert.action.targets).toHaveLength(1);
      await expect(repository.createRevertProposal(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally { db.close(); }
  });

  it("rejects a subscription ID re-registered after the source execution", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      await connection.execute("UPDATE sandbox_subscribers SET created_at='2030-01-01T00:00:00.000Z' WHERE subscription_id='I-ONE'");
      const revert = await repository.createRevertProposal(sourceId);
      expect(revert.action.targets).toMatchObject([{ subscriptionId: "I-TWO" }]);
    } finally { db.close(); }
  });

  it("accepts cents-equivalent source read-back formatting at preview and claim, rejecting malformed replacements", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      await connection.execute("UPDATE executions SET response_json=? WHERE target_id='I-ONE'", [JSON.stringify({ observed: { regularPrice: "18.0" } })]);
      await connection.execute("UPDATE executions SET verified=0 WHERE target_id='I-TWO'");
      const accepted = await repository.createRevertProposal(sourceId);
      expect(accepted.action.targets).toMatchObject([{ subscriptionId: "I-ONE" }]);
      await repository.approveProposal(accepted.id, accepted.actionHash, "merchant");
      expect((await repository.claimForExecution(accepted.id)).status).toBe("executing");
      await repository.finishExecution(accepted.id, "failed", null);
      const later = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(later.id, later.actionHash, "merchant");
      await connection.execute("UPDATE executions SET response_json=? WHERE target_id='I-ONE'", [JSON.stringify({ observed: { regularPrice: "1.8e1" } })]);
      await expect(repository.claimForExecution(later.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await repository.getProposal(later.id)).status).toBe("failed");
    } finally { db.close(); }
  });

  it("rejects a changed registration or later verified action even at the same price", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const revert = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      await connection.execute("UPDATE sandbox_subscribers SET label='changed' WHERE subscription_id='I-ONE'");
      await expect(repository.claimForExecution(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await connection.execute("UPDATE sandbox_subscribers SET label='I-ONE' WHERE subscription_id='I-ONE'");
      const unrelated = "prop_00000000-0000-4000-8000-000000000002";
      await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)", [unrelated, new Date().toISOString(), "{}", "{}", sourceAction.type, JSON.stringify(sourceAction), hashAction(sourceAction), "succeeded"]);
      await connection.execute("INSERT INTO executions (proposal_id,target_id,operation,request_json,ok,http_status,response_json,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [unrelated, "I-ONE", "PATCH subscription fixed_price", "{}", 1, 204, JSON.stringify({ observed: { regularPrice: "18.00" } }), 1, new Date().toISOString()]);
      await expect(repository.claimForExecution(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await repository.getProposal(revert.id)).status).toBe("failed");
    } finally { db.close(); }
  });

  it("rejects revert-of-revert and an unresolved legacy overlap without claim rows", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const revert = await repository.createRevertProposal(sourceId);
      await expect(repository.createRevertProposal(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      const legacy = "prop_00000000-0000-4000-8000-000000000003";
      await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)", [legacy, new Date().toISOString(), "{}", "{}", sourceAction.type, JSON.stringify(sourceAction), hashAction(sourceAction), "executing"]);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      await expect(repository.claimForExecution(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await repository.getProposal(revert.id)).status).toBe("failed");
      expect(await connection.query("SELECT * FROM active_target_claims")).toEqual([]);
    } finally { db.close(); }
  });

  it("cleans partial reservations after a second-target conflict while preserving the other claim", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const revert = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      // Deliberate inconsistent legacy row exercises the second insert conflict path.
      await connection.execute("INSERT INTO active_target_claims VALUES (?,?,?)", ["I-TWO", sourceId, new Date().toISOString()]);
      await expect(repository.claimForExecution(revert.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await repository.getProposal(revert.id)).status).toBe("failed");
      expect(await connection.query("SELECT target_id,proposal_id FROM active_target_claims")).toEqual([{ target_id: "I-TWO", proposal_id: sourceId }]);
    } finally { db.close(); }
  });

  it("refuses registry replacement or metadata overwrite while a target has an active claim", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const revert = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      await repository.claimForExecution(revert.id);
      await expect(repository.registerSandboxSubscriber({ subscriptionId: "I-ONE", label: "changed", segment: "core", reason: "price" })).rejects.toThrow(/active/i);
      await expect(repository.replaceSandboxSubscription("I-ONE", "I-ONE", "I-REPLACED")).rejects.toThrow(/active/i);
      expect(await connection.query("SELECT label FROM sandbox_subscribers WHERE subscription_id='I-ONE'")).toEqual([{ label: "I-ONE" }]);
    } finally { db.close(); }
  });

  it("records a verified restore without opening a discount episode or changing the source", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const original = await repository.getProposal(sourceId);
      await connection.execute("UPDATE executions SET verified=0 WHERE target_id='I-TWO'");
      const revert = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      await repository.claimForExecution(revert.id);
      const snapshot = { id: "I-ONE", status: "ACTIVE", regularPrice: "24.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} };
      await recordTarget(revert.id, {}, { subscriptionId: "I-ONE", ok: true, httpStatus: 204, debugId: null, verified: true, observed: snapshot, error: null }, snapshot, connection);
      await repository.finishExecution(revert.id, "succeeded", null, { succeeded: 1, total: 1 });
      expect(await connection.query("SELECT * FROM discount_episodes")).toEqual([]);
      expect((await repository.getProposal(revert.id)).revertAfter).toBeNull();
      expect(await repository.getProposal(sourceId)).toEqual(original);
    } finally { db.close(); }
  });

  it("pages outstanding recovery and approved discount actions beyond twenty newer proposals", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const connection = createLocalConnection(db);
      const repository = await seed(connection);
      const revert = await repository.createRevertProposal(sourceId);
      await repository.approveProposal(revert.id, revert.actionHash, "merchant");
      await repository.claimForExecution(revert.id);
      const approvedId = "prop_00000000-0000-4000-8000-000000000071";
      await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)",
        [approvedId, "2020-01-01T00:00:00.000Z", "{}", "{}", sourceAction.type, JSON.stringify(sourceAction), hashAction(sourceAction), "approved"]);
      for (let index = 0; index < 25; index++) await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)",
        [`prop_${String(index + 100).padStart(8, "0")}-0000-4000-8000-000000000000`, "2030-01-01T00:00:00.000Z", "{}", "{}", sourceAction.type, JSON.stringify(sourceAction), hashAction(sourceAction), "proposed"]);
      const first = await repository.listOutstandingProposals(1);
      expect(first.proposals).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await repository.listOutstandingProposals(1, first.nextCursor!);
      expect(new Set([...first.proposals, ...second.proposals].map((proposal) => proposal.id))).toEqual(new Set([revert.id, approvedId]));
      expect(second.nextCursor).toBeNull();
    } finally { db.close(); }
  });

  for (const backend of ["SQLite", "libSQL"] as const) it(`coordinates different approved proposals across ${backend} connections`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "aurrery-revert-"));
    const path = join(dir, "ledger.sqlite");
    const native = backend === "SQLite" ? [new DatabaseSync(path), new DatabaseSync(path)] : undefined;
    const clients = backend === "libSQL" ? [createClient({ url: `file:${path}` }), createClient({ url: `file:${path}` })] : undefined;
    const first = native ? createLocalConnection(native[0]) : createLibsqlConnection(clients![0]);
    const second = native ? createLocalConnection(native[1]) : createLibsqlConnection(clients![1]);
    try {
      const repo1 = await seed(first);
      await initializeLedgerSchema(second);
      const repo2 = createProposalRepository(second);
      const a = await repo1.createRevertProposal(sourceId);
      const b = await repo2.createRevertProposal(sourceId);
      await repo1.approveProposal(a.id, a.actionHash, "merchant");
      await repo2.approveProposal(b.id, b.actionHash, "merchant");
      const results = await Promise.allSettled([repo1.claimForExecution(a.id), repo2.claimForExecution(b.id)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await first.query("SELECT COUNT(*) AS n FROM active_target_claims")).toEqual([{ n: 2 }]);
      const loser = results[0].status === "rejected" ? a : b;
      // Storage-lock failure before claim acknowledgement leaves an approved action for explicit merchant resumption.
      expect((await repo1.getProposal(loser.id)).status).toBe("approved");
      await expect(repo1.claimForExecution(loser.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await repo1.getProposal(loser.id)).status).toBe("failed");
      expect(await first.query("SELECT DISTINCT proposal_id FROM active_target_claims")).toEqual([{ proposal_id: loser.id === a.id ? b.id : a.id }]);
    } finally {
      native?.forEach((db) => db.close()); clients?.forEach((client) => client.close());
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a libSQL file. */ }
    }
  });
});

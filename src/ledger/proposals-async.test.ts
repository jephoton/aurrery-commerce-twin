import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema } from "./connection";
import { createProposalRepository } from "./proposals";

for (const backend of ["Node SQLite", "libSQL file"] as const) describe(`${backend} proposal authority`, () => {
  it("allows exactly one of two connections to claim an approved proposal and audits the winner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aurrery-claim-"));
    const path = join(dir, "ledger.sqlite");
    const native = backend === "Node SQLite" ? [new DatabaseSync(path), new DatabaseSync(path)] : undefined;
    const client = backend === "libSQL file" ? [createClient({ url: `file:${path}` }), createClient({ url: `file:${path}` })] : undefined;
    const first = native ? createLocalConnection(native[0]) : createLibsqlConnection(client![0]);
    const second = native ? createLocalConnection(native[1]) : createLibsqlConnection(client![1]);
    try {
      await initializeLedgerSchema(first);
      await initializeLedgerSchema(second);
      await first.execute("INSERT INTO proposals (id, created_at, strategy_json, simulation_json, action_type, action_json, action_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["p", "now", "{}", "{}", "subscription_price_override", "{}", "hash", "approved"]);
      const outcomes = await Promise.allSettled([createProposalRepository(first).claimForExecution("p"), createProposalRepository(second).claimForExecution("p")]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await first.query("SELECT status FROM proposals WHERE id = ?", ["p"]))[0].status).toBe("executing");
      expect(await first.query("SELECT kind FROM audit_events WHERE proposal_id = ?", ["p"])).toEqual([{ kind: "proposal.executing" }]);
    } finally {
      native?.forEach((db) => db.close()); client?.forEach((db) => db.close());
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Native libSQL may retain a Windows handle. */ }
    }
  });

  it("fails closed when foreign keys are disabled on the write transaction handle", async () => {
    const native = backend === "Node SQLite" ? new DatabaseSync(":memory:") : undefined;
    const client = backend === "libSQL file" ? createClient({ url: ":memory:" }) : undefined;
    const connection = native ? createLocalConnection(native) : createLibsqlConnection(client!);
    try {
      await initializeLedgerSchema(connection);
      await connection.executeMultiple("PRAGMA foreign_keys = OFF;");
      await expect(createProposalRepository(connection).listSandboxSubscribers()).rejects.toThrow(/foreign key/i);
      await expect(createProposalRepository(connection).registerSandboxSubscriber({ subscriptionId: "I-TEST", label: "pilot", segment: "core", reason: "other" })).rejects.toThrow(/foreign key/i);
      expect(await connection.query("SELECT * FROM sandbox_subscribers")).toEqual([]);
    } finally { native?.close(); client?.close(); }
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

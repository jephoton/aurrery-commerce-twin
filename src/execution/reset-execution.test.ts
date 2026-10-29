import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, expect, it, vi } from "vitest";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "@/ledger/connection";
import { createProposalRepository } from "@/ledger/proposals";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import * as merchant from "@/merchant";
import { executeProposalWith, recordTarget, recordObservation } from "./execute";

afterEach(() => vi.restoreAllMocks());

async function withBackend(backend: "sqlite" | "libsql", test: (a: LedgerConnection, b: LedgerConnection) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-reset-"));
  const path = join(dir, "fixture.sqlite");
  const dbs = backend === "sqlite" ? [new DatabaseSync(path), new DatabaseSync(path)] : [];
  const clients = backend === "libsql" ? [createClient({ url: `file:${path}` }), createClient({ url: `file:${path}` })] : [];
  const connections = backend === "sqlite" ? dbs.map(createLocalConnection) : clients.map(createLibsqlConnection);
  try { await initializeLedgerSchema(connections[0]); await initializeLedgerSchema(connections[1]); await test(connections[0], connections[1]); }
  finally {
    dbs.forEach((db) => db.close()); clients.forEach((client) => client.close());
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows native client lock. */ }
  }
}

async function seed(connection: LedgerConnection, count = 2) {
  const repo = createProposalRepository(connection);
  const targets = [];
  for (let i = 0; i < count; i++) {
    const subscriptionId = `I-PILOT${i}`;
    await repo.registerSandboxSubscriber({ subscriptionId, ...PILOT_COHORT[i] });
    const createdAt = String((await connection.query("SELECT created_at FROM sandbox_subscribers WHERE subscription_id=?", [subscriptionId]))[0].created_at);
    targets.push({ subscriptionId, expectedCurrentPrice: "18.0", registration: { ...PILOT_COHORT[i], createdAt } });
  }
  const proposal = await repo.createResetProposal("24.00", targets);
  await repo.approveResetProposal(proposal.id, proposal.actionHash, "fixture administrator");
  return { repo, proposal, targets };
}

const snapshot = (id: string, regularPrice = "18.00", status = "ACTIVE") => ({ id, status, regularPrice, planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: {} });
const readResult = (id: string, price = "18.00", status = "ACTIVE") => ({ ok: true as const, value: snapshot(id, price, status), debugId: null });

it("records a reset that became list-priced as a successful no-op without a PATCH, episode or schedule", async () => {
  await withBackend("sqlite", async (connection) => {
    const { repo, proposal } = await seed(connection, 1);
    const patch = vi.fn();
    const report = await executeProposalWith(proposal.id, {
      claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo),
      read: async (id) => readResult(id, "24.0"), patch,
      record: (id, request, outcome, observed) => recordTarget(id, request, outcome, observed, connection),
      recordObservation: (s, source) => recordObservation(s, source, connection),
    });
    expect(patch).not.toHaveBeenCalled(); expect(report.outcomes[0]).toMatchObject({ skipped: true, verified: false });
    expect(report.proposal).toMatchObject({ status: "succeeded", revertAfter: null });
    expect(await connection.query("SELECT * FROM discount_episodes")).toEqual([]);
    expect(await connection.query("SELECT * FROM active_target_claims")).toEqual([]);
  });
});

it.each(["sqlite", "libsql"] as const)("permits only one concurrent reset claim across two %s clients", async (backend) => {
  await withBackend(backend, async (a, b) => {
    const { repo, proposal, targets } = await seed(a, 1);
    const second = createProposalRepository(b);
    const later = await second.createResetProposal("24.00", targets);
    await second.approveResetProposal(later.id, later.actionHash, "fixture administrator");
    const results = await Promise.allSettled([repo.claimForExecution(proposal.id), second.claimForExecution(proposal.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(repo.claimForExecution(later.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repo.getProposal(proposal.id)).status).toBe("executing");
    expect(await a.query("SELECT target_id,proposal_id FROM active_target_claims")).toEqual([{ target_id: "I-PILOT0", proposal_id: proposal.id }]);
  });
});

it.each(["sqlite", "libsql"] as const)("preserves history and reports a partial reset on %s without episodes or scheduling", async (backend) => {
  await withBackend(backend, async (connection) => {
    const { repo, proposal } = await seed(connection);
    await connection.execute("INSERT INTO audit_events (at,kind,detail_json) VALUES (?,?,?)", [new Date().toISOString(), "fixture.prior_history", "{}"]);
    const patched = new Set<string>();
    const patch = vi.fn(async (id: string) => {
      if (id === "I-PILOT1") return { ok: false as const, error: { httpStatus: 422, name: "REJECTED", message: "Fixture", debugId: null, details: null } };
      patched.add(id); return { ok: true as const, value: { httpStatus: 204 }, debugId: null };
    });
    const report = await executeProposalWith(proposal.id, {
      claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo), patch,
      read: async (id) => readResult(id, patched.has(id) ? "24" : "18"),
      record: (id, request, outcome, observed) => recordTarget(id, request, outcome, observed, connection),
      recordObservation: (s, source) => recordObservation(s, source, connection),
    });
    expect(report.proposal).toMatchObject({ status: "partially_failed", prediction: null, strategy: null, revertAfter: null });
    expect(report.outcomes.map((outcome) => outcome.verified)).toEqual([true, false]);
    expect(patch.mock.calls).toEqual([["I-PILOT0", "24.00"], ["I-PILOT1", "24.00"]]);
    expect(await connection.query("SELECT * FROM discount_episodes")).toEqual([]);
    expect(await connection.query("SELECT * FROM active_target_claims")).toEqual([]);
    expect(await connection.query("SELECT kind FROM audit_events WHERE kind='fixture.prior_history'")).toHaveLength(1);
    expect(await connection.query("SELECT * FROM executions")).toHaveLength(2);
    expect(await connection.query("SELECT * FROM observations")).toHaveLength(3);
  });
});

it.each(["sqlite", "libsql"] as const)("retains unresolved reset reservations after an ambiguous PATCH on %s and refuses replay", async (backend) => {
  await withBackend(backend, async (connection) => {
    const { repo, proposal } = await seed(connection);
    const patch = vi.fn().mockRejectedValue(new Error("ambiguous transport acknowledgement"));
    const deps = { claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo), patch,
      read: async (id: string) => readResult(id),
      record: (id: string, request: unknown, outcome: Parameters<typeof recordTarget>[2], observed: Parameters<typeof recordTarget>[3]) => recordTarget(id, request, outcome, observed, connection),
    };
    await expect(executeProposalWith(proposal.id, deps)).rejects.toThrow(/reconcile/i);
    expect((await repo.getProposal(proposal.id)).status).toBe("executing");
    expect(await connection.query("SELECT * FROM active_target_claims")).toHaveLength(2);
    await expect(executeProposalWith(proposal.id, deps)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(patch).toHaveBeenCalledOnce();
  });
});

it.each(["24.01", "1.8e1", "", null])("does not overwrite a changed or unknown reset price %s", async (price) => {
  await withBackend("sqlite", async (connection) => {
    const { repo, proposal } = await seed(connection, 1);
    const patch = vi.fn();
    const report = await executeProposalWith(proposal.id, {
      claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo), patch,
      read: async (id) => ({ ...readResult(id), value: { ...snapshot(id), regularPrice: price } }), record: vi.fn(),
    });
    expect(patch).not.toHaveBeenCalled(); expect(report.proposal.status).toBe("failed");
  });
});

it.each(["canonical", "registration", "duplicate label"])("rechecks %s after the PayPal read before reset PATCH", async (change) => {
  await withBackend("sqlite", async (connection) => {
    const { repo, proposal } = await seed(connection, 1);
    const canonical = merchant.currentMerchant(); const patch = vi.fn();
    const report = await executeProposalWith(proposal.id, {
      claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo), patch,
      read: async (id) => {
        if (change === "canonical") vi.spyOn(merchant, "currentMerchant").mockReturnValue({ ...canonical, twin: { ...canonical.twin, params: { ...canonical.twin.params, listPrice: 25 } } });
        else if (change === "registration") await connection.execute("UPDATE sandbox_subscribers SET created_at='2030-01-01T00:00:00.000Z'");
        else await connection.execute("INSERT INTO sandbox_subscribers SELECT 'I-DUPLICATE',label,segment,reason,created_at FROM sandbox_subscribers");
        return readResult(id);
      }, record: vi.fn(),
    });
    expect(patch).not.toHaveBeenCalled(); expect(report.proposal.status).toBe("failed");
  });
});

it.each(["SUSPENDED", "CANCELLED", "EXPIRED", "UNKNOWN"])("never reactivates an inactive or unknown reset target (%s)", async (status) => {
  await withBackend("sqlite", async (connection) => {
    const { repo, proposal } = await seed(connection, 1); const patch = vi.fn();
    const report = await executeProposalWith(proposal.id, {
      claim: repo.claimForExecution.bind(repo), get: repo.getProposal.bind(repo), finish: repo.finishExecution.bind(repo), validateTarget: repo.validateTargetForExecution.bind(repo), patch,
      read: async (id) => readResult(id, "18.00", status), record: vi.fn(),
    });
    expect(patch).not.toHaveBeenCalled(); expect(report.proposal.status).toBe("failed");
  });
});

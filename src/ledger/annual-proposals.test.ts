import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "./annual-offer-action";
import { recordAnnualOffer } from "./annual-offers";
import { createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "./connection";
import { createProposalRepository, hashAction } from "./proposals";

const MONTHLY = "P-MONTHLY000000000000000001";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const ID = (n: number) => `prop_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FAKE_LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST";

async function setup(work: (c: LedgerConnection, repo: ReturnType<typeof createProposalRepository>) => Promise<void>) {
  const db = new DatabaseSync(":memory:");
  try {
    const c = createLocalConnection(db);
    await initializeLedgerSchema(c);
    const repo = createProposalRepository(c);
    await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other" });
    await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other" });
    await c.execute("INSERT INTO kv (key,value) VALUES ('paypal.plan_id',?)", [MONTHLY]);
    await work(c, repo);
  } finally { db.close(); }
}
async function insertAnnual(c: LedgerConnection, id: string, status: "approved" | "succeeded") {
  const rows = await c.query("SELECT subscription_id,label,segment,reason,created_at FROM sandbox_subscribers ORDER BY rowid");
  const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7,
    eligible: rows.map((r) => ({ subscriptionId: String(r.subscription_id), label: String(r.label), segment: String(r.segment), reason: String(r.reason), createdAt: String(r.created_at) })) });
  await c.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, new Date().toISOString(), JSON.stringify(strategy), "{}", action.type, JSON.stringify(action), hashAction(action), status, new Date().toISOString(), "fixture"]);
  return action;
}
async function recordOpenOffer(c: LedgerConnection, proposalId: string, subscriptionId: string) {
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await recordAnnualOffer({ proposalId, subscriptionId, segment: "core", annualPlanId: "P-ANNUAL0000000000000000001",
    approvalUrl: FAKE_LINK, offeredAt: new Date().toISOString(), expiresAt, request: {}, outcome: { subscriptionId, ok: true, httpStatus: 200, debugId: null,
      verified: false, observed: null, error: null, offer: { annualPlanId: "P-ANNUAL0000000000000000001", expiresAt } } }, c);
}
const preflight = async (c: LedgerConnection) => (await c.query("SELECT detail_json FROM audit_events WHERE kind='proposal.preflight_failed'")).map((r) => JSON.parse(String(r.detail_json)).reason);

describe("annual offer proposals", () => {
  it("claims an approved annual offer through the unchanged state machine and lists it as outstanding", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    const claimed = await repo.claimForExecution(ID(1));
    expect(claimed.status).toBe("executing");
    expect(await c.query("SELECT target_id FROM active_target_claims ORDER BY target_id")).toEqual([{ target_id: "I-PILOTD" }, { target_id: "I-PILOTE" }]);
    expect((await repo.listOutstandingProposals()).proposals.map((p) => p.id)).toEqual([ID(1)]);
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTD")).toBe(true);
    await c.execute("UPDATE kv SET value='P-CHANGED00000000000000001' WHERE key='paypal.plan_id'");
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTD")).toBe(false);
    await expect(repo.finishExecution(ID(1), "succeeded", "2027-01-01T00:00:00.000Z")).rejects.toThrow(/cannot schedule a revert/);
    await repo.finishExecution(ID(1), "succeeded", null, { succeeded: 2, total: 2 });
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));

  it("refuses a target per call once it has an open offer, a changed registration or no claim", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    const claimed = await repo.claimForExecution(ID(1));
    expect(await repo.validateTargetForExecution(claimed, "I-UNKNOWN")).toBe(false);
    await recordOpenOffer(c, ID(1), "I-PILOTD");
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTD")).toBe(false);
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTE")).toBe(true);
    await c.execute("UPDATE sandbox_subscribers SET label='Pilot E2' WHERE subscription_id='I-PILOTE'");
    expect(await repo.validateTargetForExecution(claimed, "I-PILOTE")).toBe(false);
  }));

  it("never puts an approval link into the proposal, its audit trail or the outstanding list", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    await repo.claimForExecution(ID(1));
    await recordOpenOffer(c, ID(1), "I-PILOTD");
    const outstanding = JSON.stringify(await repo.listOutstandingProposals());
    const proposal = JSON.stringify(await repo.getProposal(ID(1)));
    const audit = JSON.stringify(await c.query("SELECT detail_json FROM audit_events"));
    for (const text of [outstanding, proposal, audit]) { expect(text).not.toContain("ba_token"); expect(text).not.toContain(FAKE_LINK); }
  }));

  it("refuses to claim a target already held by another unresolved claim", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    await c.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)",
      [ID(2), new Date().toISOString(), "null", "null", "subscription_price_override", JSON.stringify({ type: "subscription_price_override", targets: ["I-PILOTE"] }), "c".repeat(64), "executing"]);
    await expect(repo.claimForExecution(ID(1))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await preflight(c)).toEqual(["unresolved_target"]);
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));

  it("refuses a tampered annual payload by its hash", () => setup(async (c, repo) => {
    const action = await insertAnnual(c, ID(1), "approved");
    await c.execute("UPDATE proposals SET action_json=? WHERE id=?", [JSON.stringify({ ...action, discountPct: 20, annualPrice: "230.40" }), ID(1)]);
    await expect(repo.claimForExecution(ID(1))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await preflight(c)).toEqual(["invalid_annual_action"]);
  }));

  it.each([
    ["monthly_plan_changed", async (c: LedgerConnection) => { await c.execute("UPDATE kv SET value='P-CHANGED00000000000000001' WHERE key='paypal.plan_id'"); }],
    ["registration_changed", async (c: LedgerConnection) => { await c.execute("UPDATE sandbox_subscribers SET created_at='2020-01-01T00:00:00.000Z' WHERE subscription_id='I-PILOTE'"); }],
    ["open_annual_offer", async (c: LedgerConnection) => {
      await insertAnnual(c, ID(9), "succeeded");
      await recordOpenOffer(c, ID(9), "I-PILOTE");
    }],
  ])("fails preflight with %s before any PayPal call", (reason, change) => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    await change(c);
    await expect(repo.claimForExecution(ID(1))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repo.getProposal(ID(1))).status).toBe("failed");
    expect(await preflight(c)).toEqual([reason]);
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));
});

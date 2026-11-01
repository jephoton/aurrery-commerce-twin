import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { currentMerchant } from "@/merchant";
import { compareStrategies } from "@/twin/simulate";
import { buildAnnualOfferAction, type AnnualOfferAction } from "./annual-offer-action";
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

  it("refuses the claim with a clear error and keeps the proposal approved when stored offers are unreadable", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(1), "approved");
    await insertAnnual(c, ID(9), "succeeded");
    await recordOpenOffer(c, ID(9), "I-PILOTE");
    await c.execute("PRAGMA ignore_check_constraints = ON");
    await c.execute("UPDATE annual_offers SET segment='bogus'");
    await expect(repo.claimForExecution(ID(1))).rejects.toMatchObject({ name: "Error", code: "INVALID_STATE", message: expect.stringMatching(/unreadable_annual_offers/) });
    expect((await repo.getProposal(ID(1))).status).toBe("approved");
    expect(await c.query("SELECT * FROM active_target_claims")).toEqual([]);
  }));
});

describe("annual offer proposal creation", () => {
  const result = compareStrategies(currentMerchant().twin, [strategy], { runs: 2, horizonMonths: 1 }).strategies[1];
  const input = { objective: "Annual", strategy, result, listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: MONTHLY, offerWindowDays: 7, eligibleIds: ["I-PILOTD", "I-PILOTE"] };

  it("snapshots live-eligible registered pilots into an exact hashed payload with its forecast", () => setup(async (c, repo) => {
    const proposal = await repo.createAnnualOfferProposal(input);
    const action = proposal.action as AnnualOfferAction;
    expect(proposal).toMatchObject({ status: "proposed", objective: "Annual", strategy: { id: strategy.id } });
    expect(action).toMatchObject({ type: "annual_plan_offer", annualPrice: "244.80", listPrice: "24.00", offerWindowDays: 7, monthlyPlanId: MONTHLY });
    expect(action.targets.map((t) => t.subscriptionId)).toEqual(["I-PILOTD", "I-PILOTE"]);
    const registered = (await c.query("SELECT created_at FROM sandbox_subscribers WHERE subscription_id='I-PILOTD'"))[0];
    expect(action.targets[0].registration).toEqual({ label: "Pilot D", segment: "core", reason: "other", createdAt: registered.created_at });
    expect(proposal.actionHash).toBe(hashAction(action));
    expect(proposal.prediction).not.toBeNull();
    expect((await repo.createAnnualOfferProposal({ ...input, offerWindowDays: 30 })).actionHash).not.toBe(proposal.actionHash);
  }));

  it("ignores IDs that are not registered pilots in the offered segments", () => setup(async (_c, repo) => {
    await repo.registerSandboxSubscriber({ subscriptionId: "I-PILOTA", label: "Pilot A", segment: "cancel_intent", reason: "price" });
    const proposal = await repo.createAnnualOfferProposal({ ...input, eligibleIds: ["I-PILOTA", "I-UNKNOWN", "I-PILOTE"] });
    expect((proposal.action as AnnualOfferAction).targets.map((t) => t.subscriptionId)).toEqual(["I-PILOTE"]);
    await expect(repo.createAnnualOfferProposal({ ...input, eligibleIds: [] })).rejects.toMatchObject({ code: "NO_TARGETS" });
  }));

  it("drops pilots with an open offer or a claim, and refuses when none remain", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(9), "succeeded");
    await recordOpenOffer(c, ID(9), "I-PILOTE");
    expect(((await repo.createAnnualOfferProposal(input)).action as AnnualOfferAction).targets.map((t) => t.subscriptionId)).toEqual(["I-PILOTD"]);
    await c.execute("INSERT INTO active_target_claims (target_id,proposal_id,claimed_at) VALUES ('I-PILOTD',?,?)", [ID(9), new Date().toISOString()]);
    await expect(repo.createAnnualOfferProposal(input)).rejects.toMatchObject({ code: "NO_TARGETS" });
  }));

  it("refuses a changed monthly plan, an invalid window, an unpayable price or a non-annual strategy", () => setup(async (_c, repo) => {
    await expect(repo.createAnnualOfferProposal({ ...input, monthlyPlanId: "P-OTHER0000000000000000001" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    for (const offerWindowDays of [0, 31, 1.5, Number.NaN])
      await expect(repo.createAnnualOfferProposal({ ...input, offerWindowDays })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(repo.createAnnualOfferProposal({ ...input, listPrice: 500 })).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    await expect(repo.createAnnualOfferProposal({ ...input, strategy: STARTER_STRATEGIES[0] })).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(await repo.listProposals()).toEqual([]);
  }));

  it("refuses cleanly when stored offers are unreadable", () => setup(async (c, repo) => {
    await insertAnnual(c, ID(9), "succeeded");
    await recordOpenOffer(c, ID(9), "I-PILOTE");
    await c.execute("PRAGMA ignore_check_constraints = ON");
    await c.execute("UPDATE annual_offers SET segment='bogus'");
    await expect(repo.createAnnualOfferProposal(input)).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringMatching(/unreadable_annual_offers/) });
  }));
});

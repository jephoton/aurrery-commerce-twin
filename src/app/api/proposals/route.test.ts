import { describe, expect, it, vi } from "vitest";
import { ledger } from "@/ledger/db";
import { getProposal, hashAction, listProposals, type Proposal } from "@/ledger/proposals";
import type { AnnualOfferAction } from "@/ledger/annual-offer-action";
import * as execution from "@/execution/execute";
import { observedMerchant } from "@/merchant/observed";
import * as plans from "@/paypal/plans";
import * as subscriptions from "@/paypal/subscriptions";
import type { Strategy } from "@/twin/interventions";
import { compareStrategies } from "@/twin/simulate";
import * as workerClient from "@/twin/worker-client";
import { POST as approve } from "./[id]/approve/route";
import { POST } from "./route";

const strategy: Strategy = { id: "save", name: "Save", intervention: { kind: "targeted_discount", segment: "cancel_intent", reason: "price", discountPct: 25, months: 3, campaignMonths: 0 } };
describe("proposal worker boundary", () => {
  it("does not persist a cancelled request", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController(); controller.abort();
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
    const response = await POST(request);
    expect(response.status).toBe(408);
    expect(await listProposals()).toHaveLength(0);
  });
  it("does not persist when cancellation arrives during recomputation", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController();
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
    const pending = POST(request);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await listProposals()).toHaveLength(0);
  });
  it("checks cancellation again after a worker result and before proposal persistence", async () => {
    ledger().exec("DELETE FROM proposals;");
    const controller = new AbortController();
    const spy = vi.spyOn(workerClient, "runComparison").mockImplementation(async (twin, strategies) => {
      const result = compareStrategies(twin, strategies, { runs: 10, horizonMonths: 1, seed: 42 });
      controller.abort();
      return result;
    });
    try {
      const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }), signal: controller.signal });
      expect((await POST(request)).status).toBe(408);
      expect(await listProposals()).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it("recomputes the prediction with the server simulation budget", async () => {
    vi.stubEnv("SIMULATION_RUNS", "150");
    const spy = vi.spyOn(workerClient, "runComparison").mockImplementation(async (twin, strategies) => compareStrategies(twin, strategies, { runs: 10, horizonMonths: 1, seed: 42 }));
    try {
      await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Save", strategy }) }));
      expect(spy).toHaveBeenCalledWith(expect.anything(), [strategy], { runs: 150 }, expect.anything());
    } finally { spy.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("validates the annual offer window before any simulation or persistence", async () => {
    ledger().exec("DELETE FROM proposals;");
    const compare = vi.spyOn(workerClient, "runComparison");
    try {
      const annual = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core"] } };
      const bodies = [...[0, 31, 1.5, "7", null].map((offerWindowDays) => ({ strategy: annual, offerWindowDays })), { strategy, offerWindowDays: 7 }];
      for (const body of bodies) {
        const response = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify(body) }));
        expect(response.status).toBe(400);
      }
      expect(compare).not.toHaveBeenCalled();
      expect(await listProposals()).toHaveLength(0);
    } finally { compare.mockRestore(); }
  });
  it("prepares an annual offer from live eligibility, binds its window into the hash and approves it through the hash-bound route", async () => {
    vi.stubEnv("HOSTED_DEMO", "false"); vi.stubEnv("RENDER", "false");
    vi.stubEnv("PAYPAL_CLIENT_ID", "offline-test-id"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "offline-test-secret");
    const db = ledger();
    db.exec("DELETE FROM proposals; DELETE FROM sandbox_subscribers;");
    db.exec("INSERT OR REPLACE INTO kv (key,value) VALUES ('paypal.plan_id','P-MONTHLY000000000000000001'),('paypal.product_id','PROD-RIDGELINE0000000001');");
    const register = db.prepare("INSERT INTO sandbox_subscribers (subscription_id,label,segment,reason,created_at) VALUES (?,?,?,?,?)");
    register.run("I-PILOTA", "Pilot A", "cancel_intent", "price", "2026-10-22T00:00:00.000Z");
    register.run("I-PILOTD", "Pilot D", "core", "other", "2026-10-22T00:00:01.000Z");
    register.run("I-PILOTE", "Pilot E", "core", "other", "2026-10-22T00:00:02.000Z");
    const listPrice = (await observedMerchant()).twin.params.listPrice;
    const compare = vi.spyOn(workerClient, "runComparison").mockImplementation(async (twin, strategies) => compareStrategies(twin, strategies, { runs: 2, horizonMonths: 1, seed: 42 }));
    const plan = vi.spyOn(plans, "getPlan").mockResolvedValue({ ok: true, debugId: null, value: { planId: "P-MONTHLY000000000000000001", productId: "PROD-RIDGELINE0000000001" } as plans.PlanSnapshot });
    const read = vi.spyOn(subscriptions, "getSubscription").mockImplementation(async (id) => ({ ok: true, debugId: null, value: {
      id, status: "ACTIVE", planId: "P-MONTHLY000000000000000001", planOverridden: id === "I-PILOTE", regularPrice: id === "I-PILOTE" ? (listPrice * 0.75).toFixed(2) : listPrice.toFixed(1),
      nextBillingTime: null, lastPayment: null, raw: {} } }));
    const execute = vi.spyOn(execution, "executeProposal").mockImplementation(async (id) => ({ proposal: await getProposal(id), outcomes: [] }));
    try {
      const annual = { id: "annual-15", name: "Annual", intervention: { kind: "annual_plan", discountPct: 15, segments: ["core"] } };
      const response = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "Annual", strategy: annual, offerWindowDays: 14 }) }));
      expect(response.status).toBe(201);
      const { proposal } = await response.json() as { proposal: Proposal };
      const action = proposal.action as AnnualOfferAction;
      expect(read.mock.calls.map(([id]) => id)).toEqual(["I-PILOTD", "I-PILOTE"]);
      expect(plan).toHaveBeenCalledWith("P-MONTHLY000000000000000001");
      expect(action).toMatchObject({ type: "annual_plan_offer", offerWindowDays: 14, monthlyPlanId: "P-MONTHLY000000000000000001", listPrice: listPrice.toFixed(2) });
      expect(action.targets.map((target) => target.subscriptionId)).toEqual(["I-PILOTD"]);
      expect(proposal.actionHash).toBe(hashAction(action));
      expect(hashAction({ ...action, offerWindowDays: 7 })).not.toBe(proposal.actionHash);

      const approveWith = (actionHash: string) => approve(new Request(`http://localhost/api/proposals/${proposal.id}/approve`, { method: "POST", body: JSON.stringify({ actionHash, approvedBy: "merchant" }) }),
        { params: Promise.resolve({ id: proposal.id }) });
      expect((await approveWith(hashAction({ ...action, offerWindowDays: 7 }))).status).toBe(409);
      expect(execute).not.toHaveBeenCalled();
      expect((await approveWith(proposal.actionHash)).status).toBe(200);
      expect(execute).toHaveBeenCalledWith(proposal.id);
      expect(await getProposal(proposal.id)).toMatchObject({ status: "approved", approvedBy: "merchant", actionHash: proposal.actionHash });

      // Defaults to a seven-day window; refuses cleanly when nobody is eligible.
      const fallback = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ strategy: annual }) }));
      expect(fallback.status).toBe(201);
      expect(((await fallback.json()).proposal.action as AnnualOfferAction).offerWindowDays).toBe(7);
      read.mockImplementation(async (id) => ({ ok: true, debugId: null, value: { id, status: "CANCELLED", planId: "P-MONTHLY000000000000000001", planOverridden: false,
        regularPrice: listPrice.toFixed(2), nextBillingTime: null, lastPayment: null, raw: {} } }));
      const none = await POST(new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ strategy: annual }) }));
      expect(none.status).toBe(422);
      expect(await none.json()).toMatchObject({ error: "NO_TARGETS" });
    } finally {
      for (const spy of [compare, plan, read, execute]) spy.mockRestore();
      vi.unstubAllEnvs();
      db.exec("DELETE FROM proposals; DELETE FROM sandbox_subscribers; DELETE FROM kv WHERE key IN ('paypal.plan_id','paypal.product_id');");
    }
  });
  it("rejects an oversized body", async () => {
    const request = new Request("http://localhost/api/proposals", { method: "POST", body: JSON.stringify({ objective: "x".repeat(70_000), strategy }) });
    expect((await POST(request)).status).toBe(413);
  });
});

import { describe, expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";
import type { PayPalFailure } from "@/paypal/client";
import type { PlanSnapshot } from "@/paypal/plans";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";
import { annualPlanRequestId, executeAnnualOfferWith, type AnnualDependencies } from "./annual-offer";

const MONTHLY = "P-MONTHLY000000000000000001";
const ANNUAL = "P-ANNUAL0000000000000000001";
const PRODUCT = "PROD-RIDGELINE0000000001";
const LINK = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST";
const CREATED = "2026-10-22T00:00:00.000Z";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const action = buildAnnualOfferAction({ strategy, listPrice: 24, productId: PRODUCT, monthlyPlanId: MONTHLY, offerWindowDays: 7, eligible: [
  { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other", createdAt: CREATED },
  { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: CREATED },
] });
const proposal = { id: "prop_annual", actionHash: "a".repeat(64), action };
const monthlyPlan: PlanSnapshot = { planId: MONTHLY, status: "ACTIVE", name: "Monthly", productId: PRODUCT, price: "24.0", currency: "USD", intervalUnit: "MONTH", intervalCount: 1, totalCycles: 0, regularCycleCount: 1, cycleCount: 1 };
const annualPlan: PlanSnapshot = { ...monthlyPlan, planId: ANNUAL, name: "Annual", price: "244.8", intervalUnit: "YEAR" };
const subscription = (id: string, change: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot =>
  ({ id, status: "ACTIVE", planId: MONTHLY, planOverridden: false, regularPrice: "24.0", nextBillingTime: "2026-11-30T10:00:00Z", lastPayment: null, raw: {}, ...change });
function ok<T>(value: T) { return { ok: true as const, value, debugId: "dbg" as string | null }; }
const fail = (httpStatus: number | null, name = "UNPROCESSABLE_ENTITY", message = "PayPal refused") =>
  ({ ok: false as const, error: { httpStatus, name, message, debugId: "dbg-fail", details: null } satisfies PayPalFailure });

// Generic so each override keeps its own mock type (a plain Partial spread would widen to a union).
function deps<C extends Partial<AnnualDependencies> = Record<never, never>>(change: C = {} as C) {
  const base = {
    monthlyPlanSetting: vi.fn<AnnualDependencies["monthlyPlanSetting"]>(async () => MONTHLY),
    getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : annualPlan)),
    createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => ok(annualPlan)),
    read: vi.fn<AnnualDependencies["read"]>(async (id) => ok(subscription(id))),
    revise: vi.fn<AnnualDependencies["revise"]>(async ({ subscriptionId }) => ok({ approvalUrl: `${LINK}${subscriptionId.slice(2)}`, planId: ANNUAL, httpStatus: 200 })),
    validateTarget: vi.fn<AnnualDependencies["validateTarget"]>(async () => true),
    recordObservation: vi.fn<AnnualDependencies["recordObservation"]>(async () => {}),
    recordPlan: vi.fn<AnnualDependencies["recordPlan"]>(async () => {}),
    recordOffer: vi.fn<AnnualDependencies["recordOffer"]>(async () => 1),
    recordTarget: vi.fn<AnnualDependencies["recordTarget"]>(async () => {}),
    finish: vi.fn<AnnualDependencies["finish"]>(async () => {}),
    get: vi.fn<AnnualDependencies["get"]>(async () => ({ id: proposal.id }) as Proposal),
    now: () => new Date("2026-11-01T00:00:00.000Z"),
    returnUrl: "https://aurrery.example/?paypal=annual",
  };
  return { ...base, ...change };
}
const EXPIRES = "2026-11-08T00:00:00.000Z";

describe("annual offer execution", () => {
  it("creates the plan under a hash-derived request ID, verifies it by cents and issues one offer per target", async () => {
    const d = deps();
    const report = await executeAnnualOfferWith(proposal, d);
    expect(annualPlanRequestId(proposal.actionHash)).toBe(`aurrery-annual-${"a".repeat(64)}`);
    expect(d.createPlan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ productId: PRODUCT, annualPrice: "244.80", currency: "USD", requestId: annualPlanRequestId(proposal.actionHash) }));
    expect(d.recordPlan).toHaveBeenCalledWith(annualPlan, "dbg");
    expect(d.revise.mock.calls.map(([input]) => input)).toEqual([
      { subscriptionId: "I-PILOTD", planId: ANNUAL, returnUrl: "https://aurrery.example/?paypal=annual" },
      { subscriptionId: "I-PILOTE", planId: ANNUAL, returnUrl: "https://aurrery.example/?paypal=annual" },
    ]);
    expect(d.recordOffer).toHaveBeenCalledWith(expect.objectContaining({ proposalId: proposal.id, subscriptionId: "I-PILOTE", segment: "core", annualPlanId: ANNUAL,
      approvalUrl: `${LINK}PILOTE`, offeredAt: "2026-11-01T00:00:00.000Z", expiresAt: EXPIRES }));
    const issued = d.recordOffer.mock.calls.map(([offer]) => offer);
    expect(issued.map((offer) => offer.outcome)).toEqual([
      expect.objectContaining({ subscriptionId: "I-PILOTD", ok: true, verified: false, httpStatus: 200, offer: { annualPlanId: ANNUAL, expiresAt: EXPIRES } }),
      expect.objectContaining({ subscriptionId: "I-PILOTE", ok: true, verified: false, httpStatus: 200, offer: { annualPlanId: ANNUAL, expiresAt: EXPIRES } }),
    ]);
    expect(JSON.stringify(issued.map((offer) => [offer.request, offer.outcome]))).not.toContain("ba_token");
    expect(d.recordTarget).not.toHaveBeenCalled();
    expect(d.recordObservation).toHaveBeenCalledWith(expect.objectContaining({ id: "I-PILOTD" }), "paypal.execution_preread");
    expect(d.finish).toHaveBeenCalledWith("succeeded", { succeeded: 2, total: 2 });
    expect(report.outcomes.map((o) => o.offer)).toEqual([{ annualPlanId: ANNUAL, expiresAt: EXPIRES }, { annualPlanId: ANNUAL, expiresAt: EXPIRES }]);
    expect(JSON.stringify([report, d.recordTarget.mock.calls])).not.toContain("ba_token");
  });

  it("uses the same plan request ID every time the same approved action executes", async () => {
    const first = deps(); const second = deps();
    await executeAnnualOfferWith(proposal, first); await executeAnnualOfferWith(proposal, second);
    expect(second.createPlan.mock.calls[0][0].requestId).toBe(first.createPlan.mock.calls[0][0].requestId);
  });

  it("re-checks live eligibility just before revise and skips without calling PayPal", async () => {
    const d = deps({ read: vi.fn<AnnualDependencies["read"]>(async (id) => ok(subscription(id, id === "I-PILOTD" ? { regularPrice: "18.00", planOverridden: true } : { planId: ANNUAL, regularPrice: "244.8" }))) });
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.revise).not.toHaveBeenCalled();
    expect(report.outcomes.map((o) => o.error)).toEqual([expect.stringMatching(/list price/), expect.stringMatching(/monthly plan/)]);
    expect(d.finish).toHaveBeenCalledWith("failed", { succeeded: 0, total: 2 });
  });

  it("does not read or revise when the local authority check fails before the PayPal read", async () => {
    const d = deps({ validateTarget: vi.fn<AnnualDependencies["validateTarget"]>().mockResolvedValueOnce(false).mockResolvedValue(true) });
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.read.mock.calls.map(([id]) => id)).toEqual(["I-PILOTE"]);
    expect(d.revise.mock.calls.map(([input]) => input.subscriptionId)).toEqual(["I-PILOTE"]);
    expect(report.outcomes[0]).toMatchObject({ subscriptionId: "I-PILOTD", ok: false, error: expect.stringMatching(/before the PayPal read; no offer was made/) });
    expect(d.finish).toHaveBeenCalledWith("partially_failed", { succeeded: 1, total: 2 });
  });

  it("does not call revise when the local authority check fails after the PayPal read", async () => {
    const d = deps({ validateTarget: vi.fn<AnnualDependencies["validateTarget"]>().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true) });
    await executeAnnualOfferWith(proposal, d);
    expect(d.revise.mock.calls.map(([input]) => input.subscriptionId)).toEqual(["I-PILOTE"]);
    expect(d.finish).toHaveBeenCalledWith("partially_failed", { succeeded: 1, total: 2 });
  });

  it("continues after a definitive 4xx and reports a partial failure", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(fail(422));
    await executeAnnualOfferWith(proposal, d);
    expect(d.revise).toHaveBeenCalledTimes(2);
    expect(d.recordTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subscriptionId: "I-PILOTD", ok: false, httpStatus: 422 }));
    expect(d.finish).toHaveBeenCalledWith("partially_failed", { succeeded: 1, total: 2 });
  });

  it("never copies a PayPal error message that carries a link into the outcome", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(fail(422, "UNPROCESSABLE_ENTITY", `See ${LINK}LEAK`));
    const report = await executeAnnualOfferWith(proposal, d);
    expect(report.outcomes[0]).toMatchObject({ subscriptionId: "I-PILOTD", ok: false, error: expect.stringMatching(/^UNPROCESSABLE_ENTITY/) });
    expect(JSON.stringify([report, d.recordTarget.mock.calls])).not.toMatch(/ba_token|https:/);
  });

  it.each([
    ["an encoded token parameter", "Bad request to ?ba%5Ftoken=X"],
    ["a scheme-less approval path", "Open www.sandbox.paypal.com/webapps/billing/subscriptions/update"],
    ["a bare token", "Token ba-fixture1234 was rejected"],
  ])("withholds a PayPal error message carrying %s", async (_name, message) => {
    const d = deps(); d.revise.mockResolvedValueOnce(fail(422, "UNPROCESSABLE_ENTITY", message));
    const report = await executeAnnualOfferWith(proposal, d);
    expect(report.outcomes[0].error).toMatch(/^UNPROCESSABLE_ENTITY \(PayPal's message was withheld/);
    expect(JSON.stringify(d.recordTarget.mock.calls)).not.toContain(message);
  });

  it.each([
    ["a server error", fail(500, "INTERNAL_SERVER_ERROR")],
    ["a network failure", fail(null, "NETWORK_OR_CLIENT_ERROR")],
    ["a 200 without an approval link", fail(200, "MISSING_APPROVAL_LINK")],
    ["an unreadable 200", fail(200, "RESPONSE_VALIDATION_ERROR")],
    ["a 409 conflict", fail(409, "CONFLICT")],
  ])("leaves the proposal executing after %s, never retries and never touches later targets", async (_name, result) => {
    const d = deps(); d.revise.mockResolvedValueOnce(result);
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.read).toHaveBeenCalledOnce();
    expect(d.recordTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subscriptionId: "I-PILOTD", error: expect.stringMatching(/do not retry/i) }));
    expect(d.recordOffer).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when revise throws", async () => {
    const d = deps(); d.revise.mockRejectedValueOnce(new Error("socket"));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("stores no link when PayPal reports a different plan for the switch", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(ok({ approvalUrl: `${LINK}X`, planId: "P-OTHER0000000000000000001", httpStatus: 200 }));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.recordOffer).not.toHaveBeenCalled();
    expect(d.revise).toHaveBeenCalledOnce();
    expect(JSON.stringify(d.recordTarget.mock.calls)).not.toContain("ba_token");
  });

  it("records an unstored offer without its link, then leaves the proposal executing", async () => {
    const d = deps({ recordOffer: vi.fn<AnnualDependencies["recordOffer"]>(async () => { throw new Error("storage"); }) });
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.recordTarget).toHaveBeenCalledOnce();
    expect(d.recordTarget).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "I-PILOTD" }), expect.objectContaining({
      subscriptionId: "I-PILOTD", ok: false, httpStatus: 200, debugId: "dbg", observed: expect.objectContaining({ status: "ACTIVE" }),
      error: expect.stringMatching(/^Offer issued but not stored; the link was not kept\..*do not retry/i),
    }));
    expect(d.recordTarget.mock.calls[0][1].offer).toBeUndefined();
    expect(JSON.stringify(d.recordTarget.mock.calls)).not.toMatch(/ba_token|BA-TEST/);
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("still leaves the proposal executing when the unstored offer cannot be recorded either", async () => {
    const d = deps({
      recordOffer: vi.fn<AnnualDependencies["recordOffer"]>(async () => { throw new Error("storage"); }),
      recordTarget: vi.fn<AnnualDependencies["recordTarget"]>(async () => { throw new Error("storage"); }),
    });
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.recordTarget).toHaveBeenCalledOnce();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("issues the offer when PayPal returns no plan ID for the switch", async () => {
    const d = deps(); d.revise.mockResolvedValueOnce(ok({ approvalUrl: `${LINK}PILOTD`, planId: null, httpStatus: 200 }));
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.recordOffer).toHaveBeenCalledTimes(2);
    expect(report.outcomes[0]).toMatchObject({ subscriptionId: "I-PILOTD", ok: true, offer: { annualPlanId: ANNUAL, expiresAt: EXPIRES } });
    expect(d.finish).toHaveBeenCalledWith("succeeded", { succeeded: 2, total: 2 });
  });

  it.each([
    ["the monthly-plan setting cannot be read", { monthlyPlanSetting: vi.fn<AnnualDependencies["monthlyPlanSetting"]>(async () => { throw new Error("storage"); }) }],
    ["plan creation throws", { createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => { throw new Error("socket"); }) }],
  ])("leaves the proposal executing without any revise when %s", async (_name, change) => {
    const d = deps(change);
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).not.toHaveBeenCalled();
    expect(d.recordTarget).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when it cannot be finished", async () => {
    const d = deps({ finish: vi.fn<AnnualDependencies["finish"]>(async () => { throw new Error("storage"); }) });
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired", proposalId: proposal.id });
    expect(d.revise).toHaveBeenCalledTimes(2);
    expect(d.get).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when a refused target cannot be recorded", async () => {
    const d = deps({ recordTarget: vi.fn<AnnualDependencies["recordTarget"]>(async () => { throw new Error("storage"); }) });
    d.revise.mockResolvedValueOnce(fail(422));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).toHaveBeenCalledOnce();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when a subscription cannot be read", async () => {
    const d = deps(); d.read.mockResolvedValueOnce(fail(503, "SERVICE_UNAVAILABLE"));
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("leaves the proposal executing when the verified plan cannot be recorded", async () => {
    const d = deps({ recordPlan: vi.fn<AnnualDependencies["recordPlan"]>(async () => { throw new Error("storage"); }) });
    await expect(executeAnnualOfferWith(proposal, d)).rejects.toMatchObject({ name: "ExecutionReconciliationRequired" });
    expect(d.revise).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it.each([
    ["the registered monthly plan changed", { monthlyPlanSetting: vi.fn<AnnualDependencies["monthlyPlanSetting"]>(async () => "P-NEWMONTHLY00000000000001") }],
    ["the monthly plan belongs to another product", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? { ...monthlyPlan, productId: "PROD-OTHER000000000000001" } : annualPlan)) }],
    ["plan creation was refused", { createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => fail(422)) }],
    ["plan creation failed with a server error", { createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => fail(500, "INTERNAL_SERVER_ERROR")) }],
    ["plan creation failed on the network", { createPlan: vi.fn<AnnualDependencies["createPlan"]>(async () => fail(null, "NETWORK_OR_CLIENT_ERROR")) }],
    ["the plan cannot be read back", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => id === MONTHLY ? ok(monthlyPlan) : fail(500, "INTERNAL_SERVER_ERROR")) }],
    ["the plan reads back with another id", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, planId: "P-OTHER0000000000000000001" })) }],
    ["the plan reads back at another price", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, price: "244.81" })) }],
    ["the plan reads back monthly", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, intervalUnit: "MONTH" })) }],
    ["the plan reads back inactive", { getPlan: vi.fn<AnnualDependencies["getPlan"]>(async (id) => ok(id === MONTHLY ? monthlyPlan : { ...annualPlan, status: "INACTIVE" })) }],
  ])("fails the proposal before any revise when %s", async (_name, change) => {
    const d = deps(change);
    const report = await executeAnnualOfferWith(proposal, d);
    expect(d.revise).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
    expect(d.recordOffer).not.toHaveBeenCalled();
    expect(d.recordTarget).toHaveBeenCalledTimes(2);
    expect(report.outcomes.every((o) => !o.ok && /no offer was made\.$/.test(o.error ?? ""))).toBe(true);
    expect(d.finish).toHaveBeenCalledWith("failed", { succeeded: 0, total: 2 });
  });
});

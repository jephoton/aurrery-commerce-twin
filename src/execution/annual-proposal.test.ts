import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import * as proposals from "@/ledger/proposals";
import type { Proposal } from "@/ledger/proposals";
import type { PlanSnapshot } from "@/paypal/plans";
import type { SubscriptionSnapshot } from "@/paypal/subscriptions";
import type { StrategyResult } from "@/twin/simulate";
import { DEFAULT_OFFER_WINDOW_DAYS, prepareAnnualOfferProposalWith, proposeStrategy, type AnnualPreparationDependencies } from "./annual-proposal";

const MONTHLY = "P-MONTHLY000000000000000001";
const PRODUCT = "PROD-RIDGELINE0000000001";
const strategy = STARTER_STRATEGIES.find((s) => s.intervention.kind === "annual_plan")!;
const input = { objective: "Annual", strategy, result: {} as StrategyResult, listPrice: 24, offerWindowDays: 7 };
const plan = { planId: MONTHLY, productId: PRODUCT } as PlanSnapshot;
const live = (id: string, change: Partial<SubscriptionSnapshot> = {}) => ({ ok: true as const, debugId: null,
  value: { id, status: "ACTIVE", planId: MONTHLY, planOverridden: false, regularPrice: "24.0", nextBillingTime: null, lastPayment: null, raw: {}, ...change } });
type Spied = AnnualPreparationDependencies & { create: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
function deps(change: Partial<AnnualPreparationDependencies> = {}): Spied {
  return {
    configured: () => true,
    setting: async (key: string) => (key === "paypal.plan_id" ? MONTHLY : key === "paypal.product_id" ? PRODUCT : null),
    getPlan: async () => ({ ok: true, value: plan, debugId: null }),
    list: async () => [
      { subscriptionId: "I-PILOTA", label: "Pilot A", segment: "cancel_intent", reason: "price" },
      { subscriptionId: "I-PILOTD", label: "Pilot D", segment: "core", reason: "other" },
      { subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other" },
    ],
    read: vi.fn(async (id: string) => live(id, id === "I-PILOTE" ? { regularPrice: "18.00", planOverridden: true } : {})),
    create: vi.fn(async () => ({ id: "prop_annual" }) as Proposal),
    ...change,
  } as Spied;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("annual offer preparation", () => {
  it("reads only pilots in the strategy's segments and passes only live-eligible IDs, comparing prices by cents", async () => {
    const d = deps();
    await prepareAnnualOfferProposalWith(input, d);
    expect(d.read.mock.calls.map(([id]) => id)).toEqual(["I-PILOTD", "I-PILOTE"]);
    expect(d.create).toHaveBeenCalledWith({ ...input, productId: PRODUCT, monthlyPlanId: MONTHLY, eligibleIds: ["I-PILOTD"] });
  });

  it.each([
    ["not ACTIVE", { status: "SUSPENDED" }],
    ["on another plan", { planId: "P-ANNUAL0000000000000000001" }],
    ["a different subscription", { id: "I-OTHER" }],
    ["off list price", { regularPrice: "23.99" }],
  ])("skips a subscriber whose live read is %s", async (_name, change) => {
    const d = deps({ read: vi.fn(async (id: string) => live(id, id === "I-PILOTD" ? change : {})) });
    await prepareAnnualOfferProposalWith(input, d);
    expect(d.create).toHaveBeenCalledWith(expect.objectContaining({ eligibleIds: ["I-PILOTE"] }));
  });

  it.each([
    ["fails", async () => ({ ok: false as const, error: { name: "ServerError", message: "blip", httpStatus: 503, debugId: null, details: null } })],
    ["throws", async () => { throw new Error("network"); }],
  ])("proposes nothing when any pilot read %s", async (_name, failure) => {
    const d = deps({ read: vi.fn(async (id: string) => (id === "I-PILOTE" ? failure() : live(id))) as never });
    await expect(prepareAnnualOfferProposalWith(input, d)).rejects.toMatchObject({
      code: "NOT_EXECUTABLE", message: "PayPal could not be read for 1 pilot(s); nothing was proposed. Try again." });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("reads pilots in parallel and keeps registry order for the targets", async () => {
    const release: Record<string, () => void> = {};
    const d = deps({ read: vi.fn((id: string) => new Promise((resolve) => { release[id] = () => resolve(live(id)); })) as never });
    const pending = prepareAnnualOfferProposalWith(input, d);
    await vi.waitFor(() => expect(Object.keys(release).sort()).toEqual(["I-PILOTD", "I-PILOTE"]));
    release["I-PILOTE"](); release["I-PILOTD"]();
    await pending;
    expect(d.create).toHaveBeenCalledWith(expect.objectContaining({ eligibleIds: ["I-PILOTD", "I-PILOTE"] }));
  });

  it("stops before any read, or before creating, once the request is aborted", async () => {
    const before = new AbortController(); before.abort();
    const early = deps();
    await expect(prepareAnnualOfferProposalWith(input, early, before.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(early.read).not.toHaveBeenCalled(); expect(early.create).not.toHaveBeenCalled();
    const during = new AbortController();
    const late = deps({ read: vi.fn(async (id: string) => { during.abort(); return live(id); }) as never });
    await expect(prepareAnnualOfferProposalWith(input, late, during.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(late.create).not.toHaveBeenCalled();
  });

  it.each([
    ["PayPal is not configured", { configured: () => false }],
    ["the monthly plan is not registered", { setting: async () => null }],
    ["the monthly plan cannot be read", { getPlan: async () => ({ ok: false as const, error: { name: "NotFound", message: "gone", httpStatus: 404, debugId: null, details: null } }) }],
    ["the monthly plan belongs to another product", { getPlan: async () => ({ ok: true as const, value: { ...plan, productId: "PROD-OTHER000000000000001" }, debugId: null }) }],
  ])("refuses before any subscriber read when %s", async (_name, change) => {
    const d = deps(change as Partial<AnnualPreparationDependencies>);
    await expect(prepareAnnualOfferProposalWith(input, d)).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(d.read).not.toHaveBeenCalled(); expect(d.create).not.toHaveBeenCalled();
  });

  it("refuses a strategy that is not an annual plan", async () => {
    const d = deps();
    await expect(prepareAnnualOfferProposalWith({ ...input, strategy: STARTER_STRATEGIES[0] }, d)).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(d.read).not.toHaveBeenCalled();
  });
});

describe("proposeStrategy", () => {
  it("sends a discount through the unchanged proposal path", async () => {
    const create = vi.spyOn(proposals, "createProposal").mockResolvedValue({ id: "prop_discount" } as Proposal);
    const discount = { objective: null, strategy: STARTER_STRATEGIES[0], result: {} as StrategyResult, listPrice: 24 };
    expect(await proposeStrategy(discount)).toEqual({ id: "prop_discount" });
    expect(create).toHaveBeenCalledWith(discount);
  });

  it("prepares an annual plan from live eligibility, refusing without PayPal and never via the discount path", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", ""); vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const create = vi.spyOn(proposals, "createProposal");
    await expect(proposeStrategy({ objective: null, strategy, result: {} as StrategyResult, listPrice: 24 })).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(create).not.toHaveBeenCalled();
    expect(DEFAULT_OFFER_WINDOW_DAYS).toBe(7);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { buildAnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";
import type { TargetOutcome } from "@/execution/outcomes";
import { AnnualOfferCard } from "./AnnualOfferCard";
import { clampOfferWindowDays, formatUtc, outcomeCells, proposalBody } from "./annual-offers-view";

const action = buildAnnualOfferAction({ strategy: STARTER_STRATEGIES[2], listPrice: 24, productId: "PROD-RIDGELINE0000000001", monthlyPlanId: "P-MONTHLY000000000000000001",
  offerWindowDays: 7, eligible: [{ subscriptionId: "I-PILOTE", label: "Pilot E", segment: "core", reason: "other", createdAt: "2026-10-22T00:00:00.000Z" }] });
const proposal = { id: "prop_annual", status: "proposed", actionHash: "c".repeat(64), action, prediction: null } as unknown as Proposal;
const render = (canReview: boolean, status = "proposed", paypalConfigured = true) => renderToStaticMarkup(createElement(AnnualOfferCard, {
  proposal: { ...proposal, status } as Proposal, action, confirmed: false, setConfirmed: vi.fn(), busy: false, canReview, paypalConfigured, onApprove: vi.fn(), onReject: vi.fn() }));

describe("AnnualOfferCard", () => {
  it("shows the exact yearly offer, consent statements, hash and an unchecked confirmation", () => {
    const html = render(true);
    for (const text of ["$244.80/yr", "15% off $24.00/mo", "PROD-RIDGELINE0000000001", "P-MONTHLY000000000000000001", "7 day(s)", "Pilot E I-PILOTE", "c".repeat(64),
      "Each customer must agree in PayPal", "next renewal date", "can&#x27;t be moved back automatically", "Approve &amp; issue offers"]) expect(html).toContain(text);
    expect(html).toMatch(/type="checkbox"/);
    expect(html).not.toContain('checked=""');
    expect(html).not.toMatch(/<a\s|href=|ba_token/);
  });

  it("disables approval until confirmed, without administrator access or PayPal, and hides it once decided", () => {
    expect(render(true)).toMatch(/disabled=""[^>]*>Approve &amp; issue offers/);
    expect(render(false)).toMatch(/disabled=""[^>]*>Approve &amp; issue offers/);
    expect(render(true, "proposed", false)).toMatch(/disabled=""[^>]*>Approve &amp; issue offers/);
    const decided = render(true, "succeeded");
    expect(decided).not.toContain("Approve &amp; issue offers");
    expect(decided).not.toContain('type="checkbox"');
    expect(decided).toContain("Each customer must agree in PayPal");
  });
});

describe("annual offer view helpers", () => {
  it("formats instants in UTC without seconds", () => {
    expect(formatUtc("2026-11-08T00:00:00.000Z")).toBe("2026-11-08 00:00 UTC");
  });

  it("clamps the offer window to whole days from 1 to 30", () => {
    expect(clampOfferWindowDays("7")).toBe(7);
    expect(clampOfferWindowDays("0")).toBe(1);
    expect(clampOfferWindowDays("")).toBe(1);
    expect(clampOfferWindowDays("45")).toBe(30);
    expect(clampOfferWindowDays("4.6")).toBe(5);
    expect(clampOfferWindowDays("abc")).toBe(1);
  });

  it("sends the offer window only for annual strategies", () => {
    expect(proposalBody("goal", STARTER_STRATEGIES[2], 12)).toEqual({ objective: "goal", strategy: STARTER_STRATEGIES[2], offerWindowDays: 12 });
    expect(proposalBody("goal", STARTER_STRATEGIES[0], 12)).toEqual({ objective: "goal", strategy: STARTER_STRATEGIES[0] });
  });

  const base: TargetOutcome = { subscriptionId: "I-PILOTE", ok: true, httpStatus: 200, debugId: "dbg", verified: false, error: null,
    observed: { status: "ACTIVE", regularPrice: null, planOverridden: false, nextBillingTime: null } };

  it("reports an issued offer with its expiry, not as unverified", () => {
    const cells = outcomeCells({ ...base, offer: { annualPlanId: "P-YEARLY", expiresAt: "2026-11-08T00:00:00.000Z" } }, true);
    expect(cells).toEqual({ price: "—", status: "Offer issued · window closes 2026-11-08 00:00 UTC", verified: "customer decides", tone: "muted" });
  });

  it("reports an annual refusal by its reason rather than the read-back status", () => {
    const cells = outcomeCells({ ...base, ok: false, httpStatus: null, error: "Subscription is not at the list price (for example an active discount); no offer was made.",
      observed: { ...base.observed!, regularPrice: "19.20" } }, true);
    expect(cells.status).toMatch(/no offer was made/);
    expect(cells.verified).toBe("no offer");
    expect(cells.tone).toBe("negative");
    expect(cells.price).toBe("$19.20");
  });

  it("keeps the discount report's verified and refusal semantics", () => {
    expect(outcomeCells({ ...base, verified: true, observed: { ...base.observed!, regularPrice: "19.20" } }, false))
      .toEqual({ price: "$19.20", status: "ACTIVE", verified: "yes", tone: "positive" });
    const refused = outcomeCells({ ...base, ok: false, refused: "annual_plan" }, false);
    expect(refused.status).toMatch(/annual plan by customer choice/);
    expect(refused.verified).toBe("no");
  });
});

it("never calls an ambiguous annual failure 'no offer'", () => {
  const cells = outcomeCells({ subscriptionId: "I-PILOTE", ok: false, httpStatus: 503, debugId: null, verified: false, observed: null, error: "ServerError: blip" }, true);
  expect(cells.verified).toBe("unconfirmed");
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import { AnnualOffersPanel } from "./AnnualOffersPanel";
import { draftsErrorMessage, draftsFetchKey, offerCounts, offerStatusLabel, visibleDrafts, type FetchedDrafts } from "./annual-offers-view";

const base: AnnualOfferView = { id: 1, proposalId: "prop_x", subscriptionId: "I-PILOTD", segment: "core", annualPlanId: "P-ANNUAL", offeredAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z", status: "pending", outcome: "unresolved", resolvedAt: null, needsRead: true };
const switched: AnnualOfferView = { ...base, id: 2, subscriptionId: "I-PILOTE", status: "switched", outcome: "accepted", resolvedAt: "2026-11-01T00:10:00.000Z", needsRead: false };
const draft = (id: number) => ({ id, subscriptionId: `I-${id}`, label: null, expiresAt: base.expiresAt,
  message: `Hi.\n\nReview it here: https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-TEST${id}` });

it.each([
  [base, "Pending customer decision"],
  [switched, "Switched (verified by PayPal)"],
  [{ ...base, status: "expired", outcome: "unresolved" }, "Offer window closed · awaiting final check"],
  [{ ...base, status: "expired", outcome: "declined" }, "Offer window closed · declined"],
  [{ ...base, status: "invalid" }, "Needs administrator check (invalid deadline)"],
] as const)("labels %j honestly and never calls a link dead", (offer, label) => {
  expect(offerStatusLabel(offer)).toBe(label);
  expect(label).not.toMatch(/\bdead\b|expired link/i);
});

it("counts accepted, declined and awaiting offers", () => {
  expect(offerCounts([base, switched, { ...base, outcome: "declined" }])).toEqual({ accepted: 1, declined: 1, awaiting: 1 });
});

it("shows every visitor per-target status and window without any link", () => {
  const html = renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [base, switched], labels: { "I-PILOTD": "Pilot D", "I-PILOTE": "Pilot E" }, canReview: false }));
  expect(html).toContain("Annual offers");
  expect(html).toContain("Pilot E");
  expect(html).toContain("Switched (verified by PayPal)");
  expect(html).toContain("Pending customer decision");
  expect(html).toContain("2026-11-08 00:00 UTC");
  expect(html).toContain("1 accepted · 0 declined · 1 awaiting decision or final check");
  expect(html).not.toMatch(/ba_token|paypal\.com|Copy message/);
  expect(renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [], labels: {}, canReview: true }))).toBe("");
});

it("server-renders no link or copy control even for an administrator (drafts load only on the client)", () => {
  const html = renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [base], labels: {}, canReview: true }));
  expect(html).toContain("Pending customer decision");
  expect(html).not.toMatch(/ba_token|paypal\.com|Copy message/);
});

it("falls back to the subscription id for a subscriber that is no longer registered", () => {
  const html = renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [base], labels: { "I-OTHER": "Pilot X" }, canReview: false }));
  expect(html).toContain("I-PILOTD");
});

it("shows a status-unavailable state instead of disappearing, with no stale rows", () => {
  const html = renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [base], labels: { "I-PILOTD": "Pilot D" }, canReview: true, unavailable: true }));
  expect(html).toContain("Annual offers");
  expect(html).toContain("Offer status unavailable");
  expect(html).not.toContain("Pilot D");
  expect(renderToStaticMarkup(createElement(AnnualOffersPanel, { offers: [], labels: {}, canReview: false, unavailable: true }))).toContain("Offer status unavailable");
});

it("fetches drafts only for an administrator with pending offers and a readable status", () => {
  expect(draftsFetchKey({ canReview: false, unavailable: false, revision: 1, offers: [base] })).toBe("");
  expect(draftsFetchKey({ canReview: true, unavailable: true, revision: 1, offers: [base] })).toBe("");
  expect(draftsFetchKey({ canReview: true, unavailable: false, revision: 1, offers: [switched] })).toBe("");
  expect(draftsFetchKey({ canReview: true, unavailable: false, revision: 3, offers: [base, switched] })).toBe("3:1");
});

it("shows only drafts fetched for the current refresh and still pending", () => {
  const fetched: FetchedDrafts = { key: "3:1", drafts: [draft(1), draft(9)], error: null };
  expect(visibleDrafts(fetched, "3:1", [base]).map((d) => d.id)).toEqual([1]);
  expect(visibleDrafts(fetched, "4:1", [base])).toEqual([]);
  expect(visibleDrafts(fetched, "", [base])).toEqual([]);
  expect(visibleDrafts({ ...fetched, drafts: null, error: "x" }, "3:1", [base])).toEqual([]);
  expect(visibleDrafts(null, "3:1", [base])).toEqual([]);
});

it("asks the administrator to sign in again after a 401", () => {
  expect(draftsErrorMessage(401)).toMatch(/sign in again/i);
  expect(draftsErrorMessage(500)).toBe("Customer messages are unavailable.");
  expect(draftsErrorMessage(null)).toBe("Customer messages are unavailable.");
});

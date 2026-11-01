import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import { AnnualOffersPanel } from "./AnnualOffersPanel";
import {
  closedDrafts, draftName, draftsErrorMessage, draftsFetchKey, offerCounts, offerStatusLabel, pruneDrafts, visibleDrafts, type FetchedDrafts,
} from "./annual-offers-view";

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

const key = (over: Partial<Parameters<typeof draftsFetchKey>[0]>) =>
  draftsFetchKey({ canReview: true, unavailable: false, revision: 3, accessEpoch: 0, offers: [base, switched], ...over });

it("fetches drafts only for an administrator with pending offers and a readable status", () => {
  expect(key({ canReview: false })).toBe("");
  expect(key({ unavailable: true })).toBe("");
  expect(key({ offers: [switched] })).toBe("");
  expect(key({})).toBe("0.3:1");
});

it("gives every access change a new key, so drafts from before a sign-out never render again", () => {
  const before = key({ accessEpoch: 0 });
  const fetched: FetchedDrafts = { key: before, drafts: [draft(1)], closed: [], error: null };
  expect(visibleDrafts(fetched, before, [base]).map((d) => d.id)).toEqual([1]);
  expect(key({ canReview: false, accessEpoch: 1 })).toBe("");
  const after = key({ accessEpoch: 2 });
  expect(after).not.toBe(before);
  expect(visibleDrafts(fetched, after, [base])).toEqual([]);
  expect(closedDrafts({ ...fetched, closed: [{ id: 1, name: "Pilot D" }] }, after, [base])).toEqual([]);
});

it("shows only drafts fetched for the current refresh and still pending", () => {
  const fetched: FetchedDrafts = { key: "0.3:1", drafts: [draft(1), draft(9)], closed: [{ id: 9, name: "I-9" }], error: null };
  expect(visibleDrafts(fetched, "0.3:1", [base]).map((d) => d.id)).toEqual([1]);
  expect(visibleDrafts(fetched, "0.4:1", [base])).toEqual([]);
  expect(visibleDrafts(fetched, "", [base])).toEqual([]);
  expect(visibleDrafts({ ...fetched, drafts: null, error: "x" }, "0.3:1", [base])).toEqual([]);
  expect(visibleDrafts(null, "0.3:1", [base])).toEqual([]);
  expect(closedDrafts(fetched, "0.3:1", [base, { ...base, id: 9 }])).toEqual([{ id: 9, name: "I-9" }]);
  expect(closedDrafts(fetched, "0.3:1", [base])).toEqual([]);
});

it("moves a draft out of view when its window closes, keeping only a link-free name", () => {
  const closing = { ...draft(1), expiresAt: "2026-11-02T00:00:00.000Z", label: "Pilot D" };
  const later = { ...draft(2), expiresAt: "2026-11-05T00:00:00.000Z" };
  const result = pruneDrafts([closing, later], [], Date.parse("2026-11-03T00:00:00.000Z"), {});
  expect(result.open.map((d) => d.id)).toEqual([2]);
  expect(result.closed).toEqual([{ id: 1, name: "Pilot D" }]);
  expect(JSON.stringify(result.closed)).not.toMatch(/ba_token|paypal/);
  expect(result.nextCloseAt).toBe(Date.parse(later.expiresAt));
  expect(pruneDrafts([later], [], Date.parse("2026-11-03T00:00:00.000Z"), { "I-2": "Pilot B" }).closed).toEqual([]);
  expect(pruneDrafts([later], [], Date.parse("2026-11-06T00:00:00.000Z"), { "I-2": "Pilot B" })).toEqual({ open: [], closed: [{ id: 2, name: "Pilot B" }], nextCloseAt: null });
});

it("names a draft by its label, then the cohort label, then the subscription id", () => {
  expect(draftName({ label: "Pilot D", subscriptionId: "I-1" }, { "I-1": "Cohort" })).toBe("Pilot D");
  expect(draftName({ label: null, subscriptionId: "I-1" }, { "I-1": "Cohort" })).toBe("Cohort");
  expect(draftName({ label: null, subscriptionId: "I-1" }, {})).toBe("I-1");
});

it("asks the administrator to sign in again after a 401", () => {
  expect(draftsErrorMessage(401)).toMatch(/sign in again/i);
  expect(draftsErrorMessage(500)).toBe("Customer messages are unavailable.");
  expect(draftsErrorMessage(null)).toBe("Customer messages are unavailable.");
});

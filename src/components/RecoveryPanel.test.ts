import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscountResumeReview, RecoveryReview, pendingActions } from "./RecoveryPanel";
import type { Proposal } from "@/ledger/proposals";

it("renders a recovery as a current-to-list restoration with no simulated benefit and unchecked confirmation", () => {
  const proposal = { id: "p", actionHash: "a".repeat(64), status: "proposed", prediction: null,
    action: { type: "subscription_price_revert", sourceProposalId: "source", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] },
  } as Proposal;
  const html = renderToStaticMarkup(createElement(RecoveryReview, { proposal, confirmed: false, canReview: true, paypalConfigured: true, onConfirm: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), busy: false }));
  expect(html).toContain("$18.00");
  expect(html).toContain("$24.00");
  expect(html).toContain("No simulated recovery benefit");
  expect(html).not.toContain("checked");
  expect(html).toContain("disabled");
});

it("keeps approved discounts and nonterminal recoveries visible after a history reload", () => {
  const discount = { id: "discount", action: { type: "subscription_price_override" }, status: "approved", executions: [] } as never;
  const recovery = { id: "recovery", action: { type: "subscription_price_revert" }, status: "proposed", executions: [] } as never;
  const executing = { id: "executing", action: { type: "subscription_price_revert" }, status: "executing", executions: [] } as never;
  const done = { id: "done", action: { type: "subscription_price_revert" }, status: "succeeded", executions: [] } as never;
  expect(pendingActions([discount, recovery, executing, done]).map((proposal) => proposal.id)).toEqual(["discount", "recovery", "executing"]);
});

it("requires fresh unchecked confirmation to resume an approved discount", () => {
  const proposal = { id: "p", actionHash: "a".repeat(64), status: "approved", action: { type: "subscription_price_override", listPrice: "24.00", newPrice: "18.00", targets: ["I-ONE"] } } as Proposal;
  const html = renderToStaticMarkup(createElement(DiscountResumeReview, { proposal, confirmed: false, canReview: true, paypalConfigured: true, busy: false, onConfirm: vi.fn(), onResume: vi.fn() }));
  expect(html).toContain("$24.00"); expect(html).toContain("$18.00");
  expect(html).toContain("I-ONE"); expect(html).toContain("disabled");
  expect(html).not.toContain('checked=""');
});

it("shows reconciliation without an execution control for an executing recovery", () => {
  const proposal = { id: "p", actionHash: "a".repeat(64), status: "executing", action: { type: "subscription_price_revert", sourceProposalId: "source", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.00", listPrice: "24.00" }] } } as Proposal;
  const html = renderToStaticMarkup(createElement(RecoveryReview, { proposal, confirmed: false, canReview: true, paypalConfigured: true, onConfirm: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), busy: false }));
  expect(html).toContain("reconciliation");
  expect(html).not.toContain("Execute approved restoration");
});

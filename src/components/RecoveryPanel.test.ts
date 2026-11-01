import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscountResumeReview, RecoveryReview, RecoveryPanel, RESET_SKIP_TEXT, discountEvidenceReader, pendingActions, reportSummary, runRecoveryAttempt } from "./RecoveryPanel";
import type { Proposal } from "@/ledger/proposals";

it.each(["proposed", "approved", "executing"] as const)("shows a reloaded %s reset with exact price/hash, unchecked confirmation and guarded execution", (status) => {
  const proposal = { id: "reset", actionHash: "a".repeat(64), status, prediction: null, strategy: null,
    action: { type: "subscription_price_reset", canonicalListPrice: "24.00", targets: [{ subscriptionId: "I-ONE", expectedCurrentPrice: "18.0" }] },
  } as Proposal;
  expect(pendingActions([proposal])).toEqual([proposal]);
  const html = renderToStaticMarkup(createElement(RecoveryReview, { proposal, confirmed: false, canReview: true, paypalConfigured: true,
    onConfirm: vi.fn(), onApprove: vi.fn(), onResume: vi.fn(), onReject: vi.fn(), busy: false }));
  expect(html).toContain("$18.0"); expect(html).toContain("$24.00"); expect(html).toContain(proposal.actionHash);
  expect(html).toContain("No simulated recovery benefit"); expect(html).not.toContain('checked=""');
  if (status === "executing") { expect(html).toContain("reconciliation"); expect(html).not.toContain("<button"); }
  else { expect(html).toContain("disabled"); expect(html).toContain(status === "approved" ? "Execute approved reset" : "Confirm &amp; reset"); }
});

it("exposes the reset preview only to an administrator with configured PayPal", () => {
  const render = (canReview: boolean, paypalConfigured: boolean) => renderToStaticMarkup(createElement(RecoveryPanel, { canReview, paypalConfigured, onObservedChange: vi.fn() }));
  expect(render(true, true)).toContain("Preview demo reset");
  expect(render(false, true)).not.toContain("Preview demo reset");
  expect(render(true, false)).toMatch(/disabled[^>]*>Preview demo reset/);
});

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

it("waits for status observations before reading current evidence", async () => {
  let release!: (value: boolean) => void;
  const status = new Promise<boolean>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const readEvidence = vi.fn(async () => { calls.push("evidence"); return { episodes: 1 } as never; });
  const pending = runRecoveryAttempt(async () => { calls.push("mutation"); return "report"; },
    async () => { calls.push("status-start"); return status; }, readEvidence,
    (value) => { calls.push(value === null ? "cleared" : "updated"); });
  await Promise.resolve();
  expect(readEvidence).not.toHaveBeenCalled();
  release(true);
  expect(await pending).toBe("report");
  expect(calls).toEqual(["cleared", "mutation", "status-start", "evidence", "updated"]);
});

it("invalidates prior current evidence after partial execution followed by reconciliation error", async () => {
  let current: { episodes: number } | null = { episodes: 5 };
  const reconcile = new Error("reconcile after one target");
  const status = vi.fn(async () => true);
  await expect(runRecoveryAttempt(async () => { throw reconcile; }, status,
    async () => { throw new Error("evidence unavailable"); },
    (value) => { current = value as { episodes: number } | null; })).rejects.toBe(reconcile);
  expect(status).toHaveBeenCalledOnce();
  expect(current).toBeNull();
});

it("refreshes status but never discount evidence after resuming an annual offer", async () => {
  const read = vi.fn(async () => ({ episodes: 3 }) as never);
  expect(discountEvidenceReader("subscription_price_override", read)).toBe(read);
  expect(discountEvidenceReader("annual_plan_offer", read)).toBeNull();
  const status = vi.fn(async () => true);
  const set = vi.fn();
  expect(await runRecoveryAttempt(async () => "report", status, discountEvidenceReader("annual_plan_offer", read), set)).toBe("report");
  expect(status).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(set.mock.calls.every(([value]) => value === null)).toBe(true);
});

it("lists only approved or executing annual offers and shows an approved one for explicit resumption", () => {
  const action = { type: "annual_plan_offer", annualPrice: "244.80", discountPct: 15, targets: [{ subscriptionId: "I-PILOTE", registration: { label: "Pilot E" } }] };
  const proposed = { id: "a1", actionHash: "b".repeat(64), status: "proposed", action } as unknown as Proposal;
  const approved = { ...proposed, id: "a2", status: "approved" } as Proposal;
  expect(pendingActions([proposed, approved])).toEqual([approved]);
  const html = renderToStaticMarkup(createElement(DiscountResumeReview, { proposal: approved, confirmed: false, canReview: true, paypalConfigured: true, busy: false, onConfirm: vi.fn(), onResume: vi.fn() }));
  expect(html).toContain("$244.80/yr");
  expect(html).toContain("15% off");
  expect(html).toContain("I-PILOTE");
  expect(html).toContain("Execute approved annual offer");
  expect(html).toContain("disabled");
  expect(html).not.toContain('checked=""');
  expect(renderToStaticMarkup(createElement(RecoveryReview, { proposal: approved, confirmed: false, canReview: true, paypalConfigured: true, busy: false,
    onConfirm: vi.fn(), onApprove: vi.fn(), onReject: vi.fn() }))).toBe("");
});

it("shows reconciliation without an execution control for an executing annual offer", () => {
  const proposal = { id: "a3", actionHash: "b".repeat(64), status: "executing",
    action: { type: "annual_plan_offer", annualPrice: "244.80", discountPct: 15, targets: [{ subscriptionId: "I-PILOTE", registration: { label: "Pilot E" } }] } } as unknown as Proposal;
  expect(pendingActions([proposal])).toEqual([proposal]);
  const html = renderToStaticMarkup(createElement(DiscountResumeReview, { proposal, confirmed: false, canReview: true, paypalConfigured: true, busy: false, onConfirm: vi.fn(), onResume: vi.fn() }));
  expect(html).toContain("reconciliation");
  expect(html).not.toContain("<button");
});

it("reports a resumed annual offer as offers issued, never as verified switches, and keeps the recovery wording", () => {
  const outcome = { subscriptionId: "I-PILOTE", ok: true, httpStatus: 200, debugId: null, verified: false, observed: null, error: null };
  const annual = reportSummary({ proposal: { status: "succeeded", action: { type: "annual_plan_offer" } } as unknown as Proposal,
    outcomes: [{ ...outcome, offer: { annualPlanId: "P-ANNUAL", expiresAt: "2026-11-08T00:00:00.000Z" } }, { ...outcome, subscriptionId: "I-PILOTD", ok: false, error: "Not ACTIVE" }] });
  expect(annual).toBe("Annual offer succeeded: 1 of 2 offer(s) issued. Each customer chooses in PayPal; a switch counts only after a later status read confirms it.");
  const recovery = reportSummary({ proposal: { status: "partially_failed", action: { type: "subscription_price_revert" } } as unknown as Proposal,
    outcomes: [{ ...outcome, verified: true }, { ...outcome, ok: false, skipped: true }] });
  expect(recovery).toBe("Recovery partially failed: 1 of 2 target(s) verified · 1 already at list price. Current PayPal prices can be checked below; the run's simulation snapshot remains historical.");
});

it("reports an annual subscriber as a customer choice, not a reset failure", () => {
  expect(RESET_SKIP_TEXT).toEqual({ already_list_price: "already at list price", inactive: "inactive", unregistered: "unregistered",
    annual_plan: "switched to annual by customer choice; not reset" });
});

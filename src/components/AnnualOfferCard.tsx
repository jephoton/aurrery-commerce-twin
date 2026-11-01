import type { AnnualOfferAction } from "@/ledger/annual-offer-action";
import type { Proposal } from "@/ledger/proposals";

// The exact annual-plan offer a merchant approves. No approval link is ever shown here: links exist
// only after execution and are served only through the admin offers endpoint.

const money = (v: number) => `$${Math.round(v).toLocaleString()}`;

export function AnnualOfferCard({ proposal, action, confirmed, setConfirmed, busy, canReview, paypalConfigured, onApprove, onReject }: {
  proposal: Proposal; action: AnnualOfferAction; confirmed: boolean; setConfirmed: (value: boolean) => void; busy: boolean;
  canReview: boolean; paypalConfigured: boolean; onApprove: () => void; onReject: () => void;
}) {
  const d = proposal.prediction?.vsBaseline.totalValue;
  return (
    <div>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Yearly price" value={`$${action.annualPrice}/yr (${action.discountPct}% off $${action.listPrice}/mo × 12)`} />
        <Row label="Product and currency" value={`${action.productId} · ${action.currency}`} mono />
        <Row label="Switch" value={`From monthly plan ${action.monthlyPlanId} to a new yearly plan created on approval`} />
        <Row label="Offered segments" value={action.segments.map((s) => s.replaceAll("_", " ")).join(", ")} />
        <Row label="Offer window" value={`${action.offerWindowDays} day(s) from when each offer is issued`} />
        <Row label="Targets" value={action.targets.map((t) => `${t.registration.label} ${t.subscriptionId} (${t.registration.segment.replaceAll("_", " ")})`).join(", ")} />
        {d && <Row label="Simulated Δ value (median, 80% interval)" value={`${money(d.p50)} (${money(d.p10)} … ${money(d.p90)})`} />}
        <Row label="Status" value={proposal.status} />
        <Row label="Payload hash" value={proposal.actionHash} mono />
      </dl>
      <details className="mb-4 rounded-lg border border-border bg-background px-4 py-3 text-sm">
        <summary className="font-medium text-brand-accent">PayPal operation details</summary>
        <p className="mt-2 break-all font-mono text-xs">POST /v1/billing/plans (yearly; request ID from the payload hash) · POST /v1/billing/subscriptions/&#123;id&#125;/revise, once per subscriber</p>
      </details>
      <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-muted">
        <li>Each customer must agree in PayPal. Nothing changes for a customer who does not approve.</li>
        <li>The yearly price is charged from each subscriber&apos;s next renewal date, not today.</li>
        <li>Switched customers can&apos;t be moved back automatically.</li>
        <li>Offers cannot be withdrawn; each closes when its window ends.</li>
      </ul>
      {proposal.status === "proposed" && (
        <>
          <label className="mb-3 flex min-h-10 items-center gap-3 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy || !canReview} onChange={(e) => setConfirmed(e.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
            I approve offering these {action.targets.length} PayPal Sandbox subscriber(s) a switch to the yearly plan.
          </label>
          <div className="flex flex-wrap gap-3">
            <button onClick={onApprove} disabled={!confirmed || busy || !paypalConfigured || !canReview} className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50">
              {busy ? "Working…" : "Approve & issue offers"}
            </button>
            <button onClick={onReject} disabled={busy || !canReview} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:bg-background disabled:opacity-50">Reject</button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>{value}</dd>
    </div>
  );
}

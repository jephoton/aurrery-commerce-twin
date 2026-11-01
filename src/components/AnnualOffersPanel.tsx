"use client";

import { useEffect, useState } from "react";
import type { AnnualOfferView } from "@/ledger/annual-offer-status";
import {
  draftsErrorMessage, draftsFetchKey, formatUtc, offerCounts, offerStatusLabel, visibleDrafts,
  type FetchedDrafts, type OfferDraft,
} from "./annual-offers-view";

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Everyone sees per-target status and window. Administrators also get display-only drafts with the secret
 * approval link, fetched on the client only (never server-rendered) and shown only while the offer is pending.
 */
export function AnnualOffersPanel({ offers, labels, canReview, unavailable = false, revision = 0 }: {
  offers: AnnualOfferView[]; labels: Record<string, string>; canReview: boolean;
  /** The latest status read failed (or was rate limited): show that, not stale rows. */
  unavailable?: boolean;
  /** Bumped on every successful status read, so each refresh refetches the drafts. */
  revision?: number;
}) {
  const [fetched, setFetched] = useState<FetchedDrafts | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const key = draftsFetchKey({ canReview, unavailable, revision, offers });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (status: number | null) => { if (!cancelled) setFetched({ key, drafts: null, error: draftsErrorMessage(status) }); };
    // Drop each draft when its window closes, even without a refresh.
    const prune = (drafts: OfferDraft[]) => {
      const open = drafts.filter((draft) => Date.parse(draft.expiresAt) > Date.now());
      setFetched({ key, drafts: open, error: null });
      if (!open.length) return;
      const next = Math.min(...open.map((draft) => Date.parse(draft.expiresAt))) - Date.now();
      timer = setTimeout(() => { if (!cancelled) prune(open); }, Math.min(Math.max(next, 0), MAX_TIMEOUT_MS));
    };
    fetch("/api/annual-offers/links", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return fail(response.status);
        const body = (await response.json()) as { offers?: OfferDraft[] };
        if (cancelled) return;
        if (!Array.isArray(body.offers)) return fail(null);
        prune(body.offers);
      })
      .catch(() => fail(null));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key]);

  if (!offers.length && !unavailable) return null;
  const drafts = visibleDrafts(fetched, key, offers);
  const draftsError = key && fetched?.key === key ? fetched.error : null;
  const counts = offerCounts(offers);
  const copy = async (draft: OfferDraft) => {
    try { await navigator.clipboard.writeText(draft.message); setCopied(draft.id); setCopyError(null); }
    catch { setCopyError("Copy failed; select the message text instead."); }
  };
  return (
    <section className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="annual-offers-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="annual-offers-title" className="text-lg font-semibold">Annual offers</h2>
        <span className="source-badge text-observed">Status from PayPal Sandbox read-back</span>
      </div>
      {unavailable ? (
        <p role="status" className="text-sm text-muted">Offer status unavailable right now. Use Refresh from PayPal to try again.</p>
      ) : (
        <>
          <p className="mb-3 text-sm">{counts.accepted} accepted · {counts.declined} declined · {counts.awaiting} awaiting decision or final check</p>
          <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-muted"><tr><th className="py-1">Subscriber</th><th>Segment</th><th>Status</th><th>Window closes</th></tr></thead>
            <tbody>{offers.map((offer) => (
              <tr key={offer.id} className="border-t border-border">
                <td className="py-2">{labels[offer.subscriptionId] ?? offer.subscriptionId}</td>
                <td>{offer.segment.replaceAll("_", " ")}</td>
                <td>{offerStatusLabel(offer)}</td>
                <td>{formatUtc(offer.expiresAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="mt-2 text-xs text-muted">Refresh from PayPal to record each customer&apos;s decision. A switch takes effect at the subscriber&apos;s next renewal date.</p>
          {drafts.length > 0 && <div className="mt-4 border-t border-border pt-4">
            <h3 className="font-medium">Draft customer messages (administrators only)</h3>
            <p className="mt-1 text-sm text-muted">Display only: Aurrery does not send these. Each contains that subscriber&apos;s private PayPal approval link.</p>
            <ul className="mt-2 space-y-3">{drafts.map((draft) => (
              <li key={draft.id} className="text-sm">
                <p className="font-medium">{draft.label ?? labels[draft.subscriptionId] ?? draft.subscriptionId}</p>
                <textarea readOnly value={draft.message} rows={9} aria-label={`Draft message for ${draft.label ?? draft.subscriptionId}`}
                  className="mt-1 w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" />
                <button type="button" onClick={() => void copy(draft)} className="mt-1 min-h-10 rounded-lg border border-border px-3 hover:bg-background">
                  {copied === draft.id ? "Copied" : "Copy message"}
                </button>
              </li>
            ))}</ul>
          </div>}
          {canReview && (draftsError ?? copyError) && <p role="alert" className="mt-3 text-sm text-negative">{draftsError ?? copyError}</p>}
        </>
      )}
    </section>
  );
}

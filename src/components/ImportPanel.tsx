"use client";

import { useId, useState, type ChangeEvent } from "react";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS, type Economics } from "@/import/economics";
import { MAX_FEEDBACK_BYTES } from "@/import/feedback-csv";
import { MAX_HISTORY_BYTES } from "@/import/history-csv";
import { DEMO_ONLY_MESSAGE } from "@/import/messages";
import { SAMPLE_FILES } from "@/import/sample-files";
import { buildImport, formatImportError, readLimitedFile, type ImportError, type ImportSession, type LoadedFile } from "./import-flow";

// "Use your own data" (M6): files are read in this tab only, checked locally for instant per-row errors and then re-checked
// by the server. A failed build leaves the current twin unchanged; a successful one hands the session to `Lab`.

type EconomicsForm = Record<keyof Economics, string>;
const NUMBER_FIELDS = [
  ["listPrice", "List price (USD per month, 1–200)"],
  ["unitCost", "Unit cost (USD per box)"],
  ["shippingCost", "Shipping cost (USD per box)"],
  ["paymentFeeRate", "Payment fee rate (0–0.2)"],
  ["paymentFeeFixed", "Fixed payment fee (USD, 0–5)"],
] as const;
const input = "mt-1 block min-h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3";
const toForm = (e: Economics): EconomicsForm => ({ merchantName: e.merchantName, planName: e.planName, listPrice: String(e.listPrice), unitCost: String(e.unitCost), shippingCost: String(e.shippingCost), paymentFeeRate: String(e.paymentFeeRate), paymentFeeFixed: String(e.paymentFeeFixed) });
/** Blank or non-numeric fields become NaN, which the schema reports per field. */
const toNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
const fromForm = (f: EconomicsForm) => ({ merchantName: f.merchantName, planName: f.planName, listPrice: toNumber(f.listPrice), unitCost: toNumber(f.unitCost), shippingCost: toNumber(f.shippingCost), paymentFeeRate: toNumber(f.paymentFeeRate), paymentFeeFixed: toNumber(f.paymentFeeFixed) });
const fileError = (source: ImportError["source"], message: string): ImportError => ({ source, row: null, column: null, message });

export function ImportPanel({ disabled, onImported }: { disabled: boolean; onImported(session: ImportSession): void }) {
  const id = useId();
  const [history, setHistory] = useState<LoadedFile | null>(null);
  const [feedback, setFeedback] = useState<LoadedFile | null>(null);
  const [form, setForm] = useState<EconomicsForm>(() => toForm(DEFAULT_ECONOMICS));
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [busy, setBusy] = useState(false);
  // Remounts the file inputs when the sample replaces their files or a file is removed, so they never show a stale name.
  const [inputsEpoch, setInputsEpoch] = useState(0);
  const locked = disabled || busy;

  const pick = (source: "history" | "feedback") => async (event: ChangeEvent<HTMLInputElement>) => {
    const set = source === "history" ? setHistory : setFeedback;
    const file = event.target.files?.[0];
    if (!file) { set(null); return; }
    const loaded = await readLimitedFile(file, source === "history" ? MAX_HISTORY_BYTES : MAX_FEEDBACK_BYTES, source);
    if ("text" in loaded) { set(loaded); setErrors([]); } else { set(null); setErrors([loaded]); }
  };
  const removeFeedback = () => { setFeedback(null); setInputsEpoch((n) => n + 1); };
  const loadSample = async () => {
    setBusy(true); setErrors([]);
    try {
      const [h, f] = await Promise.all([SAMPLE_FILES.history, SAMPLE_FILES.feedback].map(async (path): Promise<LoadedFile> => {
        const response = await fetch(`/${path}`);
        if (!response.ok) throw new Error(path);
        return { name: path.split("/").pop() ?? path, text: await response.text() };
      }));
      setHistory(h); setFeedback(f); setForm(toForm(SAMPLE_ECONOMICS)); setInputsEpoch((n) => n + 1);
    } catch {
      setErrors([fileError("server", "The sample files could not be loaded.")]);
    } finally { setBusy(false); }
  };
  const build = async () => {
    if (!history) { setErrors([fileError("history", "Choose a history CSV first.")]); return; }
    setBusy(true); setErrors([]);
    try {
      const result = await buildImport({ history: history.text, feedback: feedback?.text ?? null, economics: fromForm(form) });
      if (result.ok) onImported(result.session); else setErrors(result.errors);
    } finally { setBusy(false); }
  };

  return (
    <details className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <summary className="min-h-10 cursor-pointer pt-2 text-lg font-semibold">Use your own data</summary>
      <p className="mt-2 text-sm text-muted">
        Upload monthly subscriber history and, optionally, cancellation feedback to build a separate twin for this browser tab. It is simulate only: {DEMO_ONLY_MESSAGE} Your files stay in this tab; the server re-checks them on each request and stores nothing. Reloading the page returns to Ridgeline.
      </p>
      <p className="mt-2 text-sm">
        Download: <a href={`/${SAMPLE_FILES.template}`} download className="text-brand-accent underline">history template</a> · <a href={`/${SAMPLE_FILES.history}`} download className="text-brand-accent underline">sample history</a> · <a href={`/${SAMPLE_FILES.feedback}`} download className="text-brand-accent underline">sample feedback</a>
      </p>
      <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 text-sm">
          <label htmlFor={`${id}-history`}>History CSV (required: 6–60 months, up to 256 KiB)</label>
          <input key={`history-${inputsEpoch}`} id={`${id}-history`} type="file" accept=".csv,text/csv" disabled={locked} onChange={pick("history")} className="mt-1 block w-full min-w-0 text-sm" />
          {history && <p className="mt-1 break-words text-muted">Using {history.name}</p>}
        </div>
        <div className="min-w-0 text-sm">
          <label htmlFor={`${id}-feedback`}>Feedback CSV (optional: up to 200 rows, classified by AI; text is not stored)</label>
          <input key={`feedback-${inputsEpoch}`} id={`${id}-feedback`} type="file" accept=".csv,text/csv" disabled={locked} onChange={pick("feedback")} className="mt-1 block w-full min-w-0 text-sm" />
          {feedback && <p className="mt-1 break-words text-muted">Using {feedback.name} <button type="button" disabled={locked} onClick={removeFeedback} className="ml-2 min-h-10 text-brand-accent underline disabled:opacity-50">Remove</button></p>}
        </div>
      </div>
      <fieldset disabled={locked} className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">Unit economics: merchant-entered assumptions, prefilled with the demo merchant&apos;s numbers</legend>
        <label className="min-w-0 text-sm">Merchant name<input value={form.merchantName} maxLength={80} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} className={input} /></label>
        <label className="min-w-0 text-sm">Plan name<input value={form.planName} maxLength={80} onChange={(e) => setForm({ ...form, planName: e.target.value })} className={input} /></label>
        {NUMBER_FIELDS.map(([key, label]) => (
          <label key={key} className="min-w-0 text-sm">{label}<input type="number" step="any" inputMode="decimal" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={input} /></label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={build} disabled={locked || !history} className="min-h-10 rounded-lg bg-brand px-4 py-2 font-semibold text-background hover:bg-brand-accent disabled:opacity-50">{busy ? "Working…" : "Build twin"}</button>
        <button type="button" onClick={loadSample} disabled={locked} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:border-brand-accent disabled:opacity-50">Load sample merchant</button>
      </div>
      <p role="status" className="sr-only">{busy ? "Checking the import…" : ""}</p>
      {errors.length > 0 && <ImportErrors errors={errors} />}
    </details>
  );
}

export function ImportErrors({ errors }: { errors: ImportError[] }) {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
      <p className="font-medium">The import was not applied; the current twin is unchanged. Fix these and build again.</p>
      <ul className="mt-2 list-inside list-disc space-y-1 break-words">{errors.map((error, i) => <li key={i}>{formatImportError(error)}</li>)}</ul>
    </div>
  );
}

export function ImportedBanner({ session, disabled, onBack }: { session: ImportSession; disabled: boolean; onBack(): void }) {
  return (
    <section aria-label="Imported merchant" className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/50 bg-surface p-4 text-sm">
      <div className="min-w-0 break-words">
        <p className="font-semibold">Imported: {session.summary.name} · simulate only</p>
        <p className="text-muted">Built from your CSV in this browser tab. Nothing was stored; reloading the page also returns to Ridgeline.</p>
        {session.classifierNotes.length > 0 && <ul className="mt-1 list-inside list-disc text-muted">{session.classifierNotes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      </div>
      <button type="button" onClick={onBack} disabled={disabled} className="min-h-10 rounded-lg border border-border px-4 py-2 font-medium hover:border-brand-accent disabled:opacity-50">Back to Ridgeline</button>
    </section>
  );
}

export function DemoOnlyNotice() {
  return (
    <section aria-labelledby="demo-only-title" className="mb-6 min-w-0 rounded-2xl border border-border bg-surface p-5 text-sm sm:p-6">
      <h2 id="demo-only-title" className="text-lg font-semibold">Approval, pilots, annual offers and recovery</h2>
      <p className="mt-2 text-muted">{DEMO_ONLY_MESSAGE} Go back to Ridgeline to prepare, approve or recover PayPal Sandbox actions.</p>
    </section>
  );
}

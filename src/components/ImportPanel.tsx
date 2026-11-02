"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type Ref } from "react";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS, type Economics } from "@/import/economics";
import { MAX_FEEDBACK_BYTES } from "@/import/feedback-csv";
import { MAX_HISTORY_BYTES } from "@/import/history-csv";
import { DEMO_ONLY_MESSAGE } from "@/import/messages";
import { SAMPLE_FILES } from "@/import/sample-files";
import { buildImport, createReadGuard, formatImportError, readLimitedFile, type ImportError, type ImportSession, type LoadedFile } from "./import-flow";

// "Use your own data" (M6): files are read in this tab only, checked locally for instant per-row errors and then re-checked
// by the server. A failed build leaves the current twin unchanged; a successful one hands the session to `Lab`.

type EconomicsForm = Record<keyof Economics, string>;
type FileSource = "history" | "feedback";
type BusyKind = "build" | "sample";
const NUMBER_FIELDS = [
  ["listPrice", "List price (USD per month, 1–200)"],
  ["unitCost", "Unit cost (USD per box)"],
  ["shippingCost", "Shipping cost (USD per box)"],
  ["paymentFeeRate", "Payment fee rate (0–0.2)"],
  ["paymentFeeFixed", "Fixed payment fee (USD, 0–5)"],
] as const;
const TEXT_FIELDS = [["merchantName", "Merchant name"], ["planName", "Plan name"]] as const;
const input = "mt-1 block min-h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 aria-[invalid=true]:border-negative";
const toForm = (e: Economics): EconomicsForm => ({ merchantName: e.merchantName, planName: e.planName, listPrice: String(e.listPrice), unitCost: String(e.unitCost), shippingCost: String(e.shippingCost), paymentFeeRate: String(e.paymentFeeRate), paymentFeeFixed: String(e.paymentFeeFixed) });
/** Blank or non-numeric fields become NaN, which the flow reports as "must be a number". */
const toNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
const fromForm = (f: EconomicsForm) => ({ merchantName: f.merchantName, planName: f.planName, listPrice: toNumber(f.listPrice), unitCost: toNumber(f.unitCost), shippingCost: toNumber(f.shippingCost), paymentFeeRate: toNumber(f.paymentFeeRate), paymentFeeFixed: toNumber(f.paymentFeeFixed) });
const fileError = (source: ImportError["source"], message: string): ImportError => ({ source, row: null, column: null, message });
const STATUS: Record<BusyKind, string> = { build: "Checking the import…", sample: "Loading the sample merchant…" };

/** Economics errors by form field (first message wins), for aria-invalid and the message under the field. */
export function economicsFieldErrors(errors: ImportError[]): Partial<Record<keyof Economics, string>> {
  const out: Partial<Record<keyof Economics, string>> = {};
  for (const e of errors) {
    if (e.source === "economics" && e.column && Object.hasOwn(DEFAULT_ECONOMICS, e.column)) out[e.column as keyof Economics] ??= e.message;
  }
  return out;
}

export function ImportPanel({ disabled, onImported, onBusyChange }: {
  disabled: boolean;
  onImported(session: ImportSession): void;
  /** True while a build or sample load runs, so the page can lock other work. */
  onBusyChange?(busy: boolean): void;
}) {
  const id = useId();
  const [history, setHistory] = useState<LoadedFile | null>(null);
  const [feedback, setFeedback] = useState<LoadedFile | null>(null);
  const [form, setForm] = useState<EconomicsForm>(() => toForm(DEFAULT_ECONOMICS));
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [busyKind, setBusyKind] = useState<BusyKind | null>(null);
  const [reading, setReading] = useState(0);
  // Remounts the file inputs when the sample replaces their files, a file is removed or rejected, so they never show a stale name.
  const [inputsEpoch, setInputsEpoch] = useState(0);
  // Read sequence per file: state, not a ref, because only handlers use it and it must survive renders.
  const [reads] = useState(createReadGuard);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const errorBox = useRef<HTMLDivElement>(null);
  const focusErrors = useRef(false);
  const disabledNow = useRef(disabled);
  const busyChange = useRef(onBusyChange);
  const busy = busyKind !== null;
  const locked = disabled || busy || reading > 0;

  useEffect(() => { disabledNow.current = disabled; busyChange.current = onBusyChange; });
  useEffect(() => () => controller.current?.abort(), []);
  // The cleanup also runs on unmount (a successful import remounts the workspace), so the page is never left locked.
  useEffect(() => {
    if (!busy) return;
    busyChange.current?.(true);
    return () => busyChange.current?.(false);
  }, [busy]);
  useEffect(() => {
    if (focusErrors.current && errors.length) errorBox.current?.focus();
    focusErrors.current = false;
  }, [errors]);

  /** Starts a build or sample load: one at a time, cancelling stale reads and any earlier request. */
  const begin = (kind: BusyKind): AbortController | null => {
    if (inFlight.current || disabled || reading > 0) return null;
    inFlight.current = true;
    reads.invalidate();
    controller.current?.abort();
    controller.current = new AbortController();
    setBusyKind(kind); setErrors([]);
    return controller.current;
  };
  const end = () => { inFlight.current = false; setBusyKind(null); };
  const showErrors = (list: ImportError[]) => { focusErrors.current = true; setErrors(list); };

  const pick = async (source: FileSource, event: ChangeEvent<HTMLInputElement>) => {
    const set = source === "history" ? setHistory : setFeedback;
    const file = event.currentTarget.files?.[0];
    const token = reads.begin(source);
    if (!file) { set(null); return; }
    setReading((n) => n + 1);
    try {
      const loaded = await readLimitedFile(file, source === "history" ? MAX_HISTORY_BYTES : MAX_FEEDBACK_BYTES, source);
      if (!reads.isCurrent(token)) return;
      if ("text" in loaded) { set(loaded); setErrors([]); } else { set(null); setInputsEpoch((n) => n + 1); setErrors([loaded]); }
    } finally { setReading((n) => n - 1); }
  };
  const removeFeedback = () => { reads.invalidate("feedback"); setFeedback(null); setInputsEpoch((n) => n + 1); };
  const loadSample = async () => {
    if (locked || inFlight.current) return;
    const run = begin("sample");
    if (!run) return;
    try {
      const [h, f] = await Promise.all([SAMPLE_FILES.history, SAMPLE_FILES.feedback].map(async (path): Promise<LoadedFile> => {
        const response = await fetch(`/${path}`, { signal: run.signal });
        if (!response.ok) throw new Error(path);
        return { name: path.split("/").pop() ?? path, text: await response.text() };
      }));
      if (run.signal.aborted) return;
      setHistory(h); setFeedback(f); setForm(toForm(SAMPLE_ECONOMICS)); setInputsEpoch((n) => n + 1);
    } catch {
      if (!run.signal.aborted) showErrors([fileError("server", "The sample files could not be loaded.")]);
    } finally { end(); }
  };
  const build = async () => {
    if (locked || inFlight.current) return;
    if (!history) { showErrors([fileError("history", "Choose a history CSV first.")]); return; }
    const run = begin("build");
    if (!run) return;
    try {
      const result = await buildImport({ history: history.text, feedback: feedback?.text ?? null, economics: fromForm(form) }, fetch, { signal: run.signal });
      if (run.signal.aborted) return;
      if (!result.ok) { if (!result.aborted) showErrors(result.errors); return; }
      if (disabledNow.current) { showErrors([fileError("import", "Other work started on the page, so the import was not applied. Build again when it finishes.")]); return; }
      onImported(result.session);
    } catch {
      if (!run.signal.aborted) showErrors([fileError("import", "The import could not be checked. Nothing was changed.")]);
    } finally { end(); }
  };

  const fieldErrors = economicsFieldErrors(errors);
  const field = (key: keyof Economics) => fieldErrors[key]
    ? { "aria-invalid": true as const, "aria-describedby": `${id}-${key}-error` }
    : {};
  const fieldMessage = (key: keyof Economics) => fieldErrors[key] && <span id={`${id}-${key}-error`} className="mt-1 block text-negative">{fieldErrors[key]}</span>;
  // Busy buttons stay focusable (aria-disabled plus an early return in the handlers), so focus is not lost mid-build.
  const softDisabled = (off: boolean) => ({ "aria-disabled": off });

  return (
    <details className="min-w-0 engraved border border-border bg-surface p-5 sm:p-6">
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
          <input key={`history-${inputsEpoch}`} id={`${id}-history`} type="file" accept=".csv,text/csv" disabled={disabled || busy} onChange={(event) => void pick("history", event)} className="mt-1 block w-full min-w-0 text-sm" />
          {history && <p className="mt-1 break-words text-muted">Using {history.name}</p>}
        </div>
        <div className="min-w-0 text-sm">
          <label htmlFor={`${id}-feedback`}>Feedback CSV (optional: up to 200 rows, classified by AI; text is not stored)</label>
          <input key={`feedback-${inputsEpoch}`} id={`${id}-feedback`} type="file" accept=".csv,text/csv" disabled={disabled || busy} onChange={(event) => void pick("feedback", event)} className="mt-1 block w-full min-w-0 text-sm" />
          {feedback && <p className="mt-1 break-words text-muted">Using {feedback.name} <button type="button" disabled={locked} onClick={removeFeedback} className="ml-2 min-h-10 text-brand-accent underline disabled:opacity-50">Remove</button></p>}
        </div>
      </div>
      <fieldset disabled={disabled || busy} className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">Unit economics: merchant-entered assumptions, prefilled with the demo merchant&apos;s numbers</legend>
        {TEXT_FIELDS.map(([key, label]) => (
          <label key={key} className="min-w-0 text-sm">{label}<input value={form[key]} maxLength={80} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={input} {...field(key)} />{fieldMessage(key)}</label>
        ))}
        {NUMBER_FIELDS.map(([key, label]) => (
          <label key={key} className="min-w-0 text-sm">{label}<input type="number" step="any" inputMode="decimal" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={input} {...field(key)} />{fieldMessage(key)}</label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={build} {...softDisabled(locked || !history)} className="min-h-10 rounded-lg btn-gold px-4 py-2 font-semibold aria-disabled:opacity-50">{busyKind === "build" ? "Checking…" : "Build twin"}</button>
        <button type="button" onClick={loadSample} {...softDisabled(locked)} className="min-h-10 rounded-lg border border-border px-4 py-2 hover:border-brand-accent aria-disabled:opacity-50">{busyKind === "sample" ? "Loading…" : "Load sample merchant"}</button>
      </div>
      <p role="status" className="sr-only">{busyKind ? STATUS[busyKind] : reading > 0 ? "Reading the file…" : ""}</p>
      {errors.length > 0 && <ImportErrors ref={errorBox} errors={errors} />}
    </details>
  );
}

export function ImportErrors({ errors, ref }: { errors: ImportError[]; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
      <p className="font-medium">The import was not applied; the current twin is unchanged. Fix these and build again.</p>
      <ul className="mt-2 list-inside list-disc space-y-1 break-words">{errors.map((error, i) => <li key={i}>{formatImportError(error)}</li>)}</ul>
    </div>
  );
}

/** `ref` lets the page move focus here after a merchant switch (`tabIndex -1`: focusable, not in the tab order). */
export function ImportedBanner({ session, disabled, onBack, ref }: { session: ImportSession; disabled: boolean; onBack(): void; ref?: Ref<HTMLElement> }) {
  return (
    <section ref={ref} aria-label="Imported merchant" tabIndex={-1} className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/50 bg-surface p-4 text-sm">
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
    <section aria-labelledby="demo-only-title" className="mb-6 min-w-0 engraved border border-border bg-surface p-5 text-sm sm:p-6">
      <h2 id="demo-only-title" className="text-lg font-semibold">Approval, pilots, annual offers and recovery</h2>
      <p className="mt-2 text-muted">{DEMO_ONLY_MESSAGE} Go back to Ridgeline to prepare, approve or recover PayPal Sandbox actions.</p>
    </section>
  );
}

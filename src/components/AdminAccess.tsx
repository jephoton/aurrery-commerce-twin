"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import type { AccessState } from "./admin-access";

export function AdminAccess({ state, onChange }: { state: AccessState | null; onChange: (state: AccessState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state && !state.hosted) return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    form.reset();
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Try again later." : "Sign-in failed.");
      onChange(await response.json() as AccessState);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Sign-out failed.");
      onChange(await response.json() as AccessState);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-label="Administrator access" className="mb-5 rounded-xl border border-border bg-surface p-4 text-sm">
    <p className="font-semibold">Administrator access</p>
    {!state ? <p role="status" className="text-muted">Checking access…</p> : state.authenticated ? <div className="mt-2 flex items-center gap-3"><span>Signed in for merchant decisions.</span><button type="button" disabled={busy} onClick={logout} className="min-h-10 rounded border border-border px-3 disabled:opacity-50">Sign out</button></div> : <>
      <p className="mt-1 text-muted">Visitors can explore this synthetic demo. Merchant approval and rejection require sign-in.</p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">Administrator password<input name="password" type="password" autoComplete="current-password" required maxLength={1024} className="min-h-10 rounded border border-border bg-background px-3" /></label>
        <button disabled={busy} className="min-h-10 rounded bg-brand px-4 font-semibold text-background disabled:opacity-50">Sign in</button>
      </form>
    </>}
    {error && <p role="alert" className="mt-2 text-negative">{error}</p>}
  </section>;
}

import "server-only";
import { now } from "./db";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor } from "./connection";

/** Every authority-changing transaction checks enforcement on its own write handle. */
export async function authoritativeWrite<T>(connection: LedgerConnection, work: (tx: LedgerExecutor) => Promise<T>): Promise<T> {
  return connection.transaction(async (tx) => {
    const enabled = await tx.query("PRAGMA foreign_keys");
    if (enabled.length !== 1 || Number(enabled[0].foreign_keys) !== 1) throw new Error("Ledger foreign key enforcement is unavailable");
    return work(tx);
  });
}

export async function getSetting(key: string): Promise<string | null> {
  const connection = await runtimeLedgerConnection();
  return authoritativeWrite(connection, async (tx) => {
    const rows = await tx.query("SELECT value FROM kv WHERE key = ?", [key]);
    return rows[0] ? String(rows[0].value) : null;
  });
}

export async function setSetting(key: string, value: string): Promise<void> {
  const connection = await runtimeLedgerConnection();
  await authoritativeWrite(connection, async (tx) => {
    await tx.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, value]);
  });
}

export async function auditOn(tx: LedgerExecutor, kind: string, proposalId: string | null, detail: unknown): Promise<void> {
  await tx.execute("INSERT INTO audit_events (at, kind, proposal_id, detail_json) VALUES (?, ?, ?, ?)", [now(), kind, proposalId, JSON.stringify(detail ?? null)]);
}

export async function audit(kind: string, proposalId: string | null, detail: unknown): Promise<void> {
  const connection = await runtimeLedgerConnection();
  await authoritativeWrite(connection, (tx) => auditOn(tx, kind, proposalId, detail));
}

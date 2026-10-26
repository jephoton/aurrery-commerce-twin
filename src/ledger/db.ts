import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Durable record of decisions, approvals, PayPal executions, and observed outcomes.

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS sandbox_subscribers (
  subscription_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  segment TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'other',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  objective TEXT,
  strategy_json TEXT NOT NULL,
  simulation_json TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_json TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','executing','succeeded','partially_failed','failed','rejected')),
  approved_at TEXT,
  approved_by TEXT,
  completed_at TEXT,
  revert_after TEXT
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  debug_id TEXT,
  response_json TEXT,
  verified INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, target_id, operation)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  regular_price TEXT,
  plan_overridden INTEGER,
  last_payment_json TEXT,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  proposal_id TEXT,
  detail_json TEXT
);
`;

let db: DatabaseSync | null = null;

export function ledger(): DatabaseSync {
  if (!db) {
    const path = process.env.LEDGER_PATH ?? resolve(process.cwd(), "data", "ledger.sqlite");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(LEDGER_SCHEMA);
    // Ledgers created before pilot reasons existed.
    const columns = db.prepare("PRAGMA table_info(sandbox_subscribers)").all().map((c) => String(c.name));
    if (!columns.includes("reason")) db.exec("ALTER TABLE sandbox_subscribers ADD COLUMN reason TEXT NOT NULL DEFAULT 'other'");
  }
  return db;
}

export const now = () => new Date().toISOString();

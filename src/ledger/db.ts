import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Durable record of decisions, approvals, PayPal executions, and observed outcomes.

export const HOSTED_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosted_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  password_fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hosted_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

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
CREATE TABLE IF NOT EXISTS active_target_claims (
  target_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  claimed_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  subscription_id TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('observed','ignored')),
  ignored_reason TEXT,
  observation_id INTEGER UNIQUE REFERENCES observations(id),
  CHECK ((disposition = 'observed' AND observation_id IS NOT NULL AND ignored_reason IS NULL) OR
         (disposition = 'ignored' AND observation_id IS NULL AND ignored_reason IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS discount_episodes (
  execution_id INTEGER PRIMARY KEY REFERENCES executions(id),
  start_observation_id INTEGER NOT NULL UNIQUE REFERENCES observations(id),
  subscription_id TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('new','core','price_sensitive','at_risk','cancel_intent')),
  reason TEXT NOT NULL CHECK (reason IN ('price','other')),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  discounted_price TEXT NOT NULL,
  CHECK (ends_at > started_at)
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
CREATE TABLE IF NOT EXISTS feedback_prediction_cache (
  cache_key TEXT PRIMARY KEY,
  prediction_json TEXT NOT NULL
);
${HOSTED_SCHEMA}
`;

let db: DatabaseSync | null = null;

export function ledger(): DatabaseSync {
  if (process.env.LEDGER_BACKEND === "turso" || process.env.RENDER === "true") throw new Error("Raw local ledger access is unavailable for hosted storage");
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

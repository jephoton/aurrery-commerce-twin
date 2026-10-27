import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { LedgerConnection } from "@/ledger/connection";
import { HOSTED_SCHEMA } from "@/ledger/db";
import { authoritativeWrite } from "@/ledger/operations";

export type LimitKind = "agent" | "preparation" | "poll" | "login" | "webhook";
type Limit = { scope: "client" | "global"; max: number; windowMs: number };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS: Record<LimitKind, Limit[]> = {
  agent: [{ scope: "client", max: 3, windowMs: HOUR }, { scope: "global", max: 6, windowMs: HOUR }, { scope: "global", max: 20, windowMs: DAY }],
  preparation: [{ scope: "client", max: 30, windowMs: HOUR }, { scope: "global", max: 60, windowMs: HOUR }],
  poll: [{ scope: "client", max: 30, windowMs: HOUR }, { scope: "global", max: 60, windowMs: HOUR }],
  login: [{ scope: "client", max: 5, windowMs: 15 * 60 * 1000 }, { scope: "global", max: 30, windowMs: 15 * 60 * 1000 }],
  webhook: [{ scope: "global", max: 30, windowMs: 60 * 1000 }, { scope: "global", max: 1200, windowMs: DAY }],
};
export const limitsFor = (kind: LimitKind): Limit[] => LIMITS[kind];

const SESSION_MS = 2 * HOUR;
const hostedSchemaReady = new WeakMap<LedgerConnection, Promise<void>>();
function ensureHostedSchema(db: LedgerConnection): Promise<void> {
  const existing = hostedSchemaReady.get(db);
  if (existing) return existing;
  const pending = db.executeMultiple(HOSTED_SCHEMA);
  const ready = pending.catch((error: unknown) => {
    if (hostedSchemaReady.get(db) === ready) hostedSchemaReady.delete(db);
    throw error;
  });
  hostedSchemaReady.set(db, ready);
  return ready;
}
export function createHostingStore(db: LedgerConnection, secret: string) {
  // DDL is idempotent and intentionally outside a write transaction. Every
  // subsequent authority operation uses its own checked write handle.
  const hmac = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
  const verifyPassword = (supplied: string, expected: string) => {
    const actual = createHash("sha256").update(supplied).digest();
    const target = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actual, target);
  };
  return {
    verifyPassword,
    async createSession(password: string, at = Date.now()): Promise<string> {
      await ensureHostedSchema(db);
      const token = randomBytes(32).toString("base64url");
      await authoritativeWrite(db, async (tx) => {
        await tx.execute("INSERT INTO hosted_sessions (token_hash, expires_at, password_fingerprint) VALUES (?, ?, ?)", [tokenHash(token), at + SESSION_MS, hmac(password)]);
      });
      return token;
    },
    async isSessionValid(token: string | null, password: string, at = Date.now()): Promise<boolean> {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      await ensureHostedSchema(db);
      return authoritativeWrite(db, async (tx) => {
        const rows = await tx.query("SELECT expires_at, password_fingerprint FROM hosted_sessions WHERE token_hash = ?", [tokenHash(token)]);
        const row = rows[0];
        if (!row || Number(row.expires_at) <= at) return false;
        const actual = Buffer.from(String(row.password_fingerprint), "hex");
        const expected = Buffer.from(hmac(password), "hex");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
    },
    async revokeSession(token: string | null): Promise<void> {
      if (!token) return;
      await ensureHostedSchema(db);
      await authoritativeWrite(db, async (tx) => {
        await tx.execute("DELETE FROM hosted_sessions WHERE token_hash = ?", [tokenHash(token)]);
      });
    },
    async admit(kind: LimitKind, client: string, at = Date.now()): Promise<{ allowed: boolean; retryAfter?: number }> {
      await ensureHostedSchema(db);
      return authoritativeWrite(db, async (tx) => {
        await tx.execute("DELETE FROM hosted_limits WHERE expires_at <= ?", [at]);
        await tx.execute("DELETE FROM hosted_sessions WHERE expires_at <= ?", [at]);
        const buckets: { key: string; count: number; max: number; end: number }[] = [];
        for (const { scope, max, windowMs } of LIMITS[kind]) {
          const start = Math.floor(at / windowMs) * windowMs;
          const key = hmac(`${kind}:${scope}:${windowMs}:${start}:${scope === "client" ? client : "all"}`);
          const existing = await tx.query("SELECT count FROM hosted_limits WHERE bucket_key = ?", [key]);
          buckets.push({ key, count: Number(existing[0]?.count ?? 0), max, end: start + windowMs });
        }
        const blocked = buckets.filter((b) => b.count >= b.max);
        if (blocked.length) return { allowed: false, retryAfter: Math.max(1, Math.ceil(Math.max(...blocked.map((b) => b.end - at)) / 1000)) };
        for (const b of buckets) await tx.execute("INSERT INTO hosted_limits (bucket_key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1", [b.key, b.end]);
        return { allowed: true };
      });
    },
  };
}

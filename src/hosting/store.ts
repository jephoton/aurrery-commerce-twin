import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type LimitKind = "agent" | "preparation" | "poll" | "login";
type Limit = { scope: "client" | "global"; max: number; windowMs: number };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS: Record<LimitKind, Limit[]> = {
  agent: [{ scope: "client", max: 3, windowMs: HOUR }, { scope: "global", max: 6, windowMs: HOUR }, { scope: "global", max: 20, windowMs: DAY }],
  preparation: [{ scope: "client", max: 30, windowMs: HOUR }, { scope: "global", max: 60, windowMs: HOUR }],
  poll: [{ scope: "client", max: 30, windowMs: HOUR }, { scope: "global", max: 60, windowMs: HOUR }],
  login: [{ scope: "client", max: 5, windowMs: 15 * 60 * 1000 }, { scope: "global", max: 30, windowMs: 15 * 60 * 1000 }],
};
export const limitsFor = (kind: LimitKind): Limit[] => LIMITS[kind];

const SESSION_MS = 2 * HOUR;
export function createHostingStore(db: DatabaseSync, secret: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS hosted_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, password_fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hosted_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  const hmac = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
  const verifyPassword = (supplied: string, expected: string) => {
    const actual = createHash("sha256").update(supplied).digest();
    const target = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actual, target);
  };
  return {
    verifyPassword,
    createSession(password: string, at = Date.now()): string {
      const token = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO hosted_sessions (token_hash, expires_at, password_fingerprint) VALUES (?, ?, ?)").run(tokenHash(token), at + SESSION_MS, hmac(password));
      return token;
    },
    isSessionValid(token: string | null, password: string, at = Date.now()): boolean {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const row = db.prepare("SELECT expires_at, password_fingerprint FROM hosted_sessions WHERE token_hash = ?").get(tokenHash(token));
      if (!row || Number(row.expires_at) <= at) return false;
      const actual = Buffer.from(String(row.password_fingerprint), "hex");
      const expected = Buffer.from(hmac(password), "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    revokeSession(token: string | null) { if (token) db.prepare("DELETE FROM hosted_sessions WHERE token_hash = ?").run(tokenHash(token)); },
    admit(kind: LimitKind, client: string, at = Date.now()): { allowed: boolean; retryAfter?: number } {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM hosted_limits WHERE expires_at <= ?").run(at);
        db.prepare("DELETE FROM hosted_sessions WHERE expires_at <= ?").run(at);
        const buckets = LIMITS[kind].map(({ scope, max, windowMs }) => {
          const start = Math.floor(at / windowMs) * windowMs;
          const key = hmac(`${kind}:${scope}:${windowMs}:${start}:${scope === "client" ? client : "all"}`);
          const existing = db.prepare("SELECT count FROM hosted_limits WHERE bucket_key = ?").get(key);
          return { key, count: Number(existing?.count ?? 0), max, end: start + windowMs };
        });
        const blocked = buckets.filter((b) => b.count >= b.max);
        if (blocked.length) { db.exec("COMMIT"); return { allowed: false, retryAfter: Math.max(1, Math.ceil(Math.max(...blocked.map((b) => b.end - at)) / 1000)) }; }
        const upsert = db.prepare("INSERT INTO hosted_limits (bucket_key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1");
        for (const b of buckets) upsert.run(b.key, b.end);
        db.exec("COMMIT"); return { allowed: true };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

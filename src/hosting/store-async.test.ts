import { afterAll, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createClient } from "@libsql/client";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { createHostingStore } from "./store";

const secret = "s".repeat(48);
const password = "p".repeat(40);
const directories: string[] = [];
// The native libSQL file driver can retain a Windows handle until process exit.
afterAll(() => { for (const directory of directories) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Released at process exit. */ } } });
function path() { const directory = mkdtempSync(join(tmpdir(), "aurrery-hosted-async-")); directories.push(directory); return join(directory, "ledger.sqlite"); }

it("does not start schema work for missing tokens and awaits schema errors on real operations", async () => {
  const db = new DatabaseSync(path());
  try {
    const connection = createLocalConnection(db);
    const ddl = vi.fn(async () => { throw new Error("schema unavailable"); });
    const store = createHostingStore({ ...connection, executeMultiple: ddl }, secret);
    expect(await store.isSessionValid(null, password)).toBe(false);
    await store.revokeSession(null);
    expect(ddl).not.toHaveBeenCalled();
    await expect(store.admit("login", "shared", 1_000)).rejects.toThrow("schema unavailable");
    expect(ddl).toHaveBeenCalledOnce();
  } finally { db.close(); }
});

it("initializes hosted tables once per connection and retries only a later failed initialization", async () => {
  const db = new DatabaseSync(path());
  try {
    const connection = createLocalConnection(db);
    await initializeLedgerSchema(connection);
    const ddl = vi.fn().mockRejectedValueOnce(new Error("transient DDL failure")).mockImplementation((sql: string) => connection.executeMultiple(sql));
    const wrapped = { ...connection, executeMultiple: ddl };
    await expect(createHostingStore(wrapped, secret).createSession(password)).rejects.toThrow("transient DDL failure");
    const first = createHostingStore(wrapped, secret);
    const second = createHostingStore(wrapped, secret);
    const token = await first.createSession(password);
    expect(await second.isSessionValid(token, password)).toBe(true);
    expect(ddl).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

it("rolls back expiry cleanup and all quota writes when a bucket insert fails", async () => {
  const db = new DatabaseSync(path());
  try {
    const connection = createLocalConnection(db);
    await initializeLedgerSchema(connection);
    const store = createHostingStore(connection, secret);
    await store.admit("agent", "seed", 1_000);
    db.prepare("INSERT INTO hosted_limits (bucket_key, count, expires_at) VALUES (?, ?, ?)").run("expired-row", 1, 1_500);
    db.prepare("INSERT INTO hosted_sessions (token_hash, expires_at, password_fingerprint) VALUES (?, ?, ?)").run("expired-session", 1_500, "fingerprint");
    db.exec("CREATE TRIGGER fail_new_bucket BEFORE INSERT ON hosted_limits BEGIN SELECT RAISE(ABORT, 'bucket insert failed'); END;");
    await expect(store.admit("agent", "fresh", 2_000)).rejects.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM hosted_limits WHERE bucket_key = 'expired-row'").get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM hosted_sessions WHERE token_hash = 'expired-session'").get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM hosted_limits").get()?.n).toBe(4);
  } finally { db.close(); }
});

it.each(["sqlite", "libsql"])("admits only the allowed count across two %s connections and persists revocation", async (backend) => {
  const file = path();
  let persistedToken = "";
  const clients = backend === "sqlite"
    ? [new DatabaseSync(file), new DatabaseSync(file)]
    : [createClient({ url: `file:${file}` }), createClient({ url: `file:${file}` })];
  try {
    const connections = backend === "sqlite"
      ? (clients as DatabaseSync[]).map(createLocalConnection)
      : (clients as ReturnType<typeof createClient>[]).map(createLibsqlConnection);
    await initializeLedgerSchema(connections[0]);
    await initializeLedgerSchema(connections[1]);
    await Promise.all(connections.map((connection) => connection.executeMultiple("PRAGMA busy_timeout = 5000;")));
    const stores = connections.map((connection) => createHostingStore(connection, secret));
    const attempts = [];
    for (let i = 0; i < 12; i++) attempts.push(await stores[i % 2].admit("agent", `client-${i}`, 1_000));
    expect(attempts.filter((result) => result.allowed)).toHaveLength(6);
    const token = await stores[0].createSession(password, 1_000);
    expect(await stores[1].isSessionValid(token, password, 1_001)).toBe(true);
    await stores[0].revokeSession(token);
    expect(await stores[1].isSessionValid(token, password, 1_001)).toBe(false);
    persistedToken = await stores[1].createSession(password, 1_000);
    expect((await stores[1].admit("agent", "new-client", 1_001)).allowed).toBe(false);
  } finally { for (const client of clients) client.close(); }
  const reopened = backend === "sqlite" ? new DatabaseSync(file) : createClient({ url: `file:${file}` });
  try {
    const connection = reopened instanceof DatabaseSync ? createLocalConnection(reopened) : createLibsqlConnection(reopened);
    const store = createHostingStore(connection, secret);
    expect(await store.isSessionValid(persistedToken, password, 1_001)).toBe(true);
    expect((await store.admit("agent", "restart-client", 1_001)).allowed).toBe(false);
    await store.revokeSession(persistedToken);
    expect(await store.isSessionValid(persistedToken, password, 1_001)).toBe(false);
  } finally { reopened.close(); }
});

it.each(["sqlite", "libsql"])("fails closed under simultaneous %s file-client contention without exceeding the quota", async (backend) => {
  const file = path();
  const clients = backend === "sqlite"
    ? [new DatabaseSync(file), new DatabaseSync(file)]
    : [createClient({ url: `file:${file}` }), createClient({ url: `file:${file}` })];
  let firstAdmitted = 0;
  try {
    const connections = backend === "sqlite"
      ? (clients as DatabaseSync[]).map(createLocalConnection)
      : (clients as ReturnType<typeof createClient>[]).map(createLibsqlConnection);
    await initializeLedgerSchema(connections[0]);
    await initializeLedgerSchema(connections[1]);
    const stores = connections.map((connection) => createHostingStore(connection, secret));
    await stores[0].isSessionValid("A".repeat(43), password, 1_000);
    await stores[1].isSessionValid("A".repeat(43), password, 1_000);
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => stores[i % 2].admit("agent", `contender-${i}`, 1_000)));
    if (backend === "sqlite") expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
    firstAdmitted = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value.allowed).length;
    expect(firstAdmitted).toBeGreaterThan(0);
    expect(firstAdmitted).toBeLessThanOrEqual(6);
  } finally { for (const client of clients) client.close(); }
  const observer = new DatabaseSync(file);
  try {
    const store = createHostingStore(createLocalConnection(observer), secret);
    const key = (scope: string, windowMs: number, client = "all") => createHmac("sha256", secret)
      .update(`agent:${scope}:${windowMs}:0:${client}`).digest("hex");
    const count = (bucketKey: string) => Number(observer.prepare("SELECT count FROM hosted_limits WHERE bucket_key = ?").get(bucketKey)?.count ?? 0);
    expect(count(key("global", 3_600_000))).toBe(firstAdmitted);
    expect(count(key("global", 86_400_000))).toBe(firstAdmitted);
    expect(Number(observer.prepare("SELECT count(*) AS n FROM hosted_limits").get()?.n)).toBe(firstAdmitted + 2);
    expect(Array.from({ length: 8 }, (_, i) => count(key("client", 3_600_000, `contender-${i}`))).reduce((sum, value) => sum + value, 0)).toBe(firstAdmitted);
    let laterAdmitted = 0;
    for (let i = 0; i < 8; i++) if ((await store.admit("agent", `later-${i}`, 1_000)).allowed) laterAdmitted++;
    expect(firstAdmitted + laterAdmitted).toBe(6);
    expect(count(key("global", 3_600_000))).toBe(6);
    expect(count(key("global", 86_400_000))).toBe(6);
    expect((await store.admit("agent", "one-more", 1_001)).allowed).toBe(false);
  } finally { observer.close(); }
});

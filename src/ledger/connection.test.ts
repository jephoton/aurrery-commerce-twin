import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createLibsqlConnection,
  createLocalConnection,
  createRuntimeLedgerConnection,
  createTursoFetch,
  initializeLedgerSchema,
  validateTursoUrl,
} from "./connection";

it("passes parameter bindings as one statement to HTTP transactions", async () => {
  const execute = vi.fn(async () => ({ rows: [], rowsAffected: 1 }));
  const transaction = { execute, commit: vi.fn(), rollback: vi.fn(), close: vi.fn() };
  const client = { transaction: vi.fn(async () => transaction) } as unknown as Client;
  const connection = createLibsqlConnection(client);
  await connection.transaction(async tx => {
    await tx.execute("INSERT INTO kv (key,value) VALUES (?,?)", ["bound-key", "bound-value"]);
    await tx.query("SELECT value FROM kv WHERE key=?", ["bound-key"]);
  });
  expect(execute.mock.calls).toEqual([
    [{ sql: "INSERT INTO kv (key,value) VALUES (?,?)", args: ["bound-key", "bound-value"] }],
    [{ sql: "SELECT value FROM kv WHERE key=?", args: ["bound-key"] }],
  ]);
  expect(transaction.commit).toHaveBeenCalledOnce();
});

it("accepts regional Turso hosts while rejecting lookalike domains and extra URL components", () => {
  for (const url of ["libsql://demo.aws-ap-southeast-1.turso.io", "https://demo.aws-ap-southeast-1.turso.io"]) {
    expect(validateTursoUrl(url)).toBe(url);
  }
  for (const url of [
    "https://demo.aws-ap-southeast-1.turso.io.evil.example",
    "https://demo.aws-ap-southeast-1.turso.io@evil.example",
    "https://demo.aws-ap-southeast-1.turso.io?tls=0",
    "https://demo.aws-ap-southeast-1.turso.io:444",
    "https://demo.aws-ap-southeast-1.turso.io/path",
    "http://demo.aws-ap-southeast-1.turso.io",
  ]) expect(() => validateTursoUrl(url)).toThrow("Invalid ledger configuration");
});

const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-storage-"));
  dirs.push(dir);
  return join(dir, "ledger.sqlite");
};
// The native libSQL file driver can retain a Windows handle until process exit.
afterAll(() => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS releases native handles at exit. */ } } });

const fixtures = [
  { name: "Node SQLite", open: (path: string) => { const db = new DatabaseSync(path); return { connection: createLocalConnection(db), close: () => db.close() }; } },
  { name: "libSQL file", open: (path: string) => { const client = createClient({ url: `file:${path}` }); return { connection: createLibsqlConnection(client), close: () => client.close() }; } },
];

for (const fixture of fixtures) describe(fixture.name, () => {
  it("migrates legacy subscriber reasons idempotently", async () => {
    const { connection, close } = fixture.open(tempPath());
    try {
      await connection.executeMultiple("CREATE TABLE sandbox_subscribers (subscription_id TEXT PRIMARY KEY, label TEXT NOT NULL, segment TEXT NOT NULL, created_at TEXT NOT NULL)");
      await connection.execute("INSERT INTO sandbox_subscribers (subscription_id, label, segment, created_at) VALUES ('s', 'Pilot', 'core', 'now')");
      await initializeLedgerSchema(connection);
      await initializeLedgerSchema(connection);
      expect(await connection.query("SELECT reason FROM sandbox_subscribers WHERE subscription_id = 's'")).toEqual([{ reason: "other" }]);
    } finally { close(); }
  });
  it("preserves null, number, text and binary SQLite values", async () => {
    const { connection, close } = fixture.open(tempPath());
    try {
      await connection.executeMultiple("CREATE TABLE values_test (a BLOB, b INTEGER, c TEXT, d TEXT)");
      await connection.execute("INSERT INTO values_test (a, b, c, d) VALUES (?, ?, ?, ?)", [new Uint8Array([0, 127, 255]), 42, "hello", null]);
      expect(await connection.query("SELECT a, b, c, d FROM values_test")).toEqual([{
        a: new Uint8Array([0, 127, 255]), b: 42, c: "hello", d: null,
      }]);
    } finally { close(); }
  });
  it("reports direct statement changes instead of trigger side effects", async () => {
    const { connection, close } = fixture.open(tempPath());
    try {
      await connection.executeMultiple(`CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE audit (id INTEGER PRIMARY KEY, value TEXT);
        CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN INSERT INTO audit (value) VALUES (new.value); END;`);
      const inserted = await connection.execute("INSERT INTO source (value) VALUES ('one')");
      expect(inserted.rowsAffected).toBe(1);
      expect(inserted.lastInsertRowid).toBe(BigInt(1));
      expect(await connection.query("SELECT COUNT(*) AS n FROM audit")).toEqual([{ n: 1 }]);
      expect((await connection.execute("SELECT * FROM source")).rowsAffected).toBe(0);
    } finally { close(); }
  });
  it("reads, writes, preserves SQLite constraints and affected rows", async () => {
    const { connection, close } = fixture.open(tempPath());
    try {
      await initializeLedgerSchema(connection);
      const insert = await connection.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ["key", "first"]);
      expect(insert.rowsAffected).toBe(1);
      expect(await connection.query("SELECT value FROM kv WHERE key = ?", ["key"])).toEqual([{ value: "first" }]);
      expect((await connection.execute("UPDATE kv SET value = ? WHERE key = ?", ["second", "key"])).rowsAffected).toBe(1);
      expect((await connection.execute("UPDATE kv SET value = ? WHERE key = ?", ["no", "absent"])).rowsAffected).toBe(0);
      await expect(connection.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ["key", "duplicate"])).rejects.toThrow();
      await expect(connection.execute("INSERT INTO proposals (id, created_at, strategy_json, simulation_json, action_type, action_json, action_hash, status) VALUES ('p', 'now', '{}', '{}', 'price', '{}', 'hash', 'wrong')")).rejects.toThrow();
      await expect(connection.execute("INSERT INTO executions (proposal_id, target_id, operation, request_json, ok, created_at) VALUES ('missing', 'target', 'op', '{}', 1, 'now')")).rejects.toThrow();
    } finally { close(); }
  });

  it("rolls back failed callbacks and persists committed rows after restart", async () => {
    const path = tempPath();
    const first = fixture.open(path);
    await initializeLedgerSchema(first.connection);
    await expect(first.connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO kv (key, value) VALUES ('rolled', 'back')");
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await first.connection.query("SELECT key FROM kv WHERE key = 'rolled'")).toEqual([]);
    await first.connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO kv (key, value) VALUES ('saved', 'yes')");
    });
    first.close();
    const second = fixture.open(path);
    try {
      await initializeLedgerSchema(second.connection);
      expect(await second.connection.query("SELECT value FROM kv WHERE key = 'saved'")).toEqual([{ value: "yes" }]);
      expect(await second.connection.query("SELECT key FROM kv WHERE key = 'rolled'")).toEqual([]);
    } finally { second.close(); }
  });

  it("allows only one competing conditional claim", async () => {
    const { connection, close } = fixture.open(tempPath());
    try {
      await initializeLedgerSchema(connection);
      await connection.execute("INSERT INTO proposals (id, created_at, strategy_json, simulation_json, action_type, action_json, action_hash, status) VALUES ('p', 'now', '{}', '{}', 'price', '{}', 'hash', 'approved')");
      const claims = await Promise.all([1, 2].map(() => connection.transaction(async (tx) =>
        (await tx.execute("UPDATE proposals SET status = 'executing' WHERE id = 'p' AND status = 'approved'")).rowsAffected,
      )));
      expect(claims.sort()).toEqual([0, 1]);
      expect(await connection.query("SELECT status FROM proposals WHERE id = 'p'")).toEqual([{ status: "executing" }]);
    } finally { close(); }
  });
});

it("serializes an unrelated local query until the transaction commits", async () => {
  const db = new DatabaseSync(tempPath());
  const connection = createLocalConnection(db);
  try {
    await initializeLedgerSchema(connection);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const tx = connection.transaction(async (handle) => {
      await handle.execute("INSERT INTO kv (key, value) VALUES ('pending', 'yes')");
      entered();
      await pause;
    });
    await started;
    let settled = false;
    const outside = connection.query("SELECT value FROM kv WHERE key = 'pending'").then((rows) => { settled = true; return rows; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await tx;
    expect(await outside).toEqual([{ value: "yes" }]);
  } finally { db.close(); }
});

it("releases the local mutex after a failed transaction", async () => {
  const db = new DatabaseSync(tempPath());
  const connection = createLocalConnection(db);
  try {
    await initializeLedgerSchema(connection);
    await expect(connection.transaction(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect((await connection.execute("INSERT INTO kv (key, value) VALUES ('after', 'yes')")).rowsAffected).toBe(1);
  } finally { db.close(); }
});

it("shares the local transaction queue across separately loaded module copies", async () => {
  const db = new DatabaseSync(tempPath());
  const first = createLocalConnection(db);
  vi.resetModules();
  const { createLocalConnection: loadAgain } = await import("./connection");
  const second = loadAgain(db);
  try {
    await initializeLedgerSchema(first);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const transaction = first.transaction(async (tx) => {
      await tx.execute("INSERT INTO kv (key, value) VALUES ('copy', 'pending')");
      entered();
      await pause;
    });
    await started;
    let returned = false;
    const outside = second.query("SELECT value FROM kv WHERE key = 'copy'").then((rows) => { returned = true; return rows; });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await transaction;
    expect(await outside).toEqual([{ value: "pending" }]);
  } finally { db.close(); }
});

it("requires an explicit remote selection and rejects incomplete or unsafe remote settings", async () => {
  const db = new DatabaseSync(tempPath());
  try {
    const local = await createRuntimeLedgerConnection({ env: { LEDGER_BACKEND: "sqlite", TURSO_DATABASE_URL: "https://example.turso.io" }, localDatabase: db });
    expect((await local.execute("INSERT INTO kv (key, value) VALUES ('local', 'yes')")).rowsAffected).toBe(1);
    for (const env of [
      { LEDGER_BACKEND: "turso" },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io" },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://example.turso.io", TURSO_AUTH_TOKEN: "  " },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://example.turso.io", TURSO_AUTH_TOKEN: "token", RENDER: "true", LEDGER_PATH: "/var/data/ledger.sqlite" },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://evil.example/path", TURSO_AUTH_TOKEN: "token" },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://u:p@example.turso.io", TURSO_AUTH_TOKEN: "token" },
      { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://example.turso.io?tls=0", TURSO_AUTH_TOKEN: "token" },
      { LEDGER_BACKEND: "unknown" },
      { LEDGER_BACKEND: "sqlite", RENDER: "true" },
    ]) await expect(createRuntimeLedgerConnection({ env, localDatabase: db })).rejects.toThrow(/Invalid ledger configuration/);
  } finally { db.close(); }
});

it("bounds injected remote HTTP and redacts transport details without local fallback", async () => {
  const local = new DatabaseSync(tempPath());
  const secret = "top-secret-token";
  const url = "https://example.turso.io";
  const fetch = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error(`failure ${secret} ${url}`)), { once: true });
  }));
  try {
    let error: unknown;
    try { await createRuntimeLedgerConnection({
      env: { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: secret },
      localDatabase: local,
      fetch,
      timeoutMs: 20,
    }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/Storage request failed/);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(url);
    expect(fetch).toHaveBeenCalled();
    expect(local.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'kv'").get()?.n).toBe(0);
  } finally { local.close(); }
});

it("redacts an injected remote authentication failure", async () => {
  const secret = "top-secret-token";
  const url = "https://example.turso.io";
  const fetch = vi.fn(async () => new Response(`unauthorized ${secret} ${url}`, { status: 401 }));
  await expect(createRuntimeLedgerConnection({
    env: { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: secret },
    fetch,
  })).rejects.toThrow(/^Storage request failed$/);
  expect(fetch).toHaveBeenCalled();
});

it("accepts a normal libsql URL without a trailing slash", async () => {
  const client = createClient({ url: `file:${tempPath()}` });
  try {
    const connection = await createRuntimeLedgerConnection({
      env: { LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "token" },
      remoteClient: client,
    });
    expect((await connection.execute("INSERT INTO kv (key, value) VALUES ('remote', 'selected')")).rowsAffected).toBe(1);
  } finally { client.close(); }
});

it("keeps the remote deadline active through a stalled response body", async () => {
  const transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
  })));
  const bounded = createTursoFetch("example.turso.io", transport, 20);
  await expect(bounded("https://example.turso.io/v2/pipeline")).rejects.toThrow("Storage request failed");
  expect(transport).toHaveBeenCalledOnce();
});

it("aborts and cancels a declared oversized response body", async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe("https://example.turso.io/v2/pipeline");
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: { "Content-Length": String(16 * 1024 * 1024 + 1) } });
  });
  const bounded = createTursoFetch("example.turso.io", transport, 1_000);
  await expect(bounded("https://example.turso.io/v2/pipeline")).rejects.toThrow("Storage request failed");
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

it("aborts and cancels a streamed response once it exceeds the size limit", async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe("https://example.turso.io/v2/pipeline");
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
  });
  const bounded = createTursoFetch("example.turso.io", transport, 1_000);
  await expect(bounded("https://example.turso.io/v2/pipeline")).rejects.toThrow("Storage request failed");
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

it("rejects an SDK fetch outside the selected Turso host and propagates caller abort", async () => {
  const transport = vi.fn(async () => new Promise<Response>(() => {}));
  const bounded = createTursoFetch("example.turso.io", transport, 1_000);
  await expect(bounded("https://attacker.example/v2/pipeline")).rejects.toThrow("Storage request failed");
  expect(transport).not.toHaveBeenCalled();
  const controller = new AbortController();
  const pending = bounded(new Request("https://example.turso.io/v2/pipeline", { signal: controller.signal }));
  controller.abort();
  await expect(pending).rejects.toThrow("Storage request failed");
  expect(transport).toHaveBeenCalledOnce();
});

it("shares one initialization attempt then permits a later request after rejection", async () => {
  vi.resetModules();
  const { runtimeLedgerConnection: runtime } = await import("./connection");
  const db = new DatabaseSync(tempPath());
  const connection = createLocalConnection(db);
  let fail!: (reason: Error) => void;
  const first = new Promise<typeof connection>((_resolve, reject) => { fail = reject; });
  const factory = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(connection);
  try {
    const attempts = [runtime(factory), runtime(factory)];
    await Promise.resolve();
    expect(factory).toHaveBeenCalledOnce();
    fail(new Error("first initialization failed"));
    await Promise.all(attempts.map((attempt) => expect(attempt).rejects.toThrow("first initialization failed")));
    expect(await runtime(factory)).toBe(connection);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await runtime(factory)).toBe(connection);
    expect(factory).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

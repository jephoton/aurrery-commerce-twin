import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client/http";
import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";
import { LEDGER_SCHEMA, ledger } from "./db";

/** Positional SQLite values accepted by both the Node and libSQL clients. */
export type LedgerValue = null | string | number | bigint | Uint8Array;
export type LedgerRow = Record<string, LedgerValue>;
export type LedgerResult = { rows: LedgerRow[]; rowsAffected: number; lastInsertRowid?: bigint };
export type LedgerExecutor = {
  execute(sql: string, args?: readonly LedgerValue[]): Promise<LedgerResult>;
  query(sql: string, args?: readonly LedgerValue[]): Promise<LedgerRow[]>;
  executeMultiple(sql: string): Promise<void>;
};
export type LedgerConnection = LedgerExecutor & {
  transaction<T>(callback: (tx: LedgerExecutor) => Promise<T>): Promise<T>;
};

/** Remote failures have deliberately fixed text; SDK errors can contain the URL or token. */
export class LedgerStorageError extends Error {
  constructor() { super("Storage request failed"); this.name = "LedgerStorageError"; }
}

function localExecute(db: DatabaseSync, sql: string, args: readonly LedgerValue[] = []): LedgerResult {
  const before = Number(db.prepare("SELECT total_changes() AS count").get()!.count);
  const rows = db.prepare(sql).all(...args).map((row) => ({ ...row } as LedgerRow));
  const after = Number(db.prepare("SELECT total_changes() AS count").get()!.count);
  // total_changes detects a write; changes() excludes rows written by triggers.
  const rowsAffected = after > before ? Number(db.prepare("SELECT changes() AS count").get()!.count) : 0;
  const result: LedgerResult = { rows, rowsAffected };
  if (rowsAffected > 0 && /^\s*(?:INSERT|REPLACE)\b/i.test(sql)) {
    result.lastInsertRowid = BigInt(db.prepare("SELECT last_insert_rowid() AS id").get()!.id as number | bigint);
  }
  return result;
}

const localQueueKey = Symbol.for("aurrery.ledger.local-connection-queues");
const localRegistry = globalThis as typeof globalThis & { [key: symbol]: WeakMap<DatabaseSync, { tail: Promise<void> }> };
const localQueues = localRegistry[localQueueKey] ??= new WeakMap<DatabaseSync, { tail: Promise<void> }>();

function serialize<T>(queue: { tail: Promise<void> }, work: () => Promise<T>): Promise<T> {
  let unlock!: () => void;
  const prior = queue.tail;
  queue.tail = new Promise<void>((resolve) => { unlock = resolve; });
  return prior.then(work).finally(unlock);
}

/** Every adapter for the same DatabaseSync shares one queue, including its transactions. */
export function createLocalConnection(db: DatabaseSync): LedgerConnection {
  let queue = localQueues.get(db);
  if (!queue) { queue = { tail: Promise.resolve() }; localQueues.set(db, queue); }
  const exclusive = <T>(work: () => Promise<T> | T): Promise<T> => serialize(queue, async () => work());
  const direct: LedgerExecutor = {
    async execute(sql, args) { return localExecute(db, sql, args); },
    async query(sql, args) { return (await direct.execute(sql, args)).rows; },
    async executeMultiple(sql) { db.exec(sql); },
  };
  return {
    execute: (sql, args) => exclusive(() => direct.execute(sql, args)),
    query: (sql, args) => exclusive(() => direct.query(sql, args)),
    executeMultiple: (sql) => exclusive(() => direct.executeMultiple(sql)),
    transaction: (callback) => exclusive(async () => {
      db.exec("BEGIN IMMEDIATE");
      let active = true;
      const tx: LedgerExecutor = {
        execute(sql, args) { if (!active) throw new Error("Transaction is closed"); return direct.execute(sql, args); },
        query(sql, args) { if (!active) throw new Error("Transaction is closed"); return direct.query(sql, args); },
        executeMultiple(sql) { if (!active) throw new Error("Transaction is closed"); return direct.executeMultiple(sql); },
      };
      try {
        const value = await callback(tx);
        active = false;
        db.exec("COMMIT");
        return value;
      } catch (error) {
        active = false;
        try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
        throw error;
      }
    }),
  };
}

function remoteResult(result: ResultSet): LedgerResult {
  return {
    rows: result.rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value]),
    ) as LedgerRow),
    rowsAffected: result.rowsAffected,
    ...(result.lastInsertRowid === undefined ? {} : { lastInsertRowid: result.lastInsertRowid }),
  };
}

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch { throw new LedgerStorageError(); }
}

function remoteExecutor(target: Client | Transaction): LedgerExecutor {
  const executor: LedgerExecutor = {
    execute: (sql, args = []) => safe(async () => remoteResult(await target.execute(sql, args as InValue[]))),
    query: async (sql, args) => (await executor.execute(sql, args)).rows,
    executeMultiple: (sql) => safe(() => target.executeMultiple(sql)),
  };
  return executor;
}

const remoteTransactionQueues = new WeakMap<Client, { tail: Promise<void> }>();

/** Also accepts an injected file client in offline tests; production uses the remote factory. */
export function createLibsqlConnection(client: Client): LedgerConnection {
  let transactionQueue = remoteTransactionQueues.get(client);
  if (!transactionQueue) { transactionQueue = { tail: Promise.resolve() }; remoteTransactionQueues.set(client, transactionQueue); }
  const root = remoteExecutor(client);
  return {
    ...root,
    transaction: (callback) => serialize(transactionQueue, async () => {
      const tx = await safe(() => client.transaction("write"));
      try {
        const value = await callback(remoteExecutor(tx));
        await safe(() => tx.commit());
        return value;
      } catch (error) {
        try { await tx.rollback(); } catch { /* Preserve the first failure. */ }
        throw error;
      } finally { try { tx.close(); } catch { /* Preserve the transaction outcome. */ } }
    }),
  };
}

/** Called only by a runtime connection factory or explicit offline setup. */
export async function initializeLedgerSchema(connection: LedgerConnection): Promise<void> {
  await connection.executeMultiple("PRAGMA foreign_keys = ON;");
  await connection.executeMultiple(LEDGER_SCHEMA);
  const columns = await connection.query("PRAGMA table_info(sandbox_subscribers)");
  if (!columns.some((column) => column.name === "reason")) {
    try {
      await connection.executeMultiple("ALTER TABLE sandbox_subscribers ADD COLUMN reason TEXT NOT NULL DEFAULT 'other'");
    } catch (error) {
      // A second runtime may have completed the same migration concurrently.
      const latest = await connection.query("PRAGMA table_info(sandbox_subscribers)");
      if (!latest.some((column) => column.name === "reason")) throw error;
    }
  }
}

type RuntimeOptions = {
  env?: Record<string, string | undefined>;
  /** Test injection only. Production local mode uses the existing ledger() handle. */
  localDatabase?: DatabaseSync;
  /** Test injection only. Production always builds the validated HTTP client. */
  remoteClient?: Client;
  fetch?: typeof globalThis.fetch;
  /** Tests may shorten this; production is fixed at ten seconds. */
  timeoutMs?: number;
};

export function validateTursoUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Invalid ledger configuration"); }
  if (!(["https:", "libsql:"].includes(parsed.protocol)) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.turso\.io$/.test(parsed.hostname) ||
    parsed.username || parsed.password || parsed.port || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error("Invalid ledger configuration");
  }
  return raw;
}

const MAX_REMOTE_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Restrict every SDK HTTP hop to the selected database host and bound the full body. */
export function createTursoFetch(hostname: string, transport: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return async (input, init) => {
    let destination: URL;
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      destination = new URL(raw);
    } catch { throw new LedgerStorageError(); }
    if (destination.protocol !== "https:" || destination.hostname !== hostname ||
      destination.port || destination.username || destination.password) throw new LedgerStorageError();
    const controller = new AbortController();
    // The SDK may supply a Request from @libsql/isomorphic-fetch rather than global Request.
    const requestSignal = typeof input === "object" && input !== null && "signal" in input
      ? (input as { signal?: AbortSignal }).signal : undefined;
    const callerSignal = init?.signal ?? requestSignal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(new LedgerStorageError());
      else controller.signal.addEventListener("abort", () => reject(new LedgerStorageError()), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await Promise.race([transport(input, { ...init, signal: controller.signal, redirect: "error" }), aborted]);
      const contentLength = Number(response.headers.get("content-length"));
      if (contentLength > MAX_REMOTE_RESPONSE_BYTES) throw new LedgerStorageError();
      if (!response.body) return response;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await Promise.race([reader.read(), aborted]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_REMOTE_RESPONSE_BYTES) throw new LedgerStorageError();
        chunks.push(part.value);
      }
      reader.releaseLock();
      reader = undefined;
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      controller.abort();
      if (reader) {
        try { void reader.cancel().catch(() => {}); } catch { /* Preserve the storage failure. */ }
        try { reader.releaseLock(); } catch { /* A pending read may still own the lock. */ }
      } else if (response?.body) {
        try { void response.body.cancel().catch(() => {}); } catch { /* Preserve the storage failure. */ }
      }
      throw new LedgerStorageError();
    }
    finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", onCallerAbort); }
  };
}

/** Explicit backend selection prevents adding credentials from switching a local ledger. */
export async function createRuntimeLedgerConnection(options: RuntimeOptions = {}): Promise<LedgerConnection> {
  const env = options.env ?? process.env;
  const backend = env.LEDGER_BACKEND ?? "sqlite";
  if (backend !== "sqlite" && backend !== "turso") throw new Error("Invalid ledger configuration");
  if (env.RENDER === "true" && backend !== "turso") throw new Error("Invalid ledger configuration");
  let connection: LedgerConnection;
  let ownedClient: Client | undefined;
  if (backend === "sqlite") {
    connection = createLocalConnection(options.localDatabase ?? ledger());
  } else {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN?.trim() || env.LEDGER_PATH) throw new Error("Invalid ledger configuration");
    const url = validateTursoUrl(env.TURSO_DATABASE_URL);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid ledger configuration");
    let client = options.remoteClient;
    if (!client) {
      try {
        client = createClient({
          url,
          authToken: env.TURSO_AUTH_TOKEN,
          fetch: createTursoFetch(new URL(url).hostname, options.fetch ?? globalThis.fetch, timeoutMs),
          intMode: "number",
        });
      } catch { throw new LedgerStorageError(); }
    }
    if (!options.remoteClient) ownedClient = client;
    connection = createLibsqlConnection(client);
  }
  try { await initializeLedgerSchema(connection); }
  catch (error) { try { ownedClient?.close(); } catch { /* Preserve the storage failure. */ } throw error; }
  return connection;
}

let runtimeConnection: Promise<LedgerConnection> | undefined;
/** Optional factory is for offline recovery tests; runtime callers use the default. */
export function runtimeLedgerConnection(factory: () => Promise<LedgerConnection> = createRuntimeLedgerConnection): Promise<LedgerConnection> {
  if (runtimeConnection) return runtimeConnection;
  const pending = Promise.resolve().then(factory);
  const cached = pending.catch((error: unknown) => {
    // A failed wake/init may recover on a later request. Never retry an
    // in-flight operation or turn an ambiguous transaction into a replay.
    if (runtimeConnection === cached) runtimeConnection = undefined;
    throw error;
  });
  runtimeConnection = cached;
  return cached;
}

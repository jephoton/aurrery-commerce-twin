import "server-only";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { REASONS, SEGMENTS } from "@/twin/types";
import { StrategySchema } from "@/twin/interventions";
import { runtimeLedgerConnection, type LedgerConnection, type LedgerExecutor, type LedgerRow, type LedgerValue } from "./connection";
import { LEDGER_SCHEMA } from "./db";
import { authoritativeWrite } from "./operations";
import { hashAction, PriceOverrideActionSchema } from "./proposals";

const TABLES = [
  ["sandbox_subscribers", "rowid"], ["proposals", "id"], ["executions", "id"],
  ["observations", "id"], ["kv", "key"], ["audit_events", "id"],
  ["feedback_prediction_cache", "cache_key"], ["hosted_sessions", "token_hash"], ["hosted_limits", "bucket_key"],
  ["sqlite_sequence", "name"],
] as const;
type TableName = typeof TABLES[number][0];
const OPTIONAL = new Set<TableName>(["feedback_prediction_cache", "hosted_sessions", "hosted_limits"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type TableSnapshot = { table: TableName; columns: string[]; rows: LedgerRow[]; count: number; sha256: string };
export type ImportManifest = { schemaSha256: string; tables: { table: TableName; count: number; sha256: string }[]; totalRows: number };

function rowHash(rows: LedgerRow[], columns: string[]): string {
  const digest = createHash("sha256");
  digest.update("[");
  rows.forEach((row, index) => {
    if (index) digest.update(",");
    digest.update(JSON.stringify(columns.map((name) => row[name])));
  });
  return digest.update("]").digest("hex");
}
function sourceRows(db: DatabaseSync, table: TableName, order: string): LedgerRow[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as LedgerRow[];
}
function validateSource(db: DatabaseSync): TableSnapshot[] {
  if (String(db.prepare("PRAGMA quick_check").get()?.quick_check) !== "ok") throw new Error("Source ledger integrity check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Source ledger constraints failed");
  const known = new Set<string>(TABLES.map(([table]) => table));
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')").all().map((row) => String(row.name)));
  if ([...existing].some((table) => !known.has(table))) throw new Error("Source ledger contains unsupported tables");
  const template = new DatabaseSync(":memory:");
  template.exec(LEDGER_SCHEMA);
  try {
    const snapshots: TableSnapshot[] = [];
    for (const [table, order] of TABLES) {
      if (!existing.has(table) && !OPTIONAL.has(table)) throw new Error("Source ledger schema is incomplete");
      const signature = (database: DatabaseSync) => database.prepare(`PRAGMA table_info(${table})`).all()
        .map((column) => [column.name, column.type, column.notnull, column.dflt_value, column.pk]);
      const expectedSignature = signature(template);
      const actualSignature = existing.has(table) ? signature(db) : expectedSignature;
      if (JSON.stringify(actualSignature) !== JSON.stringify(expectedSignature)) throw new Error("Source ledger schema does not match the importer");
      const columns = expectedSignature.map((column) => String(column[0]));
      const rows = existing.has(table) ? sourceRows(db, table, order) : [];
      snapshots.push({ table, columns, rows, count: rows.length, sha256: rowHash(rows, columns) });
    }
    validateRecords(snapshots);
    return snapshots;
  } finally { template.close(); }
}
function validateRecords(tables: TableSnapshot[]): void {
  const of = (table: TableName) => tables.find((entry) => entry.table === table)!.rows;
  for (const row of of("sandbox_subscribers")) {
    if (!/^I-[A-Z0-9]+$/.test(String(row.subscription_id)) || !String(row.label).trim() ||
      !SEGMENTS.includes(String(row.segment) as typeof SEGMENTS[number]) || !REASONS.includes(String(row.reason) as typeof REASONS[number]) ||
      !Number.isFinite(Date.parse(String(row.created_at)))) throw new Error("Source pilot metadata is invalid");
  }
  for (const row of of("proposals")) {
    let action: unknown;
    try {
      action = PriceOverrideActionSchema.parse(JSON.parse(String(row.action_json)));
      StrategySchema.parse(JSON.parse(String(row.strategy_json)));
      JSON.parse(String(row.simulation_json));
    } catch { throw new Error("Source proposal schema is invalid"); }
    if (!/^prop_[0-9a-f-]{36}$/.test(String(row.id)) || row.action_type !== "subscription_price_override" ||
      hash(String(row.action_json)) !== row.action_hash || hashAction(action as ReturnType<typeof PriceOverrideActionSchema.parse>) !== row.action_hash) throw new Error("Source proposal action hash is invalid");
  }
}
async function targetFingerprint(tx: LedgerExecutor, table: TableName, order: string, columns: string[]): Promise<{ count: number; sha256: string }> {
  const count = Number((await tx.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0);
  const digest = createHash("sha256");
  digest.update("[");
  let seen = 0;
  for (let offset = 0; offset < count; offset += 50) {
    const rows = await tx.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`, [50, offset]);
    for (const row of rows) {
      if (seen++) digest.update(",");
      digest.update(JSON.stringify(columns.map((name) => row[name])));
    }
  }
  return { count: seen, sha256: digest.update("]").digest("hex") };
}
/** CREATE IF NOT EXISTS leaves weakened pre-existing tables intact; compare actual definitions on the write handle. */
async function assertCanonicalTargetSchema(tx: LedgerExecutor): Promise<void> {
  const template = new DatabaseSync(":memory:");
  template.exec(LEDGER_SCHEMA);
  const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
  const fields = (rows: LedgerRow[], names: string[]) => rows.map((row) => names.map((name) => row[name]));
  const localRows = (sql: string) => template.prepare(sql).all() as LedgerRow[];
  try {
    const checkMode = await tx.query("PRAGMA ignore_check_constraints");
    if (checkMode.length !== 1 || Number(checkMode[0].ignore_check_constraints) !== 0) throw new Error("Target ledger schema is incompatible");
    if (JSON.stringify(fields(await tx.query(schemaSql), ["type", "name", "tbl_name", "sql"])) !==
      JSON.stringify(fields(localRows(schemaSql), ["type", "name", "tbl_name", "sql"]))) throw new Error("Target ledger schema is incompatible");
    for (const [table] of TABLES) {
      for (const [pragma, columns] of [
        ["table_info", ["cid", "name", "type", "notnull", "dflt_value", "pk"]],
        ["foreign_key_list", ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"]],
        ["index_list", ["seq", "name", "unique", "origin", "partial"]],
      ] as const) {
        const sql = `PRAGMA ${pragma}(${table})`;
        if (JSON.stringify(fields(await tx.query(sql), [...columns])) !== JSON.stringify(fields(localRows(sql), [...columns])))
          throw new Error("Target ledger schema is incompatible");
      }
      for (const index of localRows(`PRAGMA index_list(${table})`)) {
        const name = String(index.name);
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Target ledger schema is incompatible");
        const sql = `PRAGMA index_info(${name})`;
        const columns = ["seqno", "cid", "name"];
        if (JSON.stringify(fields(await tx.query(sql), columns)) !== JSON.stringify(fields(localRows(sql), columns)))
          throw new Error("Target ledger schema is incompatible");
      }
    }
  } finally { template.close(); }
}
async function assertEmpty(tx: LedgerExecutor): Promise<void> {
  const actual = (await tx.query("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')")).map((row) => String(row.name));
  for (const name of actual) {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Target ledger is not empty");
    const count = await tx.query(`SELECT COUNT(*) AS n FROM ${name}`);
    if (Number(count[0]?.n ?? 0) !== 0) throw new Error("Target ledger is not empty");
  }
}
async function applySnapshot(target: LedgerConnection, tables: TableSnapshot[], beforeChunk?: (table: TableName, index: number) => void): Promise<void> {
  await authoritativeWrite(target, async (tx) => {
    await assertEmpty(tx);
    await assertCanonicalTargetSchema(tx);
    for (const snapshot of tables) {
      const { table, columns, rows } = snapshot;
      if (table === "sqlite_sequence") await tx.execute("DELETE FROM sqlite_sequence");
      for (let start = 0; start < rows.length; start += 25) {
        const chunk = rows.slice(start, start + 25);
        const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
        const args = chunk.flatMap((row) => columns.map((column) => row[column] as LedgerValue));
        await tx.execute(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`, args);
        beforeChunk?.(table, start + chunk.length);
      }
    }
    if ((await tx.query("PRAGMA foreign_key_check")).length) throw new Error("Imported ledger constraints failed");
    for (const [table, order] of TABLES) {
      const expected = tables.find((entry) => entry.table === table)!;
      const actual = await targetFingerprint(tx, table, order, expected.columns);
      if (actual.count !== expected.count || actual.sha256 !== expected.sha256) throw new Error("Imported ledger verification failed");
    }
  });
}

/** An explicit, read-only SQLite backup captures committed WAL pages before any target access. */
export async function importLedger(options: {
  sourcePath: string; dryRun?: boolean; target?: LedgerConnection;
  openTarget?: () => Promise<LedgerConnection>;
  /** Offline fault injection to prove transaction rollback. */
  beforeChunk?: (table: TableName, index: number) => void;
}): Promise<ImportManifest> {
  if (!isAbsolute(options.sourcePath) || !existsSync(options.sourcePath)) throw new Error("An existing absolute source ledger path is required");
  const sourcePath = realpathSync(options.sourcePath);
  const dir = mkdtempSync(join(tmpdir(), "aurrery-ledger-import-"));
  let source: DatabaseSync | undefined;
  let snapshot: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    const snapshotPath = join(dir, "snapshot.sqlite");
    await backup(source, snapshotPath);
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const tables = validateSource(snapshot);
    const sourceSchema = snapshot.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all();
    const manifest: ImportManifest = {
      schemaSha256: hash(JSON.stringify(sourceSchema)),
      tables: tables.map(({ table, count, sha256 }) => ({ table, count, sha256 })),
      totalRows: tables.reduce((sum, entry) => sum + entry.count, 0),
    };
    if (!options.dryRun) {
      const target = options.target ?? await (options.openTarget ?? (() => {
        if (process.env.LEDGER_BACKEND !== "turso" || !process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN?.trim()) throw new Error("Explicit Turso configuration is required");
        return runtimeLedgerConnection();
      }))();
      await applySnapshot(target, tables, options.beforeChunk);
    }
    return manifest;
  } finally {
    snapshot?.close();
    source?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

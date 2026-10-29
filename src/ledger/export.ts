import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client/http";
import { createLibsqlConnection, createLocalConnection, createTursoFetch, validateTursoUrl, type LedgerConnection, type LedgerRow } from "./connection";
import { LEDGER_SCHEMA } from "./db";
import { authoritativeWrite } from "./operations";
import { applySnapshot, assertCanonicalTargetSchema, importLedger, rowHash, TABLES, validateRecords, type ImportManifest, type TableSnapshot } from "./import";

type Source = { connection: LedgerConnection; close(): void };
type ExportOptions = { outputPath: string; sourcePath?: string; source?: LedgerConnection; openSource?: () => Promise<Source> };
const failure = () => new Error("Ledger export was not confirmed");

/** Existing authority only: no runtime schema initialization, DDL, sync or retries. */
export async function openExportSource(env: Record<string, string | undefined> = process.env): Promise<Source> {
  try {
    if (env.LEDGER_BACKEND !== "turso" || env.LEDGER_PATH || !env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN?.trim()) throw failure();
    const url = validateTursoUrl(env.TURSO_DATABASE_URL);
    const client = createClient({ url, authToken: env.TURSO_AUTH_TOKEN, intMode: "number", fetch: createTursoFetch(new URL(url).hostname, globalThis.fetch, 10_000) });
    return { connection: createLibsqlConnection(client), close: () => client.close() };
  } catch { throw failure(); }
}

async function authoritativeSnapshot(source: LedgerConnection): Promise<{ tables: TableSnapshot[]; manifest: ImportManifest }> {
  return authoritativeWrite(source, async (tx) => {
    await assertCanonicalTargetSchema(tx);
    if ((await tx.query("PRAGMA quick_check"))[0]?.quick_check !== "ok" || (await tx.query("PRAGMA foreign_key_check")).length) throw failure();
    const tables: TableSnapshot[] = [];
    for (const [table, order] of TABLES) {
      const columns = (await tx.query(`PRAGMA table_info(${table})`)).map(row => String(row.name));
      const count = Number((await tx.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
      if (!Number.isSafeInteger(count) || count < 0) throw failure();
      const rows: LedgerRow[] = [];
      for (let offset = 0; offset < count; offset += 50) rows.push(...await tx.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`, [50, offset]));
      if (rows.length !== count) throw failure();
      tables.push({ table, columns, rows, count, sha256: rowHash(rows, columns) });
    }
    validateRecords(tables);
    const schema = await tx.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name");
    const manifest = { schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), tables: tables.map(({ table, count, sha256 }) => ({ table, count, sha256 })), totalRows: tables.reduce((sum, table) => sum + table.count, 0) };
    return { tables, manifest };
  });
}

/** Never overwrite output. Publish only after consistent snapshot + importer verification. */
export async function exportLedger(options: ExportOptions): Promise<ImportManifest> {
  let ownedDirectory: string | undefined;
  let close: (() => void) | undefined;
  try {
    if (!isAbsolute(options.outputPath) || existsSync(options.outputPath) ||
      (options.sourcePath && (options.source || options.openSource)) || (options.source && options.openSource)) throw failure();
    // Check an existing destination directory before any source/network access.
    accessSync(dirname(options.outputPath), constants.W_OK);
    if (options.sourcePath && (!isAbsolute(options.sourcePath) || !existsSync(options.sourcePath))) throw failure();
    ownedDirectory = mkdtempSync(join(dirname(options.outputPath), ".aurrery-export-"));
    const temporary = join(ownedDirectory, "snapshot.sqlite");
    writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
    let manifest: ImportManifest;
    if (options.sourcePath) {
      const db = new DatabaseSync(realpathSync(options.sourcePath), { readOnly: true });
      try { await backup(db, temporary); } finally { db.close(); }
      manifest = await importLedger({ sourcePath: temporary, dryRun: true });
    } else {
      let source = options.source;
      if (!source) { const opened = await (options.openSource ?? openExportSource)(); source = opened.connection; close = opened.close; }
      const snapshot = await authoritativeSnapshot(source);
      const sourceClose = close; close = undefined; sourceClose?.();
      const db = new DatabaseSync(temporary);
      try {
        db.exec(`PRAGMA foreign_keys=ON; ${LEDGER_SCHEMA}`);
        await applySnapshot(createLocalConnection(db), snapshot.tables);
      } finally { db.close(); }
      manifest = await importLedger({ sourcePath: temporary, dryRun: true });
      if (JSON.stringify(manifest) !== JSON.stringify(snapshot.manifest)) throw failure();
    }
    // A same-filesystem hard link is atomic and fails if any destination already exists.
    // The owned private inode is complete before becoming visible at the final name.
    linkSync(temporary, options.outputPath);
    return manifest;
  } catch { throw failure(); }
  finally {
    try { close?.(); } catch { throw failure(); }
    finally {
      try { if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true }); }
      catch { throw failure(); }
    }
  }
}

export function parseExportArguments(args: string[]): { sourcePath?: string; outputPath: string } {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!["--source", "--output"].includes(flag) || options[flag] !== undefined || !value || value.startsWith("--") || !isAbsolute(value)) throw failure();
    options[flag] = value;
  }
  if (options["--output"] && existsSync(options["--output"])) throw failure();
  if (options["--source"] && !existsSync(options["--source"])) throw failure();
  return { ...(options["--source"] ? { sourcePath: options["--source"] } : {}), outputPath: options["--output"] ?? resolve("data", `ledger-backup-${randomUUID()}.sqlite`) };
}

export async function exportLedgerCli(args: string[]): Promise<ImportManifest> {
  const options = parseExportArguments(args);
  // Default private directory is the ignored repository-local data folder.
  if (!args.includes("--output")) mkdirSync(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  return exportLedger(options);
}

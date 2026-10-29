import { afterAll, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema, type LedgerConnection } from "./connection";
import { createProposalRepository, hashAction, PriceOverrideActionSchema } from "./proposals";
import { importLedger, TABLES } from "./import";
import { exportLedger, openExportSource, parseExportArguments } from "./export";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { recordTarget } from "@/execution/execute";
import { execFileSync, spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "aurrery-export-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows native libSQL handles may outlive close(). */ } });
async function fixture(name: string) {
  const client = createClient({ url: `file:${join(dir, name + ".sqlite")}` });
  const connection = createLibsqlConnection(client); await initializeLedgerSchema(connection);
  const repo = createProposalRepository(connection);
  for (const [index, pilot] of PILOT_COHORT.entries()) await repo.registerSandboxSubscriber({ subscriptionId: `I-PILOT${index}`, ...pilot });
  await connection.execute("INSERT INTO kv VALUES ('paypal.setting','private-source')");
  await connection.execute("INSERT INTO feedback_prediction_cache VALUES ('fingerprint','{}')");
  await connection.execute("INSERT INTO hosted_sessions VALUES ('private-session',123,'fingerprint')");
  await connection.execute("INSERT INTO hosted_limits VALUES ('bucket',3,123)");
  return { client, connection, repo };
}
it.each(["proposed", "approved", "executing"] as const)("exports all authority including a %s reset and round trips without creating approval", async (status) => {
  const { client, connection, repo } = await fixture(status);
  const registration = (await connection.query("SELECT * FROM sandbox_subscribers ORDER BY rowid"))[0];
  const proposal = await repo.createResetProposal("24.00", [{ subscriptionId: String(registration.subscription_id), expectedCurrentPrice: "18.0", registration: { label: String(registration.label), segment: PILOT_COHORT[0].segment, reason: PILOT_COHORT[0].reason, createdAt: String(registration.created_at) } }]);
  if (status !== "proposed") await repo.approveResetProposal(proposal.id, proposal.actionHash, "offline administrator");
  if (status === "executing") await repo.claimForExecution(proposal.id);
  const sourceBefore = await connection.query("SELECT * FROM proposals");
  const target = new DatabaseSync(":memory:"); const targetConnection = createLocalConnection(target); await initializeLedgerSchema(targetConnection);
  try {
    const output = join(dir, status + "-backup.sqlite");
    const manifest = await exportLedger({ outputPath: output, source: connection });
    expect(await importLedger({ sourcePath: output, target: targetConnection })).toEqual(manifest);
    expect(await targetConnection.query("SELECT * FROM proposals")).toEqual(sourceBefore);
    expect(await targetConnection.query("SELECT * FROM active_target_claims")).toEqual(await connection.query("SELECT * FROM active_target_claims"));
    expect(await targetConnection.query("SELECT * FROM hosted_sessions")).toEqual(await connection.query("SELECT * FROM hosted_sessions"));
    expect(await targetConnection.query("SELECT * FROM sqlite_sequence ORDER BY name")).toEqual(await connection.query("SELECT * FROM sqlite_sequence ORDER BY name"));
    expect(await targetConnection.query("SELECT subscription_id FROM sandbox_subscribers ORDER BY rowid")).toEqual(await connection.query("SELECT subscription_id FROM sandbox_subscribers ORDER BY rowid"));
    expect(await connection.query("SELECT * FROM proposals")).toEqual(sourceBefore);
    expect(manifest.tables).toHaveLength(13);
  } finally { target.close(); client.close(); }
});
it("validates output/flags before opening source and never overwrites an existing output", async () => {
  const output = join(dir, "existing.sqlite"); writeFileSync(output, "existing-private-file");
  const openSource = vi.fn();
  await expect(exportLedger({ outputPath: output, openSource })).rejects.toThrow();
  await expect(exportLedger({ outputPath: "relative.sqlite", openSource })).rejects.toThrow();
  expect(openSource).not.toHaveBeenCalled(); expect(readFileSync(output, "utf8")).toBe("existing-private-file");
});
it("does not acknowledge or leave output after an ambiguous commit and closes owned source exactly once", async () => {
  const { client, connection } = await fixture("ambiguous");
  const close = vi.fn(); const before = readdirSync(dir).sort();
  const ambiguous: LedgerConnection = { ...connection, async transaction(work) { await connection.transaction(work); throw new Error("private-url-token"); } };
  const output = join(dir, "ambiguous-backup.sqlite");
  try {
    await expect(exportLedger({ outputPath: output, openSource: async () => ({ connection: ambiguous, close }) })).rejects.toThrow("Ledger export was not confirmed");
    expect(existsSync(output)).toBe(false); expect(readdirSync(dir).sort()).toEqual(before); expect(close).toHaveBeenCalledTimes(1);
  } finally { client.close(); }
});
it("uses one snapshot transaction, excludes a concurrent later write, and leaves source rows intact on failure", async () => {
  const { client, connection } = await fixture("snapshot");
  let reading!: () => void; let resume!: () => void;
  const started = new Promise<void>(done => { reading = done; });
  const gate = new Promise<void>(done => { resume = done; });
  const sameClientWriter = createLibsqlConnection(client);
  const transaction = vi.fn(connection.transaction.bind(connection));
  const source = { ...connection, transaction: <T>(work: Parameters<LedgerConnection["transaction"]>[0]) => transaction(async tx => {
    const result = await work(tx); reading(); await gate; return result;
  }) as Promise<T> };
  const output = join(dir, "snapshot-backup.sqlite");
  try {
    const backup = exportLedger({ outputPath: output, source }); await started;
    const later = sameClientWriter.transaction(tx => tx.execute("INSERT INTO kv VALUES ('later','private')"));
    resume(); await backup; await later;
    expect(transaction).toHaveBeenCalledOnce();
    const db = new DatabaseSync(output, { readOnly: true });
    try { expect(db.prepare("SELECT * FROM kv WHERE key='later'").all()).toEqual([]); } finally { db.close(); }
    expect(await connection.query("SELECT * FROM kv WHERE key='later'")).toHaveLength(1);
  } finally { client.close(); }
});

it.each(["proposed", "approved", "executing"] as const)("preserves a %s revert, original execution/episode, signed event fact and all table hashes", async status => {
  const { client, connection, repo } = await fixture(`revert-${status}`);
  try {
    const registration = (await connection.query("SELECT * FROM sandbox_subscribers ORDER BY rowid"))[0];
    const at = String(registration.created_at);
    const id = "prop_00000000-0000-4000-8000-000000000123";
    const action = PriceOverrideActionSchema.parse({ type: "subscription_price_override", segment: registration.segment, reason: registration.reason, listPrice: "24.00", newPrice: "18.00", discountPct: 25, months: 3, campaignMonths: 0, targets: [registration.subscription_id] });
    await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,'{}',?,?,?,'executing')", [id, at, JSON.stringify(STARTER_STRATEGIES[1]), action.type, JSON.stringify(action), hashAction(action)]);
    const observed = { id: String(registration.subscription_id), status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: null };
    await recordTarget(id, {}, { subscriptionId: observed.id, ok: true, verified: true, httpStatus: 204, debugId: null, observed, error: null }, observed, connection, at);
    await repo.finishExecution(id, "succeeded", null);
    await connection.execute("INSERT INTO paypal_webhook_events (event_id,event_type,event_at,received_at,subscription_id,disposition,observation_id) VALUES ('event-fixture','BILLING.SUBSCRIPTION.UPDATED',?,?,?,'observed',1)", [at, at, observed.id]);
    const revert = await repo.createRevertProposal(id);
    if (status !== "proposed") await repo.approveProposal(revert.id, revert.actionHash, "offline merchant");
    if (status === "executing") await repo.claimForExecution(revert.id);
    const output = join(dir, `revert-${status}-backup.sqlite`);
    const manifest = await exportLedger({ outputPath: output, source: connection });
    const target = new DatabaseSync(":memory:");
    try {
      const destination = createLocalConnection(target); await initializeLedgerSchema(destination);
      expect(await importLedger({ sourcePath: output, target: destination })).toEqual(manifest);
      for (const [table, order] of TABLES) {
        expect(await destination.query(`SELECT * FROM ${table} ORDER BY ${order}`)).toEqual(await connection.query(`SELECT * FROM ${table} ORDER BY ${order}`));
      }
      expect((await createProposalRepository(destination).getProposal(revert.id)).status).toBe(status);
    } finally { target.close(); }
  } finally { client.close(); }
});

it("rolls back a failed primary snapshot without mutating source or leaving partial files", async () => {
  const { client, connection } = await fixture("rollback");
  const output = join(dir, "rollback-backup.sqlite"); let queryCount = 0;
  const source: LedgerConnection = { ...connection, transaction: work => connection.transaction(tx => work({ ...tx, async query(sql, args) {
    if (++queryCount > 8) throw new Error("private query failure");
    return tx.query(sql, args);
  } })) };
  try {
    const before = await connection.query("SELECT * FROM kv");
    await expect(exportLedger({ outputPath: output, source })).rejects.toThrow("Ledger export was not confirmed");
    expect(existsSync(output)).toBe(false); expect(await connection.query("SELECT * FROM kv")).toEqual(before);
    await expect(connection.transaction(tx => tx.query("SELECT * FROM kv"))).resolves.toEqual(before);
    await expect(exportLedger({ outputPath: output, source: connection })).resolves.toHaveProperty("totalRows");
  } finally { client.close(); }
});

it("rejects noncanonical schema without migration or DDL, and keeps every source row unchanged", async () => {
  const { client, connection } = await fixture("schema");
  try {
    await connection.execute("DROP TABLE hosted_limits");
    const before = await connection.query("SELECT * FROM sqlite_master ORDER BY name");
    await expect(exportLedger({ outputPath: join(dir, "schema-backup.sqlite"), source: connection })).rejects.toThrow();
    expect(await connection.query("SELECT * FROM sqlite_master ORDER BY name")).toEqual(before);
  } finally { client.close(); }
});

it("uses a read-only local online backup including committed WAL, with no source migration", async () => {
  const sourcePath = join(dir, "local-source.sqlite");
  const source = new DatabaseSync(sourcePath); source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  const connection = createLocalConnection(source); await initializeLedgerSchema(connection);
  await connection.execute("DROP TABLE hosted_limits");
  await connection.execute("INSERT INTO kv VALUES ('committed-wal','private')");
  const beforeSchema = source.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  const beforeChanges = source.prepare("SELECT total_changes() AS n").get();
  const beforeBytes = readFileSync(sourcePath); const beforeWal = readFileSync(sourcePath + "-wal");
  const output = join(dir, "local-backup.sqlite");
  try {
    const manifest = await exportLedger({ sourcePath, outputPath: output });
    expect(manifest.tables.find(table => table.table === "kv")?.count).toBe(1);
    expect(source.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(beforeSchema);
    expect(source.prepare("SELECT total_changes() AS n").get()).toEqual(beforeChanges);
    expect(readFileSync(sourcePath)).toEqual(beforeBytes); expect(readFileSync(sourcePath + "-wal")).toEqual(beforeWal);
  } finally { source.close(); }
});

it("validates all CLI flags before networking, prints only manifest counts/hashes and suppresses private failures", async () => {
  for (const args of [["--wat"], ["--output"], ["--output", "relative"], ["--output", join(dir, "one.sqlite"), "--output", join(dir, "two.sqlite")]]) expect(() => parseExportArguments(args)).toThrow();
  const sourcePath = join(dir, "cli-source.sqlite");
  const db = new DatabaseSync(sourcePath); await initializeLedgerSchema(createLocalConnection(db)); db.prepare("INSERT INTO kv VALUES ('private-key','private-secret')").run(); db.close();
  const outputPath = join(dir, "cli-backup.sqlite");
  const output = execFileSync(process.execPath, ["--import=tsx", "--conditions=react-server", "scripts/export-ledger.ts", "--source", sourcePath, "--output", outputPath], { encoding: "utf8" });
  expect(JSON.parse(output).totalRows).toBe(1); expect(output).not.toMatch(/private-secret|private-key/); expect(output).not.toContain(sourcePath); expect(output).not.toContain(outputPath);
  const result = spawnSync(process.execPath, ["--import=tsx", "--conditions=react-server", "scripts/export-ledger.ts", "--output", outputPath], { encoding: "utf8", env: { ...process.env, TURSO_AUTH_TOKEN: "private-token" } });
  expect(result.status).toBe(1); expect(result.stderr).toContain("not confirmed"); expect(result.stderr).not.toMatch(/private-token|cli-backup/);
});

it("opens an existing remote export source without any schema or HTTP calls", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private"));
  try {
    const source = await openExportSource({ LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "private" });
    expect(fetch).not.toHaveBeenCalled(); source.close();
    await expect(openExportSource({ LEDGER_BACKEND: "sqlite" })).rejects.toThrow("Ledger export was not confirmed");
  } finally { fetch.mockRestore(); }
});

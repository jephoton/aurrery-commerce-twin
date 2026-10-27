import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { afterAll, expect, it } from "vitest";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema } from "./connection";
import { LEDGER_SCHEMA } from "./db";
import { createProposalRepository, hashAction, PriceOverrideActionSchema, RevertActionSchema } from "./proposals";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { importLedger } from "./import";
import { recordTarget } from "@/execution/execute";

async function episodeSource(path: string) {
  const source = new DatabaseSync(path);
  const connection = createLocalConnection(source);
  await initializeLedgerSchema(connection);
  const at = "2026-01-01T00:00:00.000Z";
  const action = PriceOverrideActionSchema.parse({ type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00", discountPct: 25, months: 1, campaignMonths: 0, targets: ["I-FIXTURE"] });
  const id = "prop_00000000-0000-4000-8000-000000000001";
  await connection.execute("INSERT INTO sandbox_subscribers VALUES ('I-FIXTURE','Pilot','core','price',?)", [at]);
  await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,'{}',?,?,?,'executing')", [id, at, JSON.stringify(STARTER_STRATEGIES[1]), action.type, JSON.stringify(action), hashAction(action)]);
  const snapshot = { id: "I-FIXTURE", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: null };
  await recordTarget(id, {}, { subscriptionId: snapshot.id, ok: true, verified: true, httpStatus: 204, debugId: null, observed: snapshot, error: null }, snapshot, connection, at);
  return source;
}

const dir = mkdtempSync(join(tmpdir(), "aurrery-import-"));
it("accepts a legacy ledger without episode snapshots and never backfills historical reasons", async () => {
  const path = join(dir, "legacy-episodes.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.exec("DROP TABLE discount_episodes");
  source.close();
  const manifest = await importLedger({ sourcePath: path, dryRun: true });
  expect(manifest.tables.find(row => row.table === "discount_episodes")?.count).toBe(0);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='discount_episodes'").all()).toEqual([]);
  unchanged.close();
});
it("accepts a legacy ledger without target claims and leaves an unresolved action visible", async () => {
  const path = join(dir, "legacy-claims.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.exec("DROP TABLE active_target_claims");
  source.close();
  const manifest = await importLedger({ sourcePath: path, dryRun: true });
  expect(manifest.tables.find((row) => row.table === "active_target_claims")?.count).toBe(0);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='active_target_claims'").all()).toEqual([]);
  unchanged.close();
});
it("prevents a new overlapping claim after importing a legacy unresolved action without claim rows", async () => {
  const path = join(dir, "legacy-unresolved.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.exec("DROP TABLE active_target_claims");
  const action = PriceOverrideActionSchema.parse({ type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00", discountPct: 25, months: 3, campaignMonths: 0, targets: ["I-FIXTURE"] });
  const at = "2026-01-01T00:00:00.000Z";
  source.prepare("INSERT INTO sandbox_subscribers VALUES (?,?,?,?,?)").run("I-FIXTURE", "Pilot", "core", "price", at);
  source.prepare("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)")
    .run("prop_00000000-0000-4000-8000-000000000061", at, JSON.stringify(STARTER_STRATEGIES[1]), "{}", action.type, JSON.stringify(action), hashAction(action), "executing");
  source.close();
  const client = createClient({ url: `file:${join(dir, "legacy-unresolved-target.sqlite")}` });
  try {
    const target = createLibsqlConnection(client);
    await initializeLedgerSchema(target);
    await importLedger({ sourcePath: path, target });
    const fresh = "prop_00000000-0000-4000-8000-000000000062";
    await target.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)",
      [fresh, at, JSON.stringify(STARTER_STRATEGIES[1]), "{}", action.type, JSON.stringify(action), hashAction(action), "approved"]);
    const repository = createProposalRepository(target);
    await expect(repository.claimForExecution(fresh)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await repository.getProposal(fresh)).status).toBe("failed");
    expect(await target.query("SELECT * FROM active_target_claims")).toEqual([]);
  } finally { client.close(); }
});

it("round trips a recovery proposal, its null forecast and active target claim", async () => {
  const path = join(dir, "recovery-source.sqlite");
  const source = new DatabaseSync(path);
  source.exec(`PRAGMA foreign_keys=ON; ${LEDGER_SCHEMA}`);
  const at = "2026-01-01T00:00:00.000Z";
  const discount = PriceOverrideActionSchema.parse({ type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00", discountPct: 25, months: 3, campaignMonths: 0, targets: ["I-FIXTURE"] });
  const sourceId = "prop_00000000-0000-4000-8000-000000000021";
  const recoveryId = "prop_00000000-0000-4000-8000-000000000022";
  source.prepare("INSERT INTO sandbox_subscribers VALUES (?,?,?,?,?)").run("I-FIXTURE", "Pilot", "core", "price", at);
  source.prepare("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES (?,?,?,?,?,?,?,?)")
    .run(sourceId, at, JSON.stringify(STARTER_STRATEGIES[1]), "{}", discount.type, JSON.stringify(discount), hashAction(discount), "succeeded");
  source.prepare("INSERT INTO executions (proposal_id,target_id,operation,request_json,ok,http_status,response_json,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(sourceId, "I-FIXTURE", "PATCH subscription fixed_price", "{}", 1, 204, JSON.stringify({ observed: { regularPrice: "18.0" } }), 1, at);
  const executionId = Number(source.prepare("SELECT id FROM executions").get()!.id);
  const recovery = RevertActionSchema.parse({ type: "subscription_price_revert", sourceProposalId: sourceId, sourceActionHash: hashAction(discount), targets: [{ subscriptionId: "I-FIXTURE", sourceExecutionId: executionId, expectedCurrentPrice: "18.00", listPrice: "24.00", registration: { label: "Pilot", segment: "core", reason: "price", createdAt: at } }] });
  source.prepare("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(recoveryId, at, JSON.stringify(STARTER_STRATEGIES[1]), "null", recovery.type, JSON.stringify(recovery), hashAction(recovery), "executing", at, "merchant");
  source.prepare("INSERT INTO active_target_claims VALUES (?,?,?)").run("I-FIXTURE", recoveryId, at);
  source.close();
  const client = createClient({ url: `file:${join(dir, "recovery-target.sqlite")}` });
  try {
    const target = createLibsqlConnection(client);
    await initializeLedgerSchema(target);
    await importLedger({ sourcePath: path, target });
    expect(await target.query("SELECT simulation_json,action_json,status FROM proposals WHERE id=?", [recoveryId])).toEqual([{ simulation_json: "null", action_json: JSON.stringify(recovery), status: "executing" }]);
    expect(await target.query("SELECT target_id,proposal_id FROM active_target_claims")).toEqual([{ target_id: "I-FIXTURE", proposal_id: recoveryId }]);
  } finally { client.close(); }
  const tampered = new DatabaseSync(path);
  tampered.prepare("UPDATE proposals SET simulation_json='{}' WHERE id=?").run(recoveryId);
  tampered.close();
  await expect(importLedger({ sourcePath: path, dryRun: true })).rejects.toThrow(/proposal schema/i);
  const malformed = new DatabaseSync(path);
  malformed.prepare("UPDATE proposals SET simulation_json='null' WHERE id=?").run(recoveryId);
  malformed.prepare("UPDATE executions SET response_json=? WHERE proposal_id=?").run(JSON.stringify({ observed: { regularPrice: "1.8e1" } }), sourceId);
  malformed.close();
  await expect(importLedger({ sourcePath: path, dryRun: true })).rejects.toThrow(/recovery execution/i);
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows native client lock. */ } });
it("round trips linked episode snapshots through a checked libSQL target", async () => {
  const path = join(dir, "episode-source.sqlite");
  const source = await episodeSource(path);
  source.prepare("UPDATE observations SET regular_price='18.0' WHERE source='paypal.get_subscription'").run();
  const expected = source.prepare("SELECT * FROM discount_episodes").all();
  source.close();
  const client = createClient({ url: `file:${join(dir, "episode-target.sqlite")}` });
  try {
    const target = createLibsqlConnection(client);
    await initializeLedgerSchema(target);
    await importLedger({ sourcePath: path, target });
    expect(await target.query("SELECT * FROM discount_episodes")).toEqual(expected);
  } finally { client.close(); }
});
it.each([
  ["unverified", "UPDATE executions SET verified=0"],
  ["wrong pilot", "UPDATE discount_episodes SET subscription_id='I-OTHER'"],
  ["wrong time", "UPDATE discount_episodes SET ends_at='2026-04-01T00:00:00.000Z'"],
  ["wrong price", "UPDATE discount_episodes SET discounted_price='17.00'"],
  ["exponent observed price", "UPDATE observations SET regular_price='1.8e1' WHERE source='paypal.get_subscription'"],
  ["wrong segment", "UPDATE discount_episodes SET segment='at_risk'"],
  ["wrong reason", "UPDATE discount_episodes SET reason='other'"],
  ["wrong operation", "UPDATE executions SET operation='fixture unrelated operation'"],
  ["nonactive start", "UPDATE observations SET status='SUSPENDED'"],
])("rejects %s source episode before target access", async (name, sql) => {
  const path = join(dir, `episode-tamper-${name.replaceAll(" ", "-")}.sqlite`);
  const source = await episodeSource(path);
  source.exec(sql);
  source.close();
  let opened = false;
  await expect(importLedger({ sourcePath: path, openTarget: async () => { opened = true; throw new Error("unreachable"); } })).rejects.toThrow(/episode/);
  expect(opened).toBe(false);
});

it("dry runs from a consistent WAL snapshot without opening a remote target", async () => {
  const path = join(dir, "source.sqlite");
  const source = new DatabaseSync(path);
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${LEDGER_SCHEMA}`);
  source.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("mode", "fixture");
  let opened = false;
  const result = await importLedger({ sourcePath: path, dryRun: true, openTarget: async () => { opened = true; throw new Error("must not open"); } });
  expect(result.tables.find(({ table }) => table === "kv")?.count).toBe(1);
  expect(result.tables.find(({ table }) => table === "kv")?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(opened).toBe(false);
  expect(source.prepare("SELECT value FROM kv WHERE key='mode'").get()).toMatchObject({ value: "fixture" });
  const output = execFileSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "scripts/import-ledger.ts", "--dry-run", "--source", path], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" },
  });
  expect(JSON.parse(output)).toMatchObject({ totalRows: 1 });
  expect(output).not.toContain(path);
  const refused = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "scripts/import-ledger.ts", "--apply", "--source", path], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, LEDGER_BACKEND: "turso", TURSO_DATABASE_URL: "https://fixture.turso.io", TURSO_AUTH_TOKEN: "" },
  });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("not confirmed");
  expect(refused.stderr).not.toContain(path);
  source.close();
});

it("imports into an empty libSQL target and refuses a second import", async () => {
  const path = join(dir, "source-two.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("mode", "fixture");
  source.close();
  const client = createClient({ url: `file:${join(dir, "target.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  const result = await importLedger({ sourcePath: path, target });
  expect(result.tables.find(({ table }) => table === "kv")?.count).toBe(1);
  expect(await target.query("SELECT value FROM kv WHERE key='mode'")).toEqual([{ value: "fixture" }]);
  await expect(importLedger({ sourcePath: path, target })).rejects.toThrow(/empty/i);
  client.close();
});

it("rejects a missing source without creating one or opening a target", async () => {
  const path = join(dir, "missing.sqlite");
  let opened = false;
  await expect(importLedger({ sourcePath: path, openTarget: async () => { opened = true; throw new Error("unreachable"); } })).rejects.toThrow(/existing/);
  expect(existsSync(path)).toBe(false);
  expect(opened).toBe(false);
});

it("rejects a tampered proposal action hash before opening the target", async () => {
  const path = join(dir, "tampered.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  const action = PriceOverrideActionSchema.parse({
    type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00",
    discountPct: 25, months: 3, campaignMonths: 6, targets: ["I-FIXTURE"],
  });
  source.prepare(`INSERT INTO proposals (id, created_at, objective, strategy_json, simulation_json, action_type, action_json, action_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("prop_00000000-0000-4000-8000-000000000001", new Date().toISOString(), "fixture", JSON.stringify(STARTER_STRATEGIES[1]), "{}", action.type, JSON.stringify(action), `${hashAction(action).slice(0, -1)}x`, "proposed");
  source.close();
  let opened = false;
  await expect(importLedger({ sourcePath: path, openTarget: async () => { opened = true; throw new Error("unreachable"); } })).rejects.toThrow(/hash/);
  expect(opened).toBe(false);
});

it("rolls back all rows on an injected mid-import failure and preserves sequence state on retry", async () => {
  const path = join(dir, "source-rollback.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  source.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("mode", "fixture");
  source.prepare("INSERT INTO observations (subscription_id, observed_at, status, source) VALUES (?, ?, ?, ?)").run("I-FIXTURE", "2026-01-01", "ACTIVE", "fixture");
  source.prepare("DELETE FROM observations WHERE id=1").run();
  source.close();
  const client = createClient({ url: `file:${join(dir, "target-rollback.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  await expect(importLedger({ sourcePath: path, target, beforeChunk(table) { if (table === "kv") throw new Error("injected failure"); } })).rejects.toThrow("injected failure");
  expect(await target.query("SELECT COUNT(*) AS n FROM kv")).toEqual([{ n: 0 }]);
  expect(await target.query("SELECT COUNT(*) AS n FROM sqlite_sequence")).toEqual([{ n: 0 }]);
  const manifest = await importLedger({ sourcePath: path, target });
  expect(manifest.tables.find(({ table }) => table === "sqlite_sequence")?.count).toBe(1);
  expect(await target.query("SELECT seq FROM sqlite_sequence WHERE name='observations'")).toEqual([{ seq: 1 }]);
  const inserted = await target.execute("INSERT INTO observations (subscription_id, observed_at, status, source) VALUES ('I-NEXT', '2026-01-02', 'ACTIVE', 'fixture')");
  expect(inserted.lastInsertRowid).toBe(BigInt(2));
  client.close();
});

it("preserves proposal authority, execution, audit, cache and hosted state exactly", async () => {
  const path = join(dir, "source-all.sqlite");
  const source = new DatabaseSync(path);
  source.exec(`PRAGMA foreign_keys=ON; ${LEDGER_SCHEMA}`);
  const action = PriceOverrideActionSchema.parse({
    type: "subscription_price_override", segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00",
    discountPct: 25, months: 3, campaignMonths: 6, targets: ["I-FIXTURE"],
  });
  const proposalId = "prop_00000000-0000-4000-8000-000000000002";
  source.prepare("INSERT INTO sandbox_subscribers (subscription_id,label,segment,reason,created_at) VALUES (?,?,?,?,?)")
    .run("I-FIXTURE", "A", "core", "price", "2026-01-01T00:00:00.000Z");
  source.prepare(`INSERT INTO proposals (id,created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(proposalId, "2026-01-01T00:00:00.000Z", "fixture objective", JSON.stringify(STARTER_STRATEGIES[1]), "{}", action.type, JSON.stringify(action), hashAction(action), "executing", "2026-01-01T00:00:01.000Z", "fixture-admin");
  source.prepare(`INSERT INTO executions (proposal_id,target_id,operation,request_json,ok,http_status,verified,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(proposalId, "I-FIXTURE", "revise", "{}", 1, 200, 1, "2026-01-01T00:00:02.000Z");
  source.prepare("INSERT INTO observations (subscription_id,observed_at,status,source) VALUES (?,?,?,?)").run("I-FIXTURE", "2026-01-01", "ACTIVE", "fixture");
  source.prepare("INSERT INTO kv (key,value) VALUES (?,?)").run("fixture-key", "fixture-value");
  source.prepare("INSERT INTO audit_events (at,kind,proposal_id,detail_json) VALUES (?,?,?,?)")
    .run("2026-01-01T00:00:00.000Z", "proposal.executing", proposalId, "{}");
  source.prepare("INSERT INTO feedback_prediction_cache (cache_key,prediction_json) VALUES (?,?)").run("f".repeat(64), "{\"fixture\":true}");
  source.prepare("INSERT INTO hosted_sessions (token_hash,expires_at,password_fingerprint) VALUES (?,?,?)").run("a".repeat(64), 123456789, "b".repeat(64));
  source.prepare("INSERT INTO hosted_limits (bucket_key,count,expires_at) VALUES (?,?,?)").run("c".repeat(64), 2, 123456789);
  source.close();
  const client = createClient({ url: `file:${join(dir, "target-all.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  const manifest = await importLedger({ sourcePath: path, target });
  for (const table of ["sandbox_subscribers", "proposals", "executions", "observations", "kv", "audit_events", "feedback_prediction_cache", "hosted_sessions", "hosted_limits"])
    expect(manifest.tables.find((entry) => entry.table === table)?.count, table).toBe(1);
  expect(await target.query("SELECT id,status,action_hash FROM proposals")).toEqual([{ id: proposalId, status: "executing", action_hash: hashAction(action) }]);
  expect(await target.query("SELECT kind,proposal_id,detail_json FROM audit_events")).toEqual([{ kind: "proposal.executing", proposal_id: proposalId, detail_json: "{}" }]);
  expect(await target.query("SELECT count,expires_at FROM hosted_limits")).toEqual([{ count: 2, expires_at: 123456789 }]);
  client.close();
});

it("preserves pilot registration order when subscription IDs sort differently", async () => {
  const path = join(dir, "source-pilot-order.sqlite");
  const source = new DatabaseSync(path);
  source.exec(LEDGER_SCHEMA);
  for (const id of ["I-ZZZ", "I-AAA"]) source.prepare("INSERT INTO sandbox_subscribers (subscription_id,label,segment,reason,created_at) VALUES (?,?,?,?,?)")
    .run(id, id, "core", "other", "2026-01-01T00:00:00.000Z");
  source.close();
  const client = createClient({ url: `file:${join(dir, "target-pilot-order.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  await importLedger({ sourcePath: path, target });
  expect((await target.query("SELECT subscription_id FROM sandbox_subscribers ORDER BY rowid")).map((row) => row.subscription_id)).toEqual(["I-ZZZ", "I-AAA"]);
  client.close();
});

it.each([
  ["missing execution foreign key", (schema: string) => schema.replace("proposal_id TEXT NOT NULL REFERENCES proposals(id)", "proposal_id TEXT NOT NULL")],
  ["missing execution uniqueness", (schema: string) => schema.replace(",\n  UNIQUE (proposal_id, target_id, operation)", "")],
  ["altered proposal status check", (schema: string) => schema.replace("'failed','rejected'", "'failed','rejected','paused'")],
  ["missing webhook observation foreign key", (schema: string) => schema.replace("observation_id INTEGER UNIQUE REFERENCES observations(id)", "observation_id INTEGER UNIQUE")],
  ["missing episode execution foreign key", (schema: string) => schema.replace("execution_id INTEGER PRIMARY KEY REFERENCES executions(id)", "execution_id INTEGER PRIMARY KEY")],
  ["missing episode observation uniqueness", (schema: string) => schema.replace("start_observation_id INTEGER NOT NULL UNIQUE REFERENCES observations(id)", "start_observation_id INTEGER NOT NULL REFERENCES observations(id)")],
  ["missing episode end check", (schema: string) => schema.replace(",\n  CHECK (ends_at > started_at)", "")],
])("rejects an empty target with %s before inserting rows", async (name, weaken) => {
  const slug = name.replaceAll(" ", "-");
  const sourcePath = join(dir, `source-weak-${slug}.sqlite`);
  const source = new DatabaseSync(sourcePath);
  source.exec(LEDGER_SCHEMA);
  source.prepare("INSERT INTO kv (key,value) VALUES (?,?)").run("fixture", "value");
  source.close();
  const client = createClient({ url: `file:${join(dir, `target-weak-${slug}.sqlite`)}` });
  const target = createLibsqlConnection(client);
  await target.executeMultiple(weaken(LEDGER_SCHEMA));
  await initializeLedgerSchema(target); // CREATE IF NOT EXISTS cannot repair the existing table.
  await expect(importLedger({ sourcePath, target })).rejects.toThrow(/schema/i);
  expect(await target.query("SELECT COUNT(*) AS n FROM kv")).toEqual([{ n: 0 }]);
  client.close();
});

it("imports a pre-reason ledger upgraded by the supported ALTER without changing its source", async () => {
  const sourcePath = join(dir, "source-upgraded-reason.sqlite");
  const source = new DatabaseSync(sourcePath);
  source.exec(LEDGER_SCHEMA.replace("  reason TEXT NOT NULL DEFAULT 'other',\n", ""));
  for (const id of ["I-ZZZ", "I-AAA"]) source.prepare("INSERT INTO sandbox_subscribers (subscription_id,label,segment,created_at) VALUES (?,?,?,?)")
    .run(id, id, "cancel_intent", "2026-01-01T00:00:00.000Z");
  source.exec("ALTER TABLE sandbox_subscribers ADD COLUMN reason TEXT NOT NULL DEFAULT 'other'");
  source.prepare("UPDATE sandbox_subscribers SET reason='price' WHERE subscription_id='I-ZZZ'").run();
  expect(source.prepare("PRAGMA table_info(sandbox_subscribers)").all().map((row) => row.name)).toEqual(["subscription_id", "label", "segment", "created_at", "reason"]);
  source.close();
  const before = readFileSync(sourcePath);
  const dryRun = await importLedger({ sourcePath, dryRun: true });
  expect(dryRun.tables.find((entry) => entry.table === "sandbox_subscribers")?.count).toBe(2);
  const client = createClient({ url: `file:${join(dir, "target-upgraded-reason.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  const applied = await importLedger({ sourcePath, target });
  expect(applied.tables).toEqual(dryRun.tables);
  expect(await target.query("SELECT subscription_id,reason FROM sandbox_subscribers ORDER BY rowid")).toEqual([
    { subscription_id: "I-ZZZ", reason: "price" }, { subscription_id: "I-AAA", reason: "other" },
  ]);
  expect(readFileSync(sourcePath)).toEqual(before);
  client.close();
});

it("imports an M4 source without webhook events into the checked canonical target", async () => {
  const sourcePath = join(dir, "source-m4-no-webhooks.sqlite");
  const source = new DatabaseSync(sourcePath);
  const oldSchema = LEDGER_SCHEMA.replace(/CREATE TABLE IF NOT EXISTS paypal_webhook_events \([\s\S]*?\n\);\n/, "");
  source.exec(oldSchema);
  source.prepare("INSERT INTO observations (subscription_id,observed_at,status,source) VALUES (?,?,?,?)").run("I-FIXTURE", "2026-10-26T00:00:00Z", "ACTIVE", "paypal.status");
  source.close();
  const before = readFileSync(sourcePath);
  const client = createClient({ url: `file:${join(dir, "target-m4-no-webhooks.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  const result = await importLedger({ sourcePath, target });
  expect(result.tables.find(({ table }) => table === "paypal_webhook_events")?.count).toBe(0);
  expect(await target.query("SELECT COUNT(*) AS n FROM observations")).toEqual([{ n: 1 }]);
  expect(await target.query("PRAGMA foreign_key_check")).toEqual([]);
  expect(readFileSync(sourcePath)).toEqual(before);
  client.close();
});

it("preserves event-to-observation relationships across a safe import", async () => {
  const sourcePath = join(dir, "source-with-webhooks.sqlite");
  const source = new DatabaseSync(sourcePath);
  source.exec(`PRAGMA foreign_keys=ON; ${LEDGER_SCHEMA}`);
  source.prepare("INSERT INTO observations (subscription_id,observed_at,status,source) VALUES (?,?,?,?)").run("I-FIXTURE", "2026-10-26T00:00:00Z", "ACTIVE", "paypal.webhook");
  source.prepare("INSERT INTO paypal_webhook_events (event_id,event_type,event_at,received_at,subscription_id,disposition,observation_id) VALUES (?,?,?,?,?,?,?)")
    .run("WH-SYNTHETIC", "BILLING.SUBSCRIPTION.ACTIVATED", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", "I-FIXTURE", "observed", 1);
  source.close();
  const client = createClient({ url: `file:${join(dir, "target-with-webhooks.sqlite")}` });
  const target = createLibsqlConnection(client);
  await initializeLedgerSchema(target);
  await importLedger({ sourcePath, target });
  expect(await target.query("SELECT event_id,observation_id FROM paypal_webhook_events")).toEqual([{ event_id: "WH-SYNTHETIC", observation_id: 1 }]);
  expect(await target.query("PRAGMA foreign_key_check")).toEqual([]);
  client.close();
});

it.each([
  ["missing field", (schema: string) => schema.replace("  reason TEXT NOT NULL DEFAULT 'other',\n", "")],
  ["extra field", (schema: string) => schema.replace("  created_at TEXT NOT NULL\n);", "  created_at TEXT NOT NULL,\n  extra TEXT\n);")],
  ["changed type", (schema: string) => schema.replace("  segment TEXT NOT NULL,", "  segment INTEGER NOT NULL,")],
  ["changed nullability", (schema: string) => schema.replace("  label TEXT NOT NULL,", "  label TEXT,")],
  ["changed default", (schema: string) => schema.replace("reason TEXT NOT NULL DEFAULT 'other'", "reason TEXT NOT NULL DEFAULT 'price'")],
  ["changed primary key", (schema: string) => schema.replace("subscription_id TEXT PRIMARY KEY", "subscription_id TEXT NOT NULL")],
])("still rejects a source with %s", async (name, alter) => {
  const path = join(dir, `source-invalid-${name.replaceAll(" ", "-")}.sqlite`);
  const source = new DatabaseSync(path);
  source.exec(alter(LEDGER_SCHEMA));
  source.close();
  await expect(importLedger({ sourcePath: path, dryRun: true })).rejects.toThrow(/schema/i);
});

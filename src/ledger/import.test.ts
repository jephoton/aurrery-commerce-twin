import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { afterAll, expect, it } from "vitest";
import { createLibsqlConnection, initializeLedgerSchema } from "./connection";
import { LEDGER_SCHEMA } from "./db";
import { hashAction, PriceOverrideActionSchema } from "./proposals";
import { STARTER_STRATEGIES } from "@/merchant/candidates";
import { importLedger } from "./import";

const dir = mkdtempSync(join(tmpdir(), "aurrery-import-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows native client lock. */ } });

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

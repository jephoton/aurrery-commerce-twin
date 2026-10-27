import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it, vi } from "vitest";
import { createLibsqlConnection, createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";
import { classifyFeedback } from "./classify";
import { createPredictionCache } from "./cache";
import { emptyMetrics, type ClassificationProvider } from "./providers";
import type { ModelInput } from "./contracts";

it("warms 200 cache entries with one bounded read and writes an accepted batch together", async () => {
  const raw = new DatabaseSync(":memory:");
  const local = createLocalConnection(raw);
  await initializeLedgerSchema(local);
  const queries: string[] = [];
  const connection = { ...local, query: async (sql: string, args?: readonly (string | number | bigint | Uint8Array | null)[]) => {
    queries.push(sql);
    return local.query(sql, args);
  } };
  const cache = createPredictionCache(connection);
  const inputs: ModelInput[] = Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}`, text: `message ${i}`, source: "support", segment: "core" }));
  const provider: ClassificationProvider = { provider: "groq", model: "fixture", classify: vi.fn(async (batch: ModelInput[]) => ({
    payload: { items: batch.map(({ id }) => ({ id, intent: "stay", reason: "other", confidence: .9 })) }, metrics: emptyMetrics(), terminal: false,
  })) };
  const first = await classifyFeedback(inputs, { provider, cache });
  expect(first.accepted).toHaveLength(200);
  expect(await local.query("SELECT COUNT(*) AS n FROM feedback_prediction_cache")).toMatchObject([{ n: 200 }]);
  queries.length = 0;
  const second = await classifyFeedback(inputs, { provider, cache });
  expect(second.cacheHits).toBe(200);
  expect(queries.filter((sql) => sql.includes("feedback_prediction_cache"))).toHaveLength(1);
  expect(provider.classify).toHaveBeenCalledTimes(10);
  raw.close();
});

it("persists a 200 item bulk cache through a libSQL file client restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-cache-libsql-"));
  const path = join(dir, "cache.sqlite");
  const inputs: ModelInput[] = Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}`, text: `message ${i}`, source: "support", segment: "core" }));
  const context = { provider: "groq" as const, model: "fixture" };
  try {
    const firstClient = createClient({ url: `file:${path}` });
    const first = createLibsqlConnection(firstClient);
    await initializeLedgerSchema(first);
    await createPredictionCache(first).setMany!(inputs.map((input) => ({ input, prediction: { id: input.id, intent: "stay", reason: "other", confidence: .9 } })), context);
    firstClient.close();
    const secondClient = createClient({ url: `file:${path}` });
    const second = createLibsqlConnection(secondClient);
    await initializeLedgerSchema(second);
    expect((await createPredictionCache(second).getMany!(inputs, context)).size).toBe(200);
    secondClient.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows native client lock. */ } }
});

it("keeps single-item cache methods usable when injected as callbacks", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db);
  await initializeLedgerSchema(connection);
  const { get, set } = createPredictionCache(connection);
  const input: ModelInput = { id: "callback", text: "fixture", source: "support", segment: "core" };
  const context = { provider: "groq" as const, model: "fixture" };
  await set(input, context, { id: input.id, intent: "stay", reason: "other", confidence: .9 });
  expect(await get(input, context)).toMatchObject({ id: input.id });
  db.close();
});

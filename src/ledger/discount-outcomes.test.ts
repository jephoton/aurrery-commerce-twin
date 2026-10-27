import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createLocalConnection, initializeLedgerSchema } from "./connection";
import { deriveDiscountOutcomes, type DiscountEpisode, type DiscountFact } from "./discount-outcomes";
import { recordTarget } from "@/execution/execute";
import { observedMerchant } from "@/merchant/observed";
import { currentMerchant } from "@/merchant";
import { createClient } from "@libsql/client";
import { createLibsqlConnection } from "./connection";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestVerifiedWebhook } from "./webhooks";

const at = (day: number) => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
const episode: DiscountEpisode = { executionId: 1, subscriptionId: "I-PILOT", segment: "core", reason: "price", startedAt: at(0), endsAt: at(30), discountedPrice: "18.00" };
const fact = (day: number, status = "ACTIVE", price: string | null = "18.00"): DiscountFact => ({ subscriptionId: "I-PILOT", observedAt: at(day), status, regularPrice: price });
const derive = (facts: DiscountFact[], episodes = [episode], now = at(60)) => deriveDiscountOutcomes(episodes, facts, now);
it("returns canonical copies that callers cannot mutate", () => {
  const expected = structuredClone(currentMerchant());
  const copy = currentMerchant();
  copy.twin.params.offerChurnRelativeRisk.price.shape += 100;
  expect(currentMerchant()).toEqual(expected);
});

it("requires later matched-price ACTIVE evidence and reports fractional 30-day months", () => {
  expect(derive([fact(0)]).subscriberMonths).toBe(0);
  expect(derive([fact(0), fact(15)]).subscriberMonths).toBe(.5);
  expect(derive([fact(15), fact(0), fact(15)]).subscriberMonths).toBe(.5);
  expect(derive([fact(60)]).subscriberMonths).toBe(1);
  expect(derive([fact(15)], [episode], at(10)).subscriberMonths).toBe(0);
});
it("does not turn payment/unknown price facts or silence into exposure", () => {
  expect(derive([fact(0), fact(15, "PAYMENT_COMPLETED", null), fact(20, "ACTIVE", null)]).subscriberMonths).toBe(0);
});
it("caps at restore/nonactive and never counts time to an unknown-price boundary", () => {
  for (const boundary of [fact(20, "ACTIVE", "24.00"), fact(20, "SUSPENDED", null), fact(20, "EXPIRED", null)]) {
    const outcome = derive([fact(0), fact(15), boundary, fact(25)]);
    expect(outcome.subscriberMonths).toBe(.5);
    expect(outcome.cancellations).toBe(0);
  }
});
it("does not bridge failed/unknown state, or attribute cancellation after a verified restore", () => {
  for (const boundary of [fact(10, "PAYMENT_FAILED", null), fact(10, "ACTIVE", null), fact(10, "UNKNOWN", null)]) expect(derive([fact(5), boundary, fact(20)]).subscriberMonths).toBe(5 / 30);
  expect(derive([fact(5), fact(10, "ACTIVE", "24.00"), fact(15, "CANCELLED", null)]).cancellations).toBe(0);
});
it("censors preceding survival when cancellation follows an uncertain state boundary", () => {
  for (const boundary of [fact(10, "PAYMENT_FAILED", null), fact(10, "ACTIVE", null), fact(10, "SUSPENDED", null)]) {
    const outcome = derive([fact(5), boundary, fact(15, "CANCELLED", null)]);
    expect(outcome.cancellations).toBe(1);
    expect(outcome.posteriorSubscriberMonths).toBe(0);
  }
});
it("handles conflicting simultaneous facts conservatively in either input order", () => {
  const facts = [fact(5), fact(15), fact(15, "SUSPENDED", null), fact(20)];
  expect(derive(facts).subscriberMonths).toBe(5 / 30);
  expect(derive([...facts].reverse())).toEqual(derive(facts));
});
it("counts one factual cancellation per episode and censors its preceding survival from posterior", () => {
  const outcome = derive([fact(0), fact(10), fact(15, "CANCELLED", null), fact(20, "CANCELLED", null), fact(25)]);
  expect(outcome.cancellations).toBe(1);
  expect(outcome.censoredEpisodes).toBe(1);
  expect(outcome.subscriberMonths).toBeCloseTo(1 / 3);
  expect(outcome.posteriorSubscriberMonths).toBe(0);
  expect(outcome.observations).toEqual([]);
});
it("does not count repeated CANCELLED polling as another factual transition across episodes", () => {
  const next = { ...episode, executionId: 2, startedAt: at(20), endsAt: at(50) };
  expect(derive([fact(0), fact(5), fact(10, "CANCELLED", null), fact(20, "CANCELLED", "18.00"), fact(25, "CANCELLED", null)], [episode, next]).cancellations).toBe(1);
});
it("splits successive actions so no subscriber time is counted twice", () => {
  const next = { ...episode, executionId: 2, startedAt: at(10), endsAt: at(40), reason: "other" as const };
  const outcome = derive([fact(0), fact(5), fact(10), fact(25)], [next, episode]);
  expect(outcome.subscriberMonths).toBeCloseTo(20 / 30);
  expect(outcome.observations.map(o => [o.reason, o.subscriberMonths])).toEqual([["price", 5 / 30], ["other", .5]]);
});

it.each(["local", "libsql"])("%s atomically snapshots only successful verified executions and derives immutable repeated views", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "aurrery-outcomes-"));
  const db = backend === "local" ? new DatabaseSync(":memory:") : null;
  const client = backend === "libsql" ? createClient({ url: `file:${join(dir, "fixture.sqlite")}` }) : null;
  const connection = db ? createLocalConnection(db) : createLibsqlConnection(client!);
  try {
    await initializeLedgerSchema(connection);
    await connection.execute("INSERT INTO sandbox_subscribers VALUES ('I-PILOT','Pilot','core','price',?)", [at(0)]);
    const action = { type: "subscription_price_override", targets: ["I-PILOT"], segment: "core", reason: "price", listPrice: "24.00", newPrice: "18.00", months: 1, campaignMonths: 0, discountPct: 25 };
    await connection.execute("INSERT INTO proposals (id,created_at,strategy_json,simulation_json,action_type,action_json,action_hash,status) VALUES ('p',?,'{}','{}','subscription_price_override',?,'fixture','executing')", [at(0), JSON.stringify(action)]);
    const snapshot = { id: "I-PILOT", status: "ACTIVE", regularPrice: "18.00", planOverridden: true, nextBillingTime: null, lastPayment: null, planId: null, raw: null };
    const outcome = { subscriptionId: "I-PILOT", ok: true, verified: true, httpStatus: 204, debugId: null, observed: snapshot, error: null };
    await recordTarget("p", {}, outcome, snapshot, connection, at(0));
    await connection.execute("UPDATE sandbox_subscribers SET reason='other'");
    expect(await connection.query("SELECT segment,reason FROM discount_episodes")).toEqual([{ segment: "core", reason: "price" }]);
    const baseline = structuredClone(currentMerchant());
    const empty = await observedMerchant(connection, at(15));
    expect(empty.twin).toEqual(baseline.twin);
    await connection.execute("INSERT INTO observations (subscription_id,observed_at,status,regular_price,source) VALUES ('I-PILOT',?,'ACTIVE','18.00','paypal.status')", [at(15)]);
    const first = await observedMerchant(connection, at(20));
    expect(first.evidence.posteriorSubscriberMonths).toBe(.5);
    expect(first.changes).toHaveLength(1);
    expect(await observedMerchant(connection, at(20))).toEqual(first);
    expect(currentMerchant()).toEqual(baseline);
    // Repeated/failed/unverified execution cannot create another calibration episode.
    await connection.execute("INSERT INTO proposals SELECT 'failed',created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by,completed_at,revert_after FROM proposals WHERE id='p'");
    await recordTarget("failed", {}, { ...outcome, ok: false }, snapshot, connection, at(16));
    await connection.execute("INSERT INTO proposals SELECT 'unverified',created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by,completed_at,revert_after FROM proposals WHERE id='p'");
    await recordTarget("unverified", {}, { ...outcome, verified: false }, snapshot, connection, at(17));
    expect(await connection.query("SELECT COUNT(*) AS n FROM discount_episodes")).toEqual([{ n: 1 }]);
    await connection.execute("INSERT INTO proposals SELECT 'changed-reason',created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by,completed_at,revert_after FROM proposals WHERE id='p'");
    await recordTarget("changed-reason", {}, outcome, snapshot, connection, at(17));
    expect(await connection.query("SELECT COUNT(*) AS n FROM discount_episodes")).toEqual([{ n: 1 }]);
    await connection.execute("UPDATE sandbox_subscribers SET reason='price'");
    // A failure to persist the snapshot rolls back execution+observation as one transaction.
    await connection.executeMultiple("CREATE TRIGGER fail_episode BEFORE INSERT ON discount_episodes BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    await connection.execute("INSERT INTO proposals SELECT 'rollback',created_at,objective,strategy_json,simulation_json,action_type,action_json,action_hash,status,approved_at,approved_by,completed_at,revert_after FROM proposals WHERE id='p'");
    const before = await connection.query("SELECT COUNT(*) AS n FROM observations");
    await expect(recordTarget("rollback", {}, outcome, snapshot, connection, at(18))).rejects.toThrow();
    expect(await connection.query("SELECT COUNT(*) AS n FROM observations")).toEqual(before);
    expect(await connection.query("SELECT COUNT(*) AS n FROM executions WHERE proposal_id='rollback'")).toEqual([{ n: 0 }]);
    const cancellation = { id: "WH-FIXTURE-CANCEL", event_type: "BILLING.SUBSCRIPTION.CANCELLED", create_time: at(18), resource: { id: "I-PILOT" } };
    await ingestVerifiedWebhook(connection, cancellation, at(20));
    expect(await ingestVerifiedWebhook(connection, cancellation, at(21))).toBe("duplicate");
    await connection.execute("INSERT INTO observations (subscription_id,observed_at,status,source) VALUES ('I-PILOT',?,'CANCELLED','paypal.status')", [at(19)]);
    const censored = await observedMerchant(connection, at(25));
    expect(censored.evidence.cancellations).toBe(1);
    expect(censored.evidence.posteriorSubscriberMonths).toBe(0);
    expect(censored.changes).toEqual([]);
    expect(censored.twin).toEqual(baseline.twin);
  } finally { db?.close(); client?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Native Windows file handle. */ } }
});

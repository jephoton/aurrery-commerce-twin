import { expect, it, vi } from "vitest";
import { createAgentHandler } from "./http";
import { acquireAgentLease, claimAgentLease } from "./limits";
import type { RunOptions, RunResult } from "./run";
import { readAgentStream } from "./stream";
import { samplePayload } from "@/test/import-fixture";

const request = (body: unknown, signal?: AbortSignal) => new Request("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body), signal });
const result: RunResult = { status: "incomplete", reason: "NO_PROPOSAL", counters: { requestedTools: 0, executedTools: 0, modelTurns: 1, accountedTokens: 0, reportedTokens: 0, httpRequests: 0, elapsedMs: 0 }, transcript: [], requests: [] };
const runner = async (o: RunOptions) => { claimAgentLease(o.lease!); try { o.emit?.({ type: "status", message: o.objective }); o.emit?.({ type: "done", status: "incomplete", reason: "NO_PROPOSAL" }); return result; } finally { o.lease!.release(); } };
it.each([{}, { objective: " " }, { objective: "x".repeat(2001) }, { objective: "ok", env: {} }, { objective: 3 }, [], null])("validates strict request bodies before runner or lease acquisition", async body => {
  const run = vi.fn(runner), acquire = vi.fn(acquireAgentLease);
  const response = await createAgentHandler({ run, acquire })(request(body));
  expect(response.status).toBe(400);
  expect(run).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
});
it("bounds body bytes and rejects malformed JSON", async () => {
  const run = vi.fn(runner);
  for (const body of ["x".repeat(20000), "{"]) {
    const response = await createAgentHandler({ run })(new Request("http://localhost", { method: "POST", body }));
    expect([400, 413]).toContain(response.status);
  }
  expect(run).not.toHaveBeenCalled();
});
it("returns 409 when the shared process lease is busy", async () => {
  const lease = acquireAgentLease();
  try { expect((await createAgentHandler({ run: runner })(request({ objective: "Explore" }))).status).toBe(409); }
  finally { lease.release(); }
});
it("streams trimmed public events with ordered frames and no caching", async () => {
  const response = await createAgentHandler({ run: runner })(request({ objective: " Explore " }));
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const onEvent = vi.fn();
  await readAgentStream(response, { onEvent });
  expect(onEvent.mock.calls[0][0]).toEqual({ type: "status", message: "Explore" });
  const lease = acquireAgentLease(); lease.release();
});
it("removes the request listener when the run finishes", async () => {
  const controller = new AbortController();
  let runSignal: AbortSignal | undefined;
  const response = await createAgentHandler({ run: async o => { runSignal = o.signal; return runner(o); } })(request({ objective: "Explore" }, controller.signal));
  await response.text(); controller.abort();
  expect(runSignal?.aborted).toBe(false);
});
it("sanitizes asynchronous runner exceptions, terminates and releases the lease", async () => {
  const response = await createAgentHandler({ run: async () => { throw new Error("secret-token database path"); } })(request({ objective: "Explore" }));
  const text = await response.text();
  expect(text).not.toMatch(/secret-token|database path/);
  expect(text).toContain('"status":"incomplete"');
  const lease = acquireAgentLease(); lease.release();
});
it("keeps terminal sequence valid when an oversized event cannot be sent", async () => {
  const response = await createAgentHandler({ run: async o => { o.emit?.({ type: "summary", message: "x".repeat(600000) }); return result; } })(request({ objective: "Explore" }));
  await expect(readAgentStream(response, { onEvent() {} })).resolves.toMatchObject({ status: "incomplete" });
});
it("sends one error followed by done if a runner throws after reporting its safe error", async () => {
  const response = await createAgentHandler({ run: async o => { o.emit?.({ type: "error", code: "SAFE", message: "Run incomplete." }); throw new Error("secret"); } })(request({ objective: "Explore" }));
  await expect(readAgentStream(response, { onEvent() {} })).resolves.toMatchObject({ status: "incomplete" });
});
it.each(["request", "reader"])("propagates %s cancellation to work and cleans up its lease", async kind => {
  const controller = new AbortController();
  let aborted = false;
  const response = await createAgentHandler({ run: async o => {
    claimAgentLease(o.lease!);
    try { await new Promise<void>(resolve => { o.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); }); return result; }
    finally { o.lease!.release(); }
  } })(request({ objective: "Explore" }, controller.signal));
  if (kind === "request") controller.abort(); else await response.body!.cancel();
  await vi.waitFor(() => expect(aborted).toBe(true));
  const lease = acquireAgentLease(); lease.release();
});
it("passes a valid import to the runner as a rebuilt twin", async () => {
  for (const feedback of [true, false]) {
    let seen: RunOptions["imported"];
    const run = vi.fn(async (o: RunOptions) => { seen = o.imported; return runner(o); });
    const response = await createAgentHandler({ run })(request({ objective: "Explore", import: samplePayload({ feedback }) }));
    await readAgentStream(response, { onEvent() {} });
    expect(seen?.twin.merchant).toMatchObject({ id: "imported-csv", name: "Hollowbrook Treat Box" });
    expect(seen).toMatchObject(feedback ? { feedbackRows: 40, reasonTargeting: true, reasonCounts: samplePayload().reasonCounts } : { feedbackRows: 0, reasonTargeting: false });
    if (!feedback) expect(seen?.reasonCounts).toBeUndefined();
  }
  let plain: RunOptions | undefined;
  await readAgentStream(await createAgentHandler({ run: async (o) => { plain = o; return runner(o); } })(request({ objective: "Explore" })), { onEvent() {} });
  expect(plain && "imported" in plain).toBe(false);
});
it("refuses an invalid import with fixed row errors before the lease or the runner", async () => {
  const broken = samplePayload();
  broken.rows[12][3] = 999_999;
  const unknownKey = { ...samplePayload(), secretSentinelKey: 1 };
  const badCell = samplePayload() as unknown as { rows: unknown[][] };
  badCell.rows[0][2] = "lots";
  const cases: [unknown, Record<string, unknown>][] = [
    [broken, { row: 14, column: "voluntary_cancels" }],
    [unknownKey, { row: null, message: "unexpected field" }],
    [badCell, { row: 2, column: "active_start" }],
    ["not an import", { row: null }],
  ];
  for (const [payload, expected] of cases) {
    const run = vi.fn(runner), acquire = vi.fn(acquireAgentLease);
    const response = await createAgentHandler({ run, acquire })(request({ objective: "Explore", import: payload }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("secretSentinelKey");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ error: "INVALID_IMPORT", message: "The import has errors. Nothing was changed." });
    expect(body.errors[0]).toMatchObject(expected);
    expect(run).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  }
});
it("accepts a large import beside the longest objective but still bounds the body", async () => {
  const huge = await createAgentHandler({ run: vi.fn(runner) })(request({ objective: "Explore", padding: "y".repeat(70_000) }));
  expect(huge.status).toBe(413);
  const payload = samplePayload();
  // 300 rows of 8-digit counts: the largest legal history (decision 4).
  payload.rows = Array.from({ length: 300 }, (_, i) => [...payload.rows[i % payload.rows.length]] as typeof payload.rows[number]);
  const body = JSON.stringify({ objective: "x".repeat(2000), import: payload }).replace(/(,|\[)(\d{1,7})(?=[,\]])/g, (_, p: string, n: string) => p + n.padStart(8, "1"));
  expect(body.length).toBeGreaterThan(30_000);
  const response = await createAgentHandler({ run: vi.fn(runner) })(new Request("http://localhost/api/agent", { method: "POST", body }));
  // The repeated months are invalid rows: the body was read in full and refused as an import, not for its size.
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "INVALID_IMPORT" });
});

import { expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session";

const response = (message: string) => new Response(JSON.stringify({ runId: "r1", seq: 1, event: { type: "summary", message } }) + "\n" + JSON.stringify({ runId: "r1", seq: 2, event: { type: "done", status: "complete" } }) + "\n");
it("ignores late events and completion from a stopped run after a new run starts", async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => fetcher.mock.calls.length === 1 ? new Promise<Response>(resolve => { resolveOld = resolve; }) : response("new"));
  const session = new AgentSession();
  const onEvent = vi.fn(), onResult = vi.fn(), onError = vi.fn(), onFinish = vi.fn();
  const options = { fetch: fetcher, onEvent, onResult, onError, onFinish };
  const first = session.run("old", options);
  session.stop();
  await session.run("new", options);
  resolveOld(response("old")); await first;
  expect(onEvent.mock.calls.map(call => call[0].message).filter(Boolean)).toEqual(["new"]);
  expect(onResult).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(onFinish).toHaveBeenCalledOnce();
  expect(session.active).toBe(false);
});
it("keeps one active request through duplicate start attempts and aborts its fetch on stop", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
  const session = new AgentSession();
  const options = { fetch: fetcher, onEvent() {}, onResult() {}, onError() {}, onFinish() {} };
  void session.run("first", options);
  await session.run("duplicate", options);
  expect(fetcher).toHaveBeenCalledOnce();
  session.stop();
  expect(signal?.aborted).toBe(true);
  expect(session.active).toBe(false);
});

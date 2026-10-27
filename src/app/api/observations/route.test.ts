import { expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("next/server", () => ({ connection: async () => { calls.push("connection"); } }));
vi.mock("@/ledger/webhooks", () => ({ listSafeObservations: async () => { calls.push("storage"); return [{ id: 1, source: "paypal.webhook", eventType: "BILLING.SUBSCRIPTION.ACTIVATED" }]; } }));

import { GET } from "./route";

it("waits for Next request time before returning safe observation summaries", async () => {
  const response = await GET();
  expect(calls).toEqual(["connection", "storage"]);
  expect(await response.json()).toEqual({ observations: [{ id: 1, source: "paypal.webhook", eventType: "BILLING.SUBSCRIPTION.ACTIVATED" }] });
});

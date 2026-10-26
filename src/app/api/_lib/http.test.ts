import { expect, it, vi } from "vitest";
import { ExecutionReconciliationRequired } from "@/execution/execute";
import { errorResponse } from "./http";

it("does not disclose unexpected error contents in response or console", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = errorResponse(new Error("secret token at C:/private/path"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret token|private\/path/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret token|private\/path/);
  } finally { log.mockRestore(); }
});

it("reports an unresolved PayPal execution without exposing storage details", async () => {
  const response = errorResponse(new ExecutionReconciliationRequired("prop_123"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "RECONCILIATION_REQUIRED", proposalId: "prop_123", message: expect.stringMatching(/outcome.*unconfirmed/i) });
});

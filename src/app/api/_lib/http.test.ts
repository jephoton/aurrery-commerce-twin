import { expect, it, vi } from "vitest";
import { ExecutionReconciliationRequired } from "@/execution/execute";
import { errorResponse, invalidImportResponse, readBoundedJson } from "./http";

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

it("reads up to a caller-chosen size and rejects anything larger", async () => {
  const post = (value: string) => new Request("http://localhost/api", { method: "POST", body: value });
  const body = JSON.stringify({ text: "x".repeat(70_000) });
  await expect(readBoundedJson(post(body))).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  expect(await readBoundedJson(post(body), { maxBytes: 128 * 1024 })).toEqual({ text: "x".repeat(70_000) });
  await expect(readBoundedJson(post("[1,2,3]"), { maxBytes: 4 })).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
});

it("returns capped per-row import errors", async () => {
  const errors = Array.from({ length: 60 }, (_, i) => ({ row: i + 2, column: "month", message: "must be YYYY-MM" }));
  const response = invalidImportResponse(errors);
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: "INVALID_IMPORT", message: "The import has errors. Nothing was changed." });
  expect(body.errors).toHaveLength(51);
});

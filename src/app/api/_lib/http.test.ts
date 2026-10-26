import { expect, it, vi } from "vitest";
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

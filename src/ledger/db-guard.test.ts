import { expect, it, vi } from "vitest";
import { ledger } from "./db";

it.each([{ LEDGER_BACKEND: "turso" }, { RENDER: "true" }])("rejects raw local access when hosted storage is selected (%j)", (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  try { expect(() => ledger()).toThrow(/Raw local ledger/); }
  finally { vi.unstubAllEnvs(); }
});

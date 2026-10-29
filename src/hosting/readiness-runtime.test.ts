import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLocalConnection, initializeLedgerSchema } from "@/ledger/connection";

const runtime = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/ledger/connection", async original => ({ ...await original<typeof import("@/ledger/connection")>(), runtimeLedgerConnection: runtime.open }));

it("probes authoritative storage without business, audit, session or quota rows and without provider HTTP", async () => {
  const db = new DatabaseSync(":memory:");
  const connection = createLocalConnection(db); await initializeLedgerSchema(connection);
  runtime.open.mockResolvedValue(connection);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const before = db.prepare("SELECT total_changes() AS n").get();
  try {
    const { readiness } = await import("./readiness");
    expect(runtime.open).not.toHaveBeenCalled();
    expect((await readiness()).status).toBe(200);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); db.close(); }
});

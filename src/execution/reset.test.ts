import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { PILOT_COHORT } from "@/paypal/pilot-cohort";
import { previewDemoReset, previewDemoResetWith } from "./reset";
import * as ledger from "@/ledger/connection";
import * as paypal from "@/paypal/subscriptions";

afterEach(() => vi.restoreAllMocks());

for (const status of ["ACTIVE", "SUSPENDED"]) {
  it.each([
    ["malformed ID", "not-an-id", "2026-01-01T00:00:00.000Z"],
    ["ID containing a path", "I-B/OTHER", "2026-01-01T00:00:00.000Z"],
    ["malformed date", "I-B", "not-a-date"],
    ["date without timestamp", "I-B", "2026-01-01"],
  ])(`rejects %s for a would-be ${status === "ACTIVE" ? "already-list" : "inactive"} pilot before any cohort SDK read`, async (_name, subscriptionId, createdAt) => {
    const read = vi.fn(async (id: string) => ({ ok: true, value: { id, status, regularPrice: "24.00", planOverridden: true }, debugId: null } as never));
    const create = vi.fn();
    await expect(previewDemoResetWith({ list: async () => [
      { subscriptionId: "I-A", ...PILOT_COHORT[0] }, { subscriptionId, ...PILOT_COHORT[1] },
    ], registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z", [subscriptionId]: createdAt }),
      read, create, listPrice: () => 24 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
}

it("ignores malformed unrelated registry labels while reporting missing cohort members", async () => {
  const read = vi.fn(async (id: string) => ({ ok: true, value: { id, status: "ACTIVE", regularPrice: "24.00" }, debugId: null } as never));
  const create = vi.fn();
  const preview = await previewDemoResetWith({ list: async () => [
    { subscriptionId: "I-A", ...PILOT_COHORT[0] },
    { subscriptionId: "invalid-extra", label: "unrelated", segment: "invalid", reason: "other" },
  ], registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z", "invalid-extra": "not-a-date" }), read, create, listPrice: () => 24 });
  expect(preview.proposal).toBeNull(); expect(read.mock.calls).toEqual([["I-A"]]); expect(create).not.toHaveBeenCalled();
  expect(preview.skipped).toEqual([
    { label: PILOT_COHORT[0].label, subscriptionId: "I-A", reason: "already_list_price" },
    ...PILOT_COHORT.slice(1).map((pilot) => ({ label: pilot.label, subscriptionId: null, reason: "unregistered" })),
  ]);
});

it("does not normalize invalid registry attributes into an already-list no-op", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const connection = ledger.createLocalConnection(db); await ledger.initializeLedgerSchema(connection);
    await connection.execute("INSERT INTO sandbox_subscribers VALUES (?,?,?,?,?)", ["I-C", PILOT_COHORT[2].label, PILOT_COHORT[2].segment, "invalid", "2026-01-01T00:00:00.000Z"]);
    vi.spyOn(ledger, "runtimeLedgerConnection").mockResolvedValue(connection);
    const read = vi.spyOn(paypal, "getSubscription").mockResolvedValue({ ok: true, value: { id: "I-C", status: "ACTIVE", regularPrice: "24.00" }, debugId: null } as never);
    await expect(previewDemoReset()).rejects.toThrow(/registration/i);
    expect(read).not.toHaveBeenCalled();
    expect(await connection.query("SELECT * FROM proposals")).toEqual([]);
  } finally { db.close(); }
});

it.each([null, "", "1.8e1", "18.000", "018.00", "unknown"])("rejects an unverifiable ACTIVE price %s before persistence", async (regularPrice) => {
  const create = vi.fn();
  await expect(previewDemoResetWith({ list: async () => [{ subscriptionId: "I-A", ...PILOT_COHORT[0] }],
    registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z" }),
    read: async () => ({ ok: true, value: { id: "I-A", status: "ACTIVE", regularPrice } }) as never,
    create, listPrice: () => 24 })).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("reports each unregistered cohort member without reading or creating anything", async () => {
  const read = vi.fn(); const create = vi.fn();
  const preview = await previewDemoResetWith({ list: async () => [], registrations: async () => ({}), read, create, listPrice: () => 24 });
  expect(preview.proposal).toBeNull();
  expect(preview.skipped).toEqual(PILOT_COHORT.map((pilot) => ({ label: pilot.label, subscriptionId: null, reason: "unregistered" })));
  expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

it("previews only currently registered pilots, reports list-priced and inactive pilots, and proposes only actionable prices", async () => {
  const read = vi.fn().mockImplementation(async (id: string) => ({ ok: true, value: {
    id, status: id === "I-C" ? "SUSPENDED" : "ACTIVE", regularPrice: id === "I-A" ? "18.0" : "24.00", planOverridden: true,
  } }));
  const create = vi.fn().mockResolvedValue({ id: "reset", status: "proposed" });
  const result = await previewDemoResetWith({ list: async () => [
    { subscriptionId: "I-A", ...PILOT_COHORT[0] }, { subscriptionId: "I-B", ...PILOT_COHORT[1] },
    { subscriptionId: "I-C", ...PILOT_COHORT[2] }, { subscriptionId: "I-EXTRA", label: "unrelated", segment: "core", reason: "other" },
  ], registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z", "I-B": "2026-01-01T00:00:00.000Z", "I-C": "2026-01-01T00:00:00.000Z" }),
    read, create, listPrice: () => 24 });
  expect(read.mock.calls.map(([id]) => id)).toEqual(["I-A", "I-B", "I-C"]);
  expect(create).toHaveBeenCalledWith("24.00", [expect.objectContaining({ subscriptionId: "I-A", expectedCurrentPrice: "18.0" })]);
  expect(result).toMatchObject({ proposal: { id: "reset" }, skipped: [
    { subscriptionId: "I-B", reason: "already_list_price" }, { subscriptionId: "I-C", reason: "inactive" },
    { subscriptionId: null, reason: "unregistered", label: PILOT_COHORT[3].label },
  ] });
});

it("rejects a mismatched PayPal identity without creating a reset proposal", async () => {
  const create = vi.fn();
  await expect(previewDemoResetWith({ list: async () => [{ subscriptionId: "I-A", ...PILOT_COHORT[0] }],
    registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z" }),
    read: async () => ({ ok: true, value: { id: "I-WRONG", status: "ACTIVE", regularPrice: "18.00" } }) as never,
    create, listPrice: () => 24 })).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it.each(["duplicate label", "duplicate identity", "attributes"])("fails closed on ambiguous or invalid registry %s", async (change) => {
  const pilot = { subscriptionId: "I-A", ...PILOT_COHORT[0] };
  const list = change === "duplicate label" ? [pilot, { ...pilot, subscriptionId: "I-B" }] :
    change === "duplicate identity" ? [pilot, { ...pilot, ...PILOT_COHORT[1] }] : [{ ...pilot, reason: "other" as const }];
  const create = vi.fn(); const read = vi.fn();
  await expect(previewDemoResetWith({ list: async () => list, registrations: async () => ({ "I-A": "2026-01-01T00:00:00.000Z" }), read, create, listPrice: () => 24 })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

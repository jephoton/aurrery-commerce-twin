import { beforeEach, expect, it, vi } from "vitest";
import { ledger } from "@/ledger/db";
import { setSetting } from "@/ledger/operations";
import { listSandboxSubscribers, registerSandboxSubscriber } from "@/ledger/proposals";
import { setupPilots, syncPilots, PILOT_COHORT } from "./setup";
import type { Result, SubscriptionSnapshot } from "./subscriptions";

const transport = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }));
vi.mock("./client", () => ({ paypal: () => ({ subscriptions: { createSubscription: transport.create } }) }));
vi.mock("./subscriptions", () => ({ getSubscription: transport.read }));

const options = { planId: "P-TEST", returnUrl: "http://localhost:3000/?paypal=approved" };
const link = "https://example.test/approve";
const snapshot = (id: string, status = "APPROVAL_PENDING", href: string | null = link): Result<SubscriptionSnapshot> => ({
  ok: true, debugId: null,
  value: { id, status, planId: "P-TEST", planOverridden: false, regularPrice: null, nextBillingTime: null, lastPayment: null,
    raw: { id, links: href ? [{ rel: "approve", href }] : [] } },
});
const failure = (httpStatus: number | null): Result<SubscriptionSnapshot> => ({
  ok: false, error: { httpStatus, name: "READ_FAILED", message: "test read failed", debugId: null, details: null },
});
async function seed() {
  for (const [i, member] of PILOT_COHORT.entries()) await registerSandboxSubscriber({ ...member, subscriptionId: `I-OLD${i}` });
}

beforeEach(async () => {
  ledger().exec("DELETE FROM sandbox_subscribers; DELETE FROM observations; DELETE FROM kv;");
  vi.resetAllMocks();
  transport.read.mockImplementation(async (id: string) => snapshot(id));
  let created = 0;
  transport.create.mockImplementation(async () => ({ result: { id: created++ === 0 ? "I-NEW" : `I-NEW${created}`, links: [{ rel: "approve", href: "https://example.test/create" }] } }));
});

it("reuses healthy pilots without POST and resumes pending approval links from GET", async () => {
  await seed();
  transport.read.mockImplementation(async (id: string) => snapshot(id, id === "I-OLD0" ? "ACTIVE" : "APPROVAL_PENDING"));
  const messages = await setupPilots(options);
  expect(transport.create).not.toHaveBeenCalled();
  expect(transport.read).toHaveBeenCalledTimes(4);
  expect(messages[0]).toContain("ACTIVE");
  expect(messages[0]).not.toMatch(/approve|personal account/i);
  expect(messages[1]).toContain(link);
});

it("refuses an existing 404 by default and leaves the registry unchanged", async () => {
  await seed();
  transport.read.mockResolvedValue(failure(404));
  await expect(setupPilots(options)).rejects.toThrow(/404.*--recover-missing/);
  expect(transport.create).not.toHaveBeenCalled();
  expect((await listSandboxSubscribers())[0].subscriptionId).toBe("I-OLD0");
});

it("replays an adopted pilot's active creation intent while retaining legacy intent for the others", async () => {
  await seed();
  await setSetting("paypal.pilot.0.request_id", "aurrery-ridgeline-sub-0-v2");
  await setSetting("paypal.pilot.0.return_url", "http://localhost:3001/?paypal=approved");
  await setSetting("paypal.pilot.1.replacement_request_id", "not-an-active-request");
  await setSetting("paypal.pilot.1.replacement_return_url", "http://localhost:3999/pending");
  transport.read.mockImplementation(async (id: string) => id.startsWith("I-OLD") ? failure(404) : snapshot(id));
  await setupPilots({ ...options, recoverMissing: true });
  expect(transport.create.mock.calls.map(([request]) => request)).toEqual(PILOT_COHORT.map((_, i) => {
    const returnUrl = i === 0 ? "http://localhost:3001/?paypal=approved" : options.returnUrl;
    return {
      paypalRequestId: i === 0 ? "aurrery-ridgeline-sub-0-v2" : `aurrery-ridgeline-sub-${i}-v1`,
      prefer: "return=representation",
      body: { planId: options.planId, customId: `pilot-${i}`, applicationContext: { brandName: "Ridgeline Roasters", returnUrl, cancelUrl: returnUrl } },
    };
  }));
  expect(await listSandboxSubscribers()).toHaveLength(4);
});

it("never POSTs healthy pilots even when an active creation override exists", async () => {
  await seed();
  await setSetting("paypal.pilot.0.request_id", "aurrery-ridgeline-sub-0-v2");
  await setSetting("paypal.pilot.0.return_url", "http://localhost:3001/?paypal=approved");
  transport.read.mockImplementation(async (id: string) => snapshot(id, "ACTIVE"));
  const before = await listSandboxSubscribers();
  await setupPilots({ ...options, recoverMissing: true });
  expect(transport.create).not.toHaveBeenCalled();
  expect(await listSandboxSubscribers()).toEqual(before);
});

it.each([401, 403, 429, 500, null])("never recreates a pilot after a %s read failure, even with recovery enabled", async (status) => {
  await seed();
  transport.read.mockResolvedValue(failure(status));
  await expect(setupPilots({ ...options, recoverMissing: true })).rejects.toThrow(/read failed/i);
  expect(transport.create).not.toHaveBeenCalled();
});

it("recovers only a missing pilot using its exact original request, preserving order and metadata", async () => {
  await seed();
  ledger().prepare("UPDATE sandbox_subscribers SET segment = 'custom', created_at = 'original' WHERE subscription_id = 'I-OLD1'").run();
  transport.read.mockImplementation(async (id: string) => id === "I-OLD1" ? failure(404) : snapshot(id));
  const before = ledger().prepare("SELECT rowid, * FROM sandbox_subscribers ORDER BY rowid").all();
  const messages = await setupPilots({ ...options, recoverMissing: true });
  expect(transport.create).toHaveBeenCalledExactlyOnceWith({
    paypalRequestId: "aurrery-ridgeline-sub-1-v1", prefer: "return=representation",
    body: { planId: options.planId, customId: "pilot-1", applicationContext: { brandName: "Ridgeline Roasters", returnUrl: options.returnUrl, cancelUrl: options.returnUrl } },
  });
  const after = ledger().prepare("SELECT rowid, * FROM sandbox_subscribers ORDER BY rowid").all();
  expect(after).toEqual(before.map((row, i) => i === 1 ? { ...row, subscription_id: "I-NEW" } : row));
  expect(messages[1]).toContain(link);
  expect(messages[1]).not.toContain("https://example.test/create");
});

it.each([false, true])("does not register or replace when new subscription readback fails (recovery=%s)", async (recoverMissing) => {
  await seed();
  if (!recoverMissing) ledger().prepare("DELETE FROM sandbox_subscribers WHERE subscription_id = 'I-OLD0'").run();
  transport.read.mockImplementation(async (id: string) => id === "I-NEW" ? failure(500) : id === "I-OLD0" ? failure(404) : snapshot(id));
  const before = await listSandboxSubscribers();
  await expect(setupPilots({ ...options, recoverMissing })).rejects.toThrow(/read.back.*500/i);
  expect(await listSandboxSubscribers()).toEqual(before);
});

it("rejects a mismatched readback ID before registration", async () => {
  transport.read.mockResolvedValue(snapshot("I-WRONG"));
  await expect(setupPilots(options)).rejects.toThrow(/read.back.*ID/i);
  expect(await listSandboxSubscribers()).toEqual([]);
});

it.each([
  ["existing", undefined], ["new", undefined], ["recovered", undefined],
  ["existing", "I-WRONG"], ["new", "I-WRONG"], ["recovered", "I-WRONG"],
])("rejects %s readback whose actual response ID is %s despite a matching normalized ID", async (mode, actualId) => {
  await seed();
  if (mode === "new") ledger().prepare("DELETE FROM sandbox_subscribers WHERE subscription_id = 'I-OLD0'").run();
  const before = await listSandboxSubscribers();
  const onMessage = vi.fn();
  transport.read.mockImplementation(async (id: string) => {
    if (mode === "recovered" && id === "I-OLD0") return failure(404);
    const read = snapshot(id);
    if (read.ok) read.value.raw = { ...(actualId === undefined ? {} : { id: actualId }), links: [{ rel: "approve", href: link }] };
    return read;
  });
  await expect(setupPilots({ ...options, recoverMissing: mode === "recovered", onMessage })).rejects.toThrow(/read.back.*ID/i);
  expect(await listSandboxSubscribers()).toEqual(before);
  expect(onMessage).not.toHaveBeenCalled();
  expect(transport.create).toHaveBeenCalledTimes(mode === "existing" ? 0 : 1);
});

it("uses the creation approval link only after successful readback", async () => {
  transport.read.mockImplementation(async (id: string) => snapshot(id, "APPROVAL_PENDING", null));
  const messages = await setupPilots(options);
  expect(messages[0]).toContain("https://example.test/create");
  expect(await listSandboxSubscribers()).toHaveLength(4);
});

it("fails clearly when a pending pilot has no current approval link", async () => {
  await seed();
  transport.read.mockImplementation(async (id: string) => snapshot(id, "APPROVAL_PENDING", null));
  await expect(setupPilots(options)).rejects.toThrow(/APPROVAL_PENDING.*approval link/);
  expect(transport.create).not.toHaveBeenCalled();
});

it("fails sync if any read fails while still observing healthy pilots", async () => {
  await seed();
  transport.read.mockImplementation(async (id: string) => id === "I-OLD1" ? failure(404) : snapshot(id, "ACTIVE"));
  await expect(syncPilots()).rejects.toThrow(/1.*read.*failed/i);
  expect(transport.read).toHaveBeenCalledTimes(4);
  expect(ledger().prepare("SELECT COUNT(*) AS n FROM observations").get()?.n).toBe(3);
});

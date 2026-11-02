import { expect, it, vi } from "vitest";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS } from "@/import/economics";
import { buildImportedTwin, importedStarterStrategies } from "@/import/imported-twin";
import { MAX_REPORTED_ERRORS } from "@/import/row-error";
import { SAMPLE_REASON_COUNTS, sampleMerchantFiles } from "@/import/sample-merchant";
import { summarizeMerchant } from "@/merchant/summary";
import { samplePayload } from "@/test/import-fixture";
import { buildImport, createReadGuard, formatImportError, readLimitedFile } from "./import-flow";

const files = sampleMerchantFiles();
const built = buildImportedTwin(samplePayload());
if (!built.ok) throw new Error("The sample must build.");
const summary = summarizeMerchant(built.twin, built.history, { imported: { months: built.months, firstMonth: built.firstMonth, lastMonth: built.lastMonth, feedbackRows: built.feedbackRows } });

function fakeServer(replies: { classify?: () => Response; validate?: () => Response } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "/api/import/classify") return replies.classify?.() ?? Response.json({ reasonCounts: SAMPLE_REASON_COUNTS, notes: ["40 of 40 rows classified."], stopped: false });
    if (url === "/api/import/validate") return replies.validate?.() ?? Response.json({ summary, reasonTargeting: true });
    return new Response("not found", { status: 404 });
  });
}

it("checks every file locally before any request and names the source of each error", async () => {
  const fetcher = fakeServer();
  const result = await buildImport({ history: "month,segment\n", feedback: "segment,text\nvip,hi\n", economics: { ...DEFAULT_ECONOMICS, listPrice: 0 } }, fetcher);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(new Set(result.errors.map((e) => e.source))).toEqual(new Set(["history", "economics", "feedback"]));
  expect(fetcher).not.toHaveBeenCalled();
});

it("classifies feedback, then validates the payload, and builds a session", async () => {
  const fetcher = fakeServer();
  const result = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fetcher);
  expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual(["/api/import/classify", "/api/import/validate"]);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).rows).toHaveLength(40);
  const sent = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(sent).toMatchObject({ economics: SAMPLE_ECONOMICS, reasonCounts: SAMPLE_REASON_COUNTS });
  expect(sent.rows).toHaveLength(60);
  expect(sent).toEqual(samplePayload());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session.payload).toEqual(sent);
  expect(result.session.summary.name).toBe("Hollowbrook Treat Box");
  expect(result.session.reasonTargeting).toBe(true);
  // The browser derives the same starter set the server uses for this import.
  expect(result.session.starterStrategies).toEqual(importedStarterStrategies(built));
  expect(result.session.starterStrategies.map((s) => s.id)).toEqual(["at-risk-20-3m", "annual-15", "list-18", "list-23"]);
  expect(result.session.classifierNotes).toEqual(["40 of 40 rows classified."]);
});

it("gives every successful import a new session id", async () => {
  const first = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer());
  const second = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer());
  expect(first.ok && second.ok && first.session.id !== second.session.id).toBe(true);
});

it("skips classification without feedback and drops price-reason starters", async () => {
  // Enough cancel-intent subscribers that only reason targeting decides whether the price-reason save is offered.
  const busy = { ...summary, segments: summary.segments.map((s) => (s.id === "cancel_intent" ? { ...s, active: 50 } : s)) };
  const targeted = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ summary: busy, reasonTargeting: true }) }));
  expect(targeted.ok && targeted.session.starterStrategies.map((s) => s.id)).toContain("cancel-price-25-3m");
  const fetcher = fakeServer({ validate: () => Response.json({ summary: busy, reasonTargeting: false }) });
  const result = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fetcher);
  expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual(["/api/import/validate"]);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("reasonCounts");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session.starterStrategies.map((s) => s.id)).not.toContain("cancel-price-25-3m");
  expect(result.session.classifierNotes).toEqual([]);
});

it("keeps server row errors and turns other failures into one message", async () => {
  const rows = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ error: "INVALID_IMPORT", errors: [{ row: 14, column: "voluntary_cancels", message: "too many" }] }, { status: 400 }) }));
  expect(!rows.ok && rows.errors.map(formatImportError)).toEqual(["Server check · row 14, voluntary_cancels: too many"]);
  const unavailable = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fakeServer({ classify: () => Response.json({ error: "CLASSIFIER_UNAVAILABLE", message: "Feedback classification is not configured on this server." }, { status: 503 }) }));
  expect(!unavailable.ok && unavailable.errors.map(formatImportError)).toEqual(["Feedback file · Feedback classification is not configured on this server."]);
  const limited = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ error: "RATE_LIMITED" }, { status: 429 }) }));
  expect(!limited.ok && limited.errors.map(formatImportError)).toEqual(["Server check · Too many requests. Try again later."]);
  const offline = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); }));
  expect(!offline.ok && offline.errors.map(formatImportError)).toEqual(["Server check · Network error. Nothing was changed."]);
});

it("rejects malformed server replies instead of building from them", async () => {
  const badClassify = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fakeServer({ classify: () => Response.json({ reasonCounts: { new: 1 }, notes: "x" }) }));
  expect(!badClassify.ok && badClassify.errors.map(formatImportError)).toEqual(["Feedback file · The server sent an unexpected reply. Nothing was changed."]);
  const badValidate = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ summary: { name: 3 } }) }));
  expect(!badValidate.ok && badValidate.errors.map(formatImportError)).toEqual(["Server check · The server sent an unexpected reply. Nothing was changed."]);
});

it("caps and sanitizes server errors", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ row: i + 2, column: "month", message: "must be YYYY-MM" }));
  const result = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ errors: [...many, { row: "x", message: 5 }] }, { status: 400 }) }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toHaveLength(MAX_REPORTED_ERRORS + 1);
  expect(result.errors.at(-1)?.message).toBe(`${80 - MAX_REPORTED_ERRORS} more errors not shown`);
  expect(result.errors.every((e) => e.source === "server")).toBe(true);
});

it("refuses a file over the size cap without reading it", async () => {
  const text = vi.fn(async () => "month\n");
  expect(await readLimitedFile({ name: "big.csv", size: 300 * 1024, text }, 256 * 1024, "history")).toEqual({ source: "history", row: null, column: null, message: "big.csv is larger than 256 KiB" });
  expect(text).not.toHaveBeenCalled();
  expect(await readLimitedFile({ name: "ok.csv", size: 6, text }, 256 * 1024, "feedback")).toEqual({ name: "ok.csv", text: "month\n" });
});

it("reports a file that cannot be read with a fixed message", async () => {
  const text = vi.fn(async (): Promise<string> => { throw new DOMException("NotReadableError"); });
  expect(await readLimitedFile({ name: "gone.csv", size: 10, text }, 256 * 1024, "feedback")).toEqual({ source: "feedback", row: null, column: null, message: "gone.csv could not be read. Choose it again." });
});

it("stops without a session when the build is aborted", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.signal).toBe(controller.signal);
    if (String(input) === "/api/import/classify") { controller.abort(); throw new DOMException("aborted", "AbortError"); }
    return Response.json({ summary, reasonTargeting: true });
  });
  const result = await buildImport({ history: files.history, feedback: files.feedback, economics: SAMPLE_ECONOMICS }, fetcher, { signal: controller.signal });
  expect(result).toEqual({ ok: false, aborted: true, errors: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const late = new AbortController();
  const afterValidate = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, vi.fn<typeof fetch>(async () => { late.abort(); return Response.json({ summary, reasonTargeting: true }); }), { signal: late.signal });
  expect(afterValidate).toEqual({ ok: false, aborted: true, errors: [] });
  const before = new AbortController();
  before.abort();
  const none = vi.fn<typeof fetch>();
  expect(await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, none, { signal: before.signal })).toEqual({ ok: false, aborted: true, errors: [] });
  expect(none).not.toHaveBeenCalled();
});

it("says a blank or non-numeric economics field must be a number", async () => {
  const result = await buildImport({ history: files.history, feedback: null, economics: { ...SAMPLE_ECONOMICS, listPrice: Number.NaN, paymentFeeFixed: Number.NaN } }, fakeServer());
  expect(!result.ok && result.errors.map(formatImportError)).toEqual(["Economics · listPrice: must be a number", "Economics · paymentFeeFixed: must be a number"]);
});

it("rejects a summary whose segments are not renderable", async () => {
  const broken = { ...summary, segments: [null, { id: 3 }] };
  const result = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ summary: broken, reasonTargeting: true }) }));
  expect(!result.ok && result.errors.map(formatImportError)).toEqual(["Server check · The server sent an unexpected reply. Nothing was changed."]);
});

it("keeps only the summary fields an imported workspace renders", async () => {
  const extra = { ...summary, observedEvidence: { injected: true }, annualEvidence: { offers: [] } };
  const result = await buildImport({ history: files.history, feedback: null, economics: SAMPLE_ECONOMICS }, fakeServer({ validate: () => Response.json({ summary: extra, reasonTargeting: true }) }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session.summary).toEqual(JSON.parse(JSON.stringify(summary)));
  expect(result.session.summary).not.toHaveProperty("observedEvidence");
});

it("caps the combined client error list once, counting what each file left out", async () => {
  const bad = files.history.split("\n").map((line, i) => (i === 0 || !line ? line : line.replace(/^\d{4}-\d{2}/, "bad"))).join("\n");
  const result = await buildImport({ history: bad, feedback: "segment,text\n" + Array.from({ length: 70 }, () => "vip,hi").join("\n"), economics: { ...SAMPLE_ECONOMICS, merchantName: "" } }, fakeServer());
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toHaveLength(MAX_REPORTED_ERRORS + 1);
  // 60 history rows + 70 feedback rows + 1 economics error, 50 shown.
  expect(formatImportError(result.errors.at(-1)!)).toBe(`Import · ${60 + 70 + 1 - MAX_REPORTED_ERRORS} more errors not shown`);
  expect(result.errors.slice(0, -1).every((e) => !/more errors not shown/.test(e.message))).toBe(true);
});

it("lets only the newest read of each file count", () => {
  const guard = createReadGuard();
  const first = guard.begin("history");
  const second = guard.begin("history");
  const feedback = guard.begin("feedback");
  expect([guard.isCurrent(first), guard.isCurrent(second), guard.isCurrent(feedback)]).toEqual([false, true, true]);
  guard.invalidate("feedback");
  expect([guard.isCurrent(second), guard.isCurrent(feedback)]).toEqual([true, false]);
  guard.invalidate();
  expect(guard.isCurrent(second)).toBe(false);
});

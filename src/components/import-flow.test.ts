import { expect, it, vi } from "vitest";
import { DEFAULT_ECONOMICS, SAMPLE_ECONOMICS } from "@/import/economics";
import { buildImportedTwin, importedStarterStrategies } from "@/import/imported-twin";
import { MAX_REPORTED_ERRORS } from "@/import/row-error";
import { SAMPLE_REASON_COUNTS, sampleMerchantFiles } from "@/import/sample-merchant";
import { summarizeMerchant } from "@/merchant/summary";
import { samplePayload } from "@/test/import-fixture";
import { buildImport, formatImportError, readLimitedFile } from "./import-flow";

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

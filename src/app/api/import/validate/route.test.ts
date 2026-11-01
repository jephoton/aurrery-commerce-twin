import { expect, it, vi } from "vitest";
import { formatRowError } from "@/import/row-error";
import { samplePayload } from "@/test/import-fixture";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/import/validate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

it("re-validates an import and summarizes the twin it builds", async () => {
  const response = await post(samplePayload());
  expect(response.status).toBe(200);
  const { summary, reasonTargeting } = await response.json();
  expect(reasonTargeting).toBe(true);
  expect(summary).toMatchObject({
    name: "Hollowbrook Treat Box", planName: "Treat Box (monthly)", listPrice: 20, asOfMonth: "2026-09",
    imported: { months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 40 },
  });
  expect(summary.segments).toHaveLength(5);
  expect(summary.imported.reasonCounts.at_risk).toEqual({ price: 16, other: 2 });
  expect(summary.provenance.monthlyChurn.note).toContain("estimated from your CSV (12 months)");
  expect(summary).not.toHaveProperty("observedEvidence");
  expect(summary).not.toHaveProperty("annualEvidence");
});

it("reports a history without feedback as having no reason targeting", async () => {
  const response = await post(samplePayload({ feedback: false }));
  expect(response.status).toBe(200);
  const { summary, reasonTargeting } = await response.json();
  expect(reasonTargeting).toBe(false);
  expect(summary.imported).toEqual({ months: 12, firstMonth: "2025-10", lastMonth: "2026-09", feedbackRows: 0 });
});

it("returns per-row errors for invalid rows and schema-breaking payloads", async () => {
  const broken = samplePayload();
  broken.rows[12][3] = 999_999;
  const invalid = await post(broken);
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).errors.map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  const negative = samplePayload();
  negative.rows[0][2] = -1;
  const schema = await post(negative);
  expect(schema.status).toBe(400);
  expect((await schema.json()).errors[0]).toMatchObject({ row: 2, column: "active_start" });
  expect((await post({ ...samplePayload(), extra: true })).status).toBe(400);
});

it("reports the true number of errors left out when there are more than 50", async () => {
  const many = samplePayload();
  for (let i = 0; i < 60; i++) many.rows[i][2] = -1;
  const response = await post(many);
  expect(response.status).toBe(400);
  const { errors } = await response.json();
  expect(errors).toHaveLength(51);
  expect(errors[50]).toEqual({ row: null, column: null, message: "10 more errors not shown" });
});

it("rejects oversized and malformed bodies before parsing the import", async () => {
  expect((await post(JSON.stringify({ ...samplePayload(), padding: "x".repeat(70_000) }))).status).toBe(413);
  expect((await post("{")).status).toBe(400);
});

it("never echoes or logs uploaded content", async () => {
  const secret = "private-merchant-detail-7f3a";
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  try {
    const bad = { ...samplePayload(), [secret]: secret, economics: { ...samplePayload().economics, merchantName: `${secret}\u0007` } };
    const response = await post(bad);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
    const wrongType = await post({ rows: secret });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.text()).not.toContain(secret);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});

import { describe, expect, it } from "vitest";
import { SEGMENTS, type SegmentId } from "@/twin/types";
import { COUNT_COLUMNS, HISTORY_COLUMNS, parseHistoryCsv, validateHistoryRows, type CountColumn } from "./history-csv";
import { formatRowError, MAX_REPORTED_ERRORS } from "./row-error";

type Counts = Partial<Record<CountColumn, number>>;
const BASE: Record<SegmentId, Counts> = {
  new: { active_start: 100, voluntary_cancels: 10, involuntary_cancels: 1, moved_to_core: 20, moved_to_price_sensitive: 15 },
  core: { active_start: 500, voluntary_cancels: 10, involuntary_cancels: 5, moved_to_at_risk: 10 },
  price_sensitive: { active_start: 200, voluntary_cancels: 12, involuntary_cancels: 2, moved_to_at_risk: 8 },
  at_risk: { active_start: 80, voluntary_cancels: 12, involuntary_cancels: 1, moved_to_core: 8, moved_to_cancel_intent: 6 },
  cancel_intent: { active_start: 20, voluntary_cancels: 6, involuntary_cancels: 0, moved_to_at_risk: 3 },
};
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
function row(month: string, segment: SegmentId, overrides: Counts = {}): string {
  const counts: Record<CountColumn, number> = { active_start: 0, voluntary_cancels: 0, involuntary_cancels: 0, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 50, ...BASE[segment], ...overrides };
  return [month, segment, ...COUNT_COLUMNS.map((c) => counts[c])].join(",");
}
const rows = (months = MONTHS) => months.flatMap((m) => SEGMENTS.map((s) => row(m, s)));
const csv = (lines: string[] = rows(), header = HISTORY_COLUMNS.join(",")) => `${[header, ...lines].join("\n")}\n`;
const messages = (text: string) => {
  const result = parseHistoryCsv(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map(formatRowError);
};

describe("parseHistoryCsv", () => {
  it("parses a valid file into typed rows", () => {
    const result = parseHistoryCsv(csv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(30);
    expect(result.rows[0]).toEqual({ month: "2026-01", segment: "new", active_start: 100, voluntary_cancels: 10, involuntary_cancels: 1, moved_to_core: 20, moved_to_price_sensitive: 15, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 50 });
  });
  it("accepts any column order and a header with spaces after commas", () => {
    const swap = (line: string) => { const [a, b, ...rest] = line.split(","); return [b, a, ...rest].join(","); };
    const header = ["segment", "month", ...COUNT_COLUMNS].join(", ");
    const result = parseHistoryCsv(csv(rows().map(swap), header));
    expect(result.ok && result.rows[0].segment).toBe("new");
  });
  it("rejects unknown, missing and duplicate header columns", () => {
    expect(messages(csv(rows(), `${HISTORY_COLUMNS.join(",")},notes`))).toEqual(["row 1, notes: unknown column"]);
    expect(messages(csv(rows(), HISTORY_COLUMNS.slice(0, -1).join(",")))).toEqual(["row 1, new_signups: missing column"]);
  });
  it("reports each malformed cell with its row and column", () => {
    const lines = rows();
    lines[0] = lines[0].replace("2026-01,new,100", "2026-13,new,-1");
    lines[1] = lines[1].replace("2026-01,core", "2026-01,vip");
    lines[2] = row("2026-01", "price_sensitive", { voluntary_cancels: 1.5 as number });
    lines[3] = row("2026-01", "at_risk", { active_start: 10_000_001 });
    expect(messages(csv(lines))).toEqual([
      "row 2, month: must be YYYY-MM",
      "row 2, active_start: must be a non-negative integer",
      "row 3, segment: must be one of new, core, price_sensitive, at_risk, cancel_intent",
      "row 4, voluntary_cancels: must be a non-negative integer",
      "row 5, active_start: must be at most 10,000,000",
    ]);
  });
  it("rejects cancels plus moves beyond active_start, with the spec's wording", () => {
    const lines = rows();
    lines[12] = row("2026-03", "price_sensitive", { voluntary_cancels: 9999 });
    expect(messages(csv(lines))).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  });
  it("lets new rows use the month's signups as capacity", () => {
    const lines = rows();
    lines[0] = row("2026-01", "new", { active_start: 10, voluntary_cancels: 10, moved_to_core: 20, moved_to_price_sensitive: 15 });
    expect(parseHistoryCsv(csv(lines)).ok).toBe(true);
    lines[0] = row("2026-01", "new", { active_start: 10, voluntary_cancels: 30, moved_to_core: 20, moved_to_price_sensitive: 15 });
    expect(messages(csv(lines))).toEqual(["row 2, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start + new_signups"]);
  });
  it("rejects self-moves and unsupported moves, naming the move", () => {
    const lines = rows();
    lines[1] = row("2026-01", "core", { moved_to_core: 1, moved_to_price_sensitive: 2 });
    expect(messages(csv(lines))).toEqual([
      "row 3, moved_to_core: a segment cannot move to itself; must be 0",
      "row 3, moved_to_price_sensitive: unsupported move core → price_sensitive",
    ]);
  });
  it("requires one new_signups value per month", () => {
    const lines = rows();
    lines[1] = row("2026-01", "core", { new_signups: 51 });
    expect(messages(csv(lines))).toEqual(["row 3, new_signups: must equal row 2 (50) for 2026-01"]);
  });
  it("rejects duplicates, missing segments and gaps", () => {
    expect(messages(csv([...rows(), row("2026-01", "core")]))).toEqual(["row 32, segment: duplicate row for 2026-01 core (first at row 3)"]);
    const missing = rows().filter((line) => !line.startsWith("2026-02,at_risk"));
    expect(messages(csv(missing))).toEqual(["row 7, segment: 2026-02 is missing at_risk; every month needs one row per segment"]);
    const gap = rows(["2026-01", "2026-02", "2026-03", "2026-05", "2026-06", "2026-07"]);
    expect(messages(csv(gap))).toEqual(["row 17, month: gap: 2026-04 is missing before 2026-05"]);
  });
  it("requires at least 6 months and at most 300 rows", () => {
    expect(messages(csv(rows(MONTHS.slice(0, 5))))).toEqual(["month: at least 6 consecutive months are required (found 5)"]);
    expect(messages(csv(Array.from({ length: 301 }, () => row("2026-01", "new"))))).toEqual(["at most 300 history rows are allowed (found 301)"]);
  });
  it("caps header errors and rejects leading zeros", () => {
    const result = parseHistoryCsv(`${",".repeat(5000)}
`);
    expect(result.ok === false && result.errors.length).toBe(MAX_REPORTED_ERRORS + 1);
    const lines = rows();
    lines[0] = lines[0].replace("2026-01,new,100", "2026-01,new,0100");
    expect(messages(csv(lines))).toEqual(["row 2, active_start: must be a non-negative integer"]);
  });
  it("rejects files over 256 KiB, empty files and short records", () => {
    expect(messages("x".repeat(256 * 1024 + 1))).toEqual(["history file is larger than 256 KiB"]);
    expect(messages("")).toEqual(["history file is empty"]);
    expect(messages(csv(["2026-01,new,1"]))).toEqual(["row 2: expected 10 columns, found 3"]);
  });
});

describe("validateHistoryRows", () => {
  it("numbers server-side rows by payload position when no line numbers exist", () => {
    const parsed = parseHistoryCsv(csv());
    if (!parsed.ok) throw new Error("fixture must parse");
    const broken = parsed.rows.map((r, i) => (i === 12 ? { ...r, voluntary_cancels: 9999 } : r));
    expect(validateHistoryRows(broken).map(formatRowError)).toEqual(["row 14, voluntary_cancels: voluntary + involuntary cancels + moves exceed active_start"]);
  });
  it("rejects a history whose last month has no active subscribers", () => {
    const empty: Counts = { active_start: 0, voluntary_cancels: 0, involuntary_cancels: 0, moved_to_core: 0, moved_to_price_sensitive: 0, moved_to_at_risk: 0, moved_to_cancel_intent: 0, new_signups: 0 };
    const allZero = MONTHS.flatMap((m) => SEGMENTS.map((s) => row(m, s, empty)));
    expect(messages(csv(allZero))).toEqual(["active_start: 2026-06 has no active subscribers (active_start is 0 in every segment); the twin starts from the last month"]);
    const lastEmpty = [...rows(MONTHS.slice(0, 5)), ...SEGMENTS.map((s) => row("2026-06", s, { ...empty, new_signups: 50 }))];
    expect(messages(csv(lastEmpty))).toEqual(["active_start: 2026-06 has no active subscribers (active_start is 0 in every segment); the twin starts from the last month"]);
  });
});

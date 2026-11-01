import { expect, it } from "vitest";
import { DEMO_TRUTH } from "@/merchant/demo";
import { generateSyntheticHistory, type SyntheticHistorySpec } from "./synthetic-history";
import { monthOffset } from "./history";
import { SEGMENTS } from "./types";

const spec: SyntheticHistorySpec = { truth: DEMO_TRUTH, startActive: { new: 380, core: 1180, price_sensitive: 470, at_risk: 230, cancel_intent: 70 }, months: 6, seed: 99, asOfMonth: "2026-10" };

it("labels consecutive months ending the month before asOfMonth", () => {
  const { history } = generateSyntheticHistory(spec);
  expect(history.acquisition.map((a) => a.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  expect(history.segments).toHaveLength(6 * SEGMENTS.length);
  expect(monthOffset("2026-01", -1)).toBe("2025-12");
});
it("is reproducible for a seed and differs across seeds", () => {
  expect(generateSyntheticHistory(spec)).toEqual(generateSyntheticHistory(spec));
  expect(generateSyntheticHistory({ ...spec, seed: 100 })).not.toEqual(generateSyntheticHistory(spec));
});
it("conserves subscribers: each month starts where the last ended, with signups entering new", () => {
  const { history, endActive } = generateSyntheticHistory(spec);
  const months = history.acquisition.map((a) => a.month);
  const end = (month: string) => {
    const state = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<(typeof SEGMENTS)[number], number>;
    for (const r of history.segments.filter((x) => x.month === month)) {
      const out = Object.values(r.movedTo).reduce((s, n) => s + (n ?? 0), 0);
      state[r.segment] += r.activeAtStart - r.voluntaryChurn - r.involuntaryChurn - out;
      for (const [to, n] of Object.entries(r.movedTo)) state[to as keyof typeof state] += n ?? 0;
    }
    return state;
  };
  for (let i = 1; i < months.length; i++) {
    const previous = end(months[i - 1]);
    const signups = history.acquisition[i].newSubscribers;
    for (const r of history.segments.filter((x) => x.month === months[i])) {
      expect(r.activeAtStart).toBe(previous[r.segment] + (r.segment === "new" ? signups : 0));
    }
  }
  expect(endActive).toEqual(end(months.at(-1)!));
});

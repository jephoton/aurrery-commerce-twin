import type { StrategyResult } from "@/twin/simulate";
import type { Intervention } from "@/twin/interventions";
import { isExecutable } from "./headline";

export type Family = "Retention" | "Annual" | "Pricing" | "Baseline";

export interface ScenarioRow {
  id: string;
  name: string;
  family: Family;
  isBaseline: boolean;
  deltaValueP10: number;
  deltaValueP50: number;
  deltaValueP90: number;
  probWorse: number;
  deltaProfitP50: number;
  endingActiveP50: number;
  deltaEndingActive: number;
  discountCost: number;
  executable: boolean;
  paypalAction: string | null;
}

const familyFor = (kind: Intervention["kind"]): Family => {
  switch (kind) {
    case "baseline": return "Baseline";
    case "targeted_discount": return "Retention";
    case "annual_plan": return "Annual";
    case "list_price_change": return "Pricing";
  }
};

export function comparisonRows(results: StrategyResult[], baselineId: string): { candidates: ScenarioRow[]; baseline: ScenarioRow | null } {
  const rows = results.map((r): ScenarioRow => ({
    id: r.strategy.id,
    name: r.strategy.name,
    family: familyFor(r.strategy.intervention.kind),
    isBaseline: r.strategy.id === baselineId,
    deltaValueP10: r.vsBaseline.totalValue.p10,
    deltaValueP50: r.vsBaseline.totalValue.p50,
    deltaValueP90: r.vsBaseline.totalValue.p90,
    probWorse: r.probValueBelowBaseline,
    deltaProfitP50: r.vsBaseline.grossProfit.p50,
    endingActiveP50: r.metrics.endingActive.p50,
    deltaEndingActive: r.vsBaseline.endingActive.mean,
    discountCost: r.metrics.discountCost.mean,
    executable: isExecutable(r),
    paypalAction: r.paypalAction,
  }));
  const baselines = rows.filter((row) => row.family === "Baseline" || row.isBaseline);
  if (baselines.length !== 1 || !baselines[0].isBaseline || baselines[0].family !== "Baseline") throw new Error("Comparison must contain exactly one baseline matching baselineId");
  return { candidates: rows.filter((row) => !row.isBaseline), baseline: baselines[0] };
}

export function intervalDomain(rows: Pick<ScenarioRow, "deltaValueP10" | "deltaValueP90">[]): [number, number] {
  const values = rows.flatMap((r) => [r.deltaValueP10, r.deltaValueP90]).filter(Number.isFinite);
  return [Math.min(0, ...values), Math.max(0, ...values)];
}

export function intervalGeometry(p10: number, p50: number, p90: number, domain: [number, number]) {
  const [lo, hi] = domain;
  const position = (value: number) => hi === lo ? 0.5 : Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return { start: position(p10), median: position(p50), end: position(p90), zero: position(0) };
}

export const formatRisk = (probability: number) => `${(probability * 100).toFixed(1)}%`;

export function shouldSelectRow(row: ScenarioRow | undefined, selected: boolean, pinned: boolean, selectedId: string | null, disabled: boolean): boolean {
  return Boolean(row && selected && !pinned && !row.isBaseline && row.id !== selectedId && !disabled);
}

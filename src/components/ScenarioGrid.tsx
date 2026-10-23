"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef } from "react";
import type { StrategyResult } from "@/twin/simulate";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#0070e0",
  headerBackgroundColor: "#f6f7f9",
  fontSize: 13,
  rowHeight: 44,
  wrapperBorderRadius: 10,
});

export interface ScenarioRow {
  id: string;
  name: string;
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

export function toRows(results: StrategyResult[], baselineId: string): ScenarioRow[] {
  return results.map((r) => ({
    id: r.strategy.id,
    name: r.strategy.name,
    isBaseline: r.strategy.id === baselineId,
    deltaValueP10: r.vsBaseline.totalValue.p10,
    deltaValueP50: r.vsBaseline.totalValue.p50,
    deltaValueP90: r.vsBaseline.totalValue.p90,
    probWorse: r.probValueBelowBaseline,
    deltaProfitP50: r.vsBaseline.grossProfit.p50,
    endingActiveP50: r.metrics.endingActive.p50,
    deltaEndingActive: r.vsBaseline.endingActive.mean,
    discountCost: r.metrics.discountCost.mean,
    executable: r.strategy.intervention.kind === "targeted_discount",
    paypalAction: r.paypalAction,
  }));
}

const usd = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`;
const signed = (p: ValueFormatterParams<ScenarioRow, number>) => (p.data?.isBaseline ? "—" : usd(p.value ?? 0));
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "text-positive" : "text-negative");

export function ScenarioGrid({
  rows,
  selectedId,
  onSelect,
  disabled = false,
  horizonMonths = 12,
}: {
  rows: ScenarioRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  horizonMonths?: number;
}) {
  const api = useRef<GridApi<ScenarioRow> | null>(null);
  useEffect(() => {
    if (!api.current || api.current.isDestroyed()) return;
    api.current.deselectAll();
    if (selectedId) api.current.getRowNode(selectedId)?.setSelected(true);
  }, [selectedId, rows]);
  const columns = useMemo<ColDef<ScenarioRow>[]>(
    () => [
      { field: "name", headerName: "Strategy", flex: 2, minWidth: 220, pinned: "left" },
      {
        field: "deltaValueP50",
        headerName: "Δ Value (median)",
        headerTooltip: `${horizonMonths}-month gross profit plus value of the subscriber base at month ${horizonMonths}, versus doing nothing`,
        valueFormatter: signed,
        cellClass: (p) => tone(p.value),
        sort: "desc",
        minWidth: 140,
      },
      {
        colId: "range",
        headerName: "80% interval",
        headerTooltip: "10th to 90th percentile across Monte Carlo runs",
        valueGetter: (p) => (p.data?.isBaseline ? "—" : `${usd(p.data!.deltaValueP10)} … ${usd(p.data!.deltaValueP90)}`),
        minWidth: 190,
        sortable: false,
      },
      {
        field: "probWorse",
        headerName: "P(worse than baseline)",
        valueFormatter: (p) => (p.data?.isBaseline ? "—" : `${Math.round((p.value ?? 0) * 100)}%`),
        cellClass: (p) => (p.data?.isBaseline ? "" : (p.value ?? 0) > 0.35 ? "text-negative" : (p.value ?? 0) < 0.1 ? "text-positive" : ""),
        minWidth: 120,
      },
      { field: "deltaProfitP50", headerName: `Δ ${horizonMonths}-mo profit`, valueFormatter: signed, cellClass: (p) => tone(p.value), minWidth: 130 },
      {
        field: "deltaEndingActive",
        headerName: "Δ Subscribers",
        valueFormatter: (p) => (p.data?.isBaseline ? "—" : `${(p.value ?? 0) > 0 ? "+" : ""}${Math.round(p.value ?? 0)}`),
        cellClass: (p) => tone(p.value),
        minWidth: 120,
      },
      { field: "discountCost", headerName: "Discount given", valueFormatter: (p) => `$${Math.round(p.value ?? 0).toLocaleString()}`, minWidth: 120 },
      {
        field: "executable",
        headerName: "PayPal",
        headerTooltip: "Whether this build can execute the strategy through the PayPal Sandbox",
        cellRenderer: (p: { data?: ScenarioRow }) =>
          p.data?.isBaseline ? (
            "—"
          ) : (
            <span title={p.data?.paypalAction ?? ""} className={p.data?.executable ? "font-medium text-brand-accent" : "text-muted"}>
              {p.data?.executable ? "Executable" : "Simulate only"}
            </span>
          ),
        minWidth: 120,
      },
    ],
    [horizonMonths],
  );

  return (
    <div aria-disabled={disabled} inert={disabled} style={{ height: 52 + rows.length * 44 + 4 }}>
      <AgGridReact<ScenarioRow>
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, flex: 1 }}
        getRowId={(p) => p.data.id}
        rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: !disabled }}
        onGridReady={(e) => { api.current = e.api; }}
        onRowClicked={(e) => !disabled && e.data && onSelect(e.data.id)}
        onFirstDataRendered={(e) => selectedId && e.api.getRowNode(selectedId)?.setSelected(true)}
      />
    </div>
  );
}

"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type RowSelectedEvent, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StrategyResult } from "@/twin/simulate";
import { comparisonRows, formatRisk, intervalDomain, shouldSelectRow, type Family, type ScenarioRow } from "./comparison-model";
import { IntervalCell, signedUsd } from "./IntervalCell";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#e6bd69",
  backgroundColor: "#101a2b",
  foregroundColor: "#f4f0e7",
  headerBackgroundColor: "#142135",
  headerTextColor: "#abb8cb",
  borderColor: "#34445b",
  rowHoverColor: "#1b2b42",
  selectedRowBackgroundColor: "#25324a",
  fontSize: 13,
  rowHeight: 58,
  wrapperBorderRadius: 10,
});

export type { ScenarioRow } from "./comparison-model";

export function toRows(results: StrategyResult[], baselineId: string): ScenarioRow[] {
  const { candidates, baseline } = comparisonRows(results, baselineId);
  return baseline ? [...candidates, baseline] : candidates;
}

const signed = (p: ValueFormatterParams<ScenarioRow, number>) => (p.data?.isBaseline ? "—" : signedUsd(p.value ?? 0));
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "text-positive" : "text-negative");
const families: Family[] = ["Retention", "Annual", "Pricing"];

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
  const [family, setFamily] = useState<Family | "All">("All");
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < 640);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const candidates = useMemo(() => rows.filter((row) => !row.isBaseline), [rows]);
  const baseline = rows.find((row) => row.isBaseline);
  const displayed = useMemo(() => family === "All" ? candidates : candidates.filter((row) => row.family === family), [candidates, family]);
  const domain = useMemo(() => intervalDomain(candidates), [candidates]);
  const selectedOffFilter = selectedId != null && candidates.some((row) => row.id === selectedId) && !displayed.some((row) => row.id === selectedId);
  useEffect(() => {
    if (!api.current || api.current.isDestroyed()) return;
    const selected = api.current.getSelectedRows()[0]?.id;
    if (selected === selectedId) return;
    api.current.deselectAll();
    if (selectedId && displayed.some((row) => row.id === selectedId)) api.current.getRowNode(selectedId)?.setSelected(true);
  }, [selectedId, displayed]);
  const columns = useMemo<ColDef<ScenarioRow>[]>(
    () => [
      { field: "name", headerName: "Strategy", minWidth: 220, pinned: narrow ? null : "left", cellRenderer: (p: { data?: ScenarioRow }) => p.data ? <span className="flex h-full min-w-0 flex-col justify-center whitespace-normal leading-tight"><span className="line-clamp-2 break-words font-medium" title={p.data.name}>{p.data.name}</span><span className="text-xs text-muted">{p.data.family}{p.data.isBaseline ? " · context only" : ""}</span></span> : null },
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
        cellRenderer: (p: { data?: ScenarioRow }) => p.data?.isBaseline ? "—" : p.data ? <IntervalCell p10={p.data.deltaValueP10} p50={p.data.deltaValueP50} p90={p.data.deltaValueP90} domain={domain} /> : null,
        minWidth: 240,
        sortable: false,
      },
      {
        field: "probWorse",
        headerName: "P(worse than baseline)",
        valueFormatter: (p) => (p.data?.isBaseline ? "—" : formatRisk(p.value ?? 0)),
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
    [horizonMonths, domain, narrow],
  );

  const onRowSelected = (event: RowSelectedEvent<ScenarioRow>) => {
    if (shouldSelectRow(event.data, Boolean(event.node.isSelected()), Boolean(event.node.rowPinned), selectedId, disabled)) onSelect(event.data!.id);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter scenario families">
        {(["All", ...families] as const).map((value) => <button key={value} type="button" disabled={disabled} aria-pressed={family === value} onClick={() => setFamily(value)} className={`min-h-10 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent ${family === value ? "border-brand-accent bg-brand/15 text-brand-accent" : "border-border text-muted hover:text-foreground"}`}>{value}</button>)}
      </div>
      {selectedOffFilter && <p className="mb-2 text-sm text-muted" role="status">Selected scenario is outside this family filter. Its details and proposal remain selected.</p>}
      <div aria-disabled={disabled} inert={disabled} className="max-w-full overflow-x-auto rounded-lg" aria-label="Scenario comparison table">
      <div className="min-w-[1040px]" style={{ height: 52 + Math.max(1, displayed.length) * 58 + (baseline ? 58 : 0) + 4 }}>
      <AgGridReact<ScenarioRow>
        theme={theme}
        rowData={displayed}
        pinnedBottomRowData={baseline ? [baseline] : []}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        getRowId={(p) => p.data.id}
        rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: !disabled }}
        onGridReady={(e) => { api.current = e.api; }}
        onRowSelected={onRowSelected}
        onFirstDataRendered={(e) => selectedId && displayed.some((row) => row.id === selectedId) && e.api.getRowNode(selectedId)?.setSelected(true)}
      />
      </div>
      </div>
    </div>
  );
}

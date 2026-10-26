import type { ApplyColumnStateParams, ColumnState } from "ag-grid-community";

/** Keep Strategy first as it moves between the pinned and scrollable sections. */
export function responsiveColumnState(current: readonly ColumnState[], narrow: boolean): ApplyColumnStateParams | null {
  if (!current.some((column) => column.colId === "name")) return null;
  return {
    applyOrder: true,
    state: [
      { colId: "name", pinned: narrow ? null : "left" },
      ...current.filter((column) => column.colId !== "name").map((column) => ({ colId: column.colId })),
    ],
  };
}

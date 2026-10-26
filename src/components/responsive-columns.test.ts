import { expect, it } from "vitest";
import type { ColumnState } from "ag-grid-community";
import { responsiveColumnState } from "./responsive-columns";

it("unpins Strategy and keeps it first without resetting user width or numeric sort", () => {
  const current = [
    { colId: "deltaValueP50", sort: "desc", width: 171 },
    { colId: "range", width: 251 },
    { colId: "name", pinned: "left", width: 226 },
  ] as ColumnState[];
  expect(responsiveColumnState(current, true)).toEqual({
    applyOrder: true,
    state: [{ colId: "name", pinned: null }, { colId: "deltaValueP50" }, { colId: "range" }],
  });
  expect(responsiveColumnState(current, false)?.state?.[0]).toEqual({ colId: "name", pinned: "left" });
});

import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type ColumnHelper,
  type Row,
  type RowData,
} from '@tanstack/react-table';

/** Per-column presentation hints read by DataTable (`column.meta`). */
export interface DataTableColumnMeta {
  /** Primary / ID cell, rendered bold (`font-bold text-nw-text`). Defaults to the first column when rows are clickable. */
  primary?: boolean;
  /** `right` for numeric columns: right-aligned with tabular figures. */
  align?: 'left' | 'center' | 'right';
  /** Column width (any CSS width value). */
  width?: number | string;
  /** Label for the column chooser when `header` is not a plain string. */
  label?: string;
  /** Extra classes applied to the header cell and every body cell. */
  className?: string;
}

/**
 * The TanStack Table v9 feature set every DataTable runs on: sorting, pagination, selection,
 * column visibility and global (search) filtering, with client-side row models. Static so the
 * table instance is stable across renders.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;

/** Column definitions as produced by `createColumns<T>().columns([...])` (cell values are untyped). */
export type DataTableColumns<TData extends RowData> = ReturnType<
  ColumnHelper<DataTableFeatures, TData>['columns']
>;

/** A single DataTable column definition for row type `TData`. */
export type DataTableColumnDef<TData extends RowData> = DataTableColumns<TData>[number];

/** A TanStack row for row type `TData` (used by advanced cell renderers). */
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;

/**
 * Typed column-definition helper bound to the DataTable feature set.
 * @example
 * const col = createColumns<Truck>();
 * const columns = col.columns([
 *   col.accessor('unit', { header: 'Unit', meta: { primary: true } }),
 *   col.accessor('odometer', { header: 'Odometer', meta: { align: 'right' } }),
 * ]);
 */
export function createColumns<TData extends RowData>(): ColumnHelper<DataTableFeatures, TData> {
  return createColumnHelper<DataTableFeatures, TData>();
}

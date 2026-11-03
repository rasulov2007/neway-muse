import type { RowSelectionState, SortingState } from '@tanstack/react-table';
import { useCallback, useState } from 'react';

export interface DataTablePagination {
  /** 1-based page number. */
  page: number;
  pageSize: number;
}

export interface DataTableState {
  sorting: SortingState;
  pagination: DataTablePagination;
  /** Keys are row keys from `rowKey`. */
  rowSelection: RowSelectionState;
  /** `false` hides a column; absent columns are visible. */
  columnVisibility: Record<string, boolean>;
  globalFilter: string;
}

export type DataTableStateChange = (patch: Partial<DataTableState>) => void;

export const DEFAULT_PAGE_SIZE = 25;
export const DEFAULT_PAGE_SIZES = [25, 50, 100];

export function createDataTableState(initial?: Partial<DataTableState>): DataTableState {
  return {
    sorting: [],
    pagination: { page: 1, pageSize: DEFAULT_PAGE_SIZE },
    rowSelection: {},
    columnVisibility: {},
    globalFilter: '',
    ...initial,
  };
}

/**
 * Local DataTable state with a stable change handler that merges partial updates and returns to
 * page 1 whenever sorting, the search filter or the page size changes.
 */
export function useDataTableState(
  initial?: Partial<DataTableState>,
): [DataTableState, DataTableStateChange] {
  const [state, setState] = useState<DataTableState>(() => createDataTableState(initial));
  const onStateChange = useCallback<DataTableStateChange>((patch) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const resetPage =
        (patch.sorting !== undefined && patch.sorting !== prev.sorting) ||
        (patch.globalFilter !== undefined && patch.globalFilter !== prev.globalFilter) ||
        (patch.pagination !== undefined && patch.pagination.pageSize !== prev.pagination.pageSize);
      if (resetPage && next.pagination.page !== 1) {
        next.pagination = { ...next.pagination, page: 1 };
      }
      return next;
    });
  }, []);
  return [state, onStateChange];
}

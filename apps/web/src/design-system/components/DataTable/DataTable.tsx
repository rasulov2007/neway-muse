import {
  FlexRender,
  functionalUpdate,
  useTable,
  type Column,
  type Header,
  type RowData,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Ellipsis } from 'lucide-react';
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { ColumnChooser, type ColumnChooserColumn } from '../ColumnChooser';
import { DropdownMenu } from '../DropdownMenu';
import { EmptyState } from '../EmptyState';
import { ErrorState } from '../ErrorState';
import { IconButton } from '../IconButton';
import { BulkActionBar } from '../BulkActionBar';
import { Pagination, formatPaginationRange } from '../Pagination';
import { TableSkeleton } from '../Skeleton';
import {
  dataTableFeatures,
  type DataTableColumnDef,
  type DataTableColumnMeta,
  type DataTableFeatures,
} from './features';
import {
  DEFAULT_PAGE_SIZES,
  useDataTableState,
  type DataTableState,
  type DataTableStateChange,
} from './useDataTableState';
import { useRecentlyCreated } from '@/lib/recent-creates';

export type DataTableRowStatus = 'selected' | 'muted';

export interface DataTableProps<T extends RowData> {
  columns: ReadonlyArray<DataTableColumnDef<T>>;
  data: ReadonlyArray<T>;
  /** Stable key per row; used for selection and React keys. */
  rowKey: (row: T) => string;
  /** Controlled state. Omit `state`/`onStateChange` for a self-contained table. */
  state?: DataTableState;
  onStateChange?: DataTableStateChange;
  /**
   * Total row count from the server. When set (or `serverSide`), `data` is treated as the
   * current page and sorting/pagination/search are not applied client-side.
   */
  total?: number;
  serverSide?: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Custom empty state; otherwise `emptyTitle`/`emptyDescription`/`emptyAction` build one. */
  empty?: ReactNode;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  /** 34px rows instead of 40px. */
  dense?: boolean;
  stickyHeader?: boolean;
  /** Makes rows clickable (pointer + Enter/Space). Clicks on controls inside a row are ignored. */
  onRowClick?: (row: T) => void;
  /**
   * Opens a row on double click. Pair it with `onRowClick` when a single click should only select:
   * a list whose every click navigates cannot be used to compare two rows.
   */
  onRowDoubleClick?: (row: T) => void;
  /** Menu items for the trailing "⋯" column (MenuItem / MenuSeparator). */
  rowActions?: (row: T) => ReactNode;
  /** Rendered in the bulk action bar while rows are selected. */
  bulkActions?: ReactNode | ((selectedRows: T[]) => ReactNode);
  /** Adds the checkbox column. */
  selectable?: boolean;
  /** Left toolbar area (FilterBar, search). */
  toolbar?: ReactNode;
  /** Right toolbar area, before the export button and column chooser. */
  toolbarRight?: ReactNode;
  /** Shows the column chooser in the toolbar. Default `true`. */
  showColumnChooser?: boolean;
  /** Renders an "Export" button in the toolbar. */
  onExport?: () => void;
  /** Virtualize the body (use with a large page size). Header stays sticky. */
  virtualize?: boolean;
  getRowStatus?: (row: T) => DataTableRowStatus | undefined;
  /** Visually hidden table caption. */
  caption?: ReactNode;
  pageSizes?: number[];
  /** Max height of the scrolling body area (any CSS length). Required for virtualization to scroll. */
  maxHeight?: number | string;
  className?: string;
  id?: string;
}

const SELECT_COLUMN_ID = '__select';
const ACTIONS_COLUMN_ID = '__actions';
const EMPTY_DATA: never[] = [];
const VIRTUAL_OVERSCAN = 10;
/** Fallback estimate for the virtualizer only; real heights come from `--table-row-height`. */
const FALLBACK_ROW_HEIGHT = 40;
const FALLBACK_ROW_HEIGHT_DENSE = 34;
const DEFAULT_VIRTUAL_MAX_HEIGHT = '60vh';

interface RowActionsContextValue {
  rowActions?: (row: RowData) => ReactNode;
}
const RowActionsContext = createContext<RowActionsContextValue>({});

interface SelectAllApi {
  getIsAllPageRowsSelected: () => boolean;
  getIsSomePageRowsSelected: () => boolean;
  toggleAllPageRowsSelected: (value?: boolean) => void;
}

interface SelectRowApi {
  index: number;
  getIsSelected: () => boolean;
  getCanSelect: () => boolean;
  toggleSelected: (value?: boolean) => void;
}

function SelectAllCell({ table }: { table: SelectAllApi }) {
  const all = table.getIsAllPageRowsSelected();
  const some = table.getIsSomePageRowsSelected() && !all;
  return (
    <Checkbox
      aria-label="Select all rows on this page"
      checked={all ? true : some ? 'indeterminate' : false}
      onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked === true)}
    />
  );
}

function SelectRowCell({ row }: { row: SelectRowApi }) {
  return (
    <Checkbox
      aria-label={`Select row ${row.index + 1}`}
      checked={row.getIsSelected()}
      disabled={!row.getCanSelect()}
      onCheckedChange={(checked) => row.toggleSelected(checked === true)}
    />
  );
}

function RowActionsCell({ row }: { row: RowData }) {
  const { rowActions } = useContext(RowActionsContext);
  if (!rowActions) return null;
  return (
    <DropdownMenu
      trigger={
        <IconButton size="sm" label="Row actions">
          <Ellipsis />
        </IconButton>
      }
    >
      {rowActions(row)}
    </DropdownMenu>
  );
}

function createSelectColumn<T extends RowData>(): DataTableColumnDef<T> {
  return {
    id: SELECT_COLUMN_ID,
    header: ({ table }) => <SelectAllCell table={table} />,
    cell: ({ row }) => <SelectRowCell row={row} />,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
    meta: { align: 'center', className: 'w-10 pr-0' },
  };
}

function createActionsColumn<T extends RowData>(): DataTableColumnDef<T> {
  return {
    id: ACTIONS_COLUMN_ID,
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => <RowActionsCell row={row.original} />,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
    meta: { align: 'right', className: 'w-12 pl-0' },
  };
}

function isInternalColumn(id: string): boolean {
  return id === SELECT_COLUMN_ID || id === ACTIONS_COLUMN_ID;
}

function columnLabel<T extends RowData>(column: Column<DataTableFeatures, T, unknown>): string {
  const { header, meta } = column.columnDef;
  if (meta?.label) return meta.label;
  if (typeof header === 'string') return header;
  return column.id;
}

function alignClass(meta: DataTableColumnMeta | undefined): string | undefined {
  if (meta?.align === 'right') return 'text-right';
  if (meta?.align === 'center') return 'text-center';
  return undefined;
}

function widthStyle(meta: DataTableColumnMeta | undefined): CSSProperties | undefined {
  return meta?.width !== undefined ? { width: meta.width } : undefined;
}

function SortIcon({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (sorted === 'asc') return <ArrowUp aria-hidden className="size-3 shrink-0" />;
  if (sorted === 'desc') return <ArrowDown aria-hidden className="size-3 shrink-0" />;
  return <ChevronsUpDown aria-hidden className="size-3 shrink-0 text-nw-text-3" />;
}

function HeaderCell<T extends RowData>({
  header,
}: {
  header: Header<DataTableFeatures, T, unknown>;
}) {
  const column = header.column;
  const meta = column.columnDef.meta;
  const canSort = column.getCanSort();
  const sorted = column.getIsSorted();
  const ariaSort = !canSort
    ? undefined
    : sorted === 'asc'
      ? 'ascending'
      : sorted === 'desc'
        ? 'descending'
        : 'none';

  return (
    <th
      scope="col"
      colSpan={header.colSpan}
      aria-sort={ariaSort}
      style={widthStyle(meta)}
      className={cn(
        // Porcelain header: 34px, --nw-subtle fill, 12/600 in text-2 (column-header type), one hairline below.
        'h-(--table-header-height) border-b border-nw-border bg-nw-subtle px-2.5 text-left align-middle text-xs font-semibold text-nw-text-2 whitespace-nowrap',
        alignClass(meta),
        meta?.className,
      )}
    >
      {header.isPlaceholder ? null : canSort ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          className={cn(
            '-mx-1 inline-flex h-6 max-w-full items-center gap-1 rounded-sm px-1',
            'transition-colors duration-(--duration-fast) hover:text-nw-text',
            'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
            sorted && 'text-nw-text',
            meta?.align === 'right' && 'flex-row-reverse',
          )}
        >
          <span className="whitespace-nowrap">
            <FlexRender header={header} />
          </span>
          <SortIcon sorted={sorted} />
        </button>
      ) : (
        <FlexRender header={header} />
      )}
    </th>
  );
}

/**
 * True when a click should not activate the row: it landed on a control inside the row, or it
 * bubbled through a React portal (row menus) and is not part of the row's DOM at all.
 */
function isInteractiveTarget(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (!row.contains(target)) return true;
  return (
    target.closest('button, a, input, select, textarea, [role="checkbox"], [role="menu"]') !== null
  );
}

function readRowHeight(dense: boolean): number {
  const fallback = dense ? FALLBACK_ROW_HEIGHT_DENSE : FALLBACK_ROW_HEIGHT;
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    dense ? '--table-row-height-dense' : '--table-row-height',
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Bordered data table on TanStack Table v9: toolbar, sortable header, selection, row actions,
 * bulk bar, footer pagination and designed loading/empty/error states. Scrolls horizontally
 * inside its own wrapper.
 */
export function DataTable<T extends RowData>({
  columns,
  data,
  rowKey,
  state: stateProp,
  onStateChange: onStateChangeProp,
  total,
  serverSide = false,
  loading = false,
  error,
  onRetry,
  empty,
  emptyTitle = 'No results',
  emptyDescription = 'Try adjusting your search or filters.',
  emptyAction,
  dense = false,
  stickyHeader = false,
  onRowClick,
  onRowDoubleClick,
  rowActions,
  bulkActions,
  selectable = false,
  toolbar,
  toolbarRight,
  showColumnChooser = true,
  onExport,
  virtualize = false,
  getRowStatus,
  caption,
  pageSizes = DEFAULT_PAGE_SIZES,
  maxHeight,
  className,
  id,
}: DataTableProps<T>) {
  const recentlyCreated = useRecentlyCreated();
  const [internalState, internalChange] = useDataTableState();
  const state = stateProp ?? internalState;
  const onStateChange: DataTableStateChange = (patch) => {
    onStateChangeProp?.(patch);
    if (!stateProp) internalChange(patch);
  };

  const manual = serverSide || total !== undefined;
  const hasRowActions = Boolean(rowActions);
  const allColumns = useMemo(() => {
    const list: DataTableColumnDef<T>[] = [];
    if (selectable) list.push(createSelectColumn<T>());
    list.push(...columns);
    if (hasRowActions) list.push(createActionsColumn<T>());
    return list;
  }, [columns, selectable, hasRowActions]);

  const { page, pageSize } = state.pagination;
  const table = useTable<DataTableFeatures, T>({
    features: dataTableFeatures,
    columns: allColumns,
    data: data.length ? (data as T[]) : (EMPTY_DATA as T[]),
    getRowId: (row) => rowKey(row),
    state: {
      sorting: state.sorting,
      pagination: { pageIndex: Math.max(0, page - 1), pageSize },
      rowSelection: state.rowSelection,
      columnVisibility: state.columnVisibility,
      globalFilter: state.globalFilter,
    },
    onSortingChange: (updater) =>
      onStateChange({ sorting: functionalUpdate(updater, state.sorting) }),
    onPaginationChange: (updater) => {
      const next = functionalUpdate(updater, { pageIndex: page - 1, pageSize });
      onStateChange({ pagination: { page: next.pageIndex + 1, pageSize: next.pageSize } });
    },
    onRowSelectionChange: (updater) =>
      onStateChange({ rowSelection: functionalUpdate(updater, state.rowSelection) }),
    onColumnVisibilityChange: (updater) =>
      onStateChange({ columnVisibility: functionalUpdate(updater, state.columnVisibility) }),
    onGlobalFilterChange: (updater) =>
      onStateChange({ globalFilter: functionalUpdate(updater, state.globalFilter) }),
    manualSorting: manual,
    manualPagination: manual,
    manualFiltering: manual,
    rowCount: total,
    autoResetPageIndex: false,
    enableRowSelection: selectable,
    enableHiding: true,
  });

  const rows = table.getRowModel().rows;
  const rowCount = table.getRowCount();
  const leafColumns = table.getVisibleLeafColumns();
  const colCount = Math.max(1, leafColumns.length);
  const selectedCount = Object.keys(state.rowSelection).length;
  const showBulkBar = selectable && selectedCount > 0;
  const showToolbar = Boolean(toolbar || toolbarRight || showColumnChooser || onExport);
  const showFooter = !error && rowCount > 0;

  const primaryColumnId = useMemo(() => {
    const flagged = columns.find((column) => column.meta?.primary);
    if (flagged) return flagged.id ?? columnIdOf(flagged);
    if (!onRowClick) return undefined;
    const first = columns[0];
    return first ? (first.id ?? columnIdOf(first)) : undefined;
  }, [columns, onRowClick]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => readRowHeight(dense),
    overscan: VIRTUAL_OVERSCAN,
    enabled: virtualize,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
  const paddingTop = virtualItems && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems && virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  const chooserColumns: ColumnChooserColumn[] = table
    .getAllLeafColumns()
    .filter((column) => !isInternalColumn(column.id))
    .map((column) => ({
      id: column.id,
      label: columnLabel(column),
      visible: column.getIsVisible(),
      canHide: column.getCanHide(),
    }));

  const rowActionsValue = useMemo<RowActionsContextValue>(
    () => ({ rowActions: rowActions as ((row: RowData) => ReactNode) | undefined }),
    [rowActions],
  );

  const selectedRows = showBulkBar
    ? table.getSelectedRowModel().rows.map((row) => row.original)
    : [];
  const bulkContent = typeof bulkActions === 'function' ? bulkActions(selectedRows) : bulkActions;

  const rowHeightClass = dense ? 'h-(--table-row-height-dense)' : 'h-(--table-row-height)';
  const bodyStyle: CSSProperties | undefined =
    maxHeight !== undefined
      ? { maxHeight }
      : virtualize
        ? { maxHeight: DEFAULT_VIRTUAL_MAX_HEIGHT }
        : undefined;
  const sticky = stickyHeader || virtualize;

  function renderRow(row: (typeof rows)[number], virtualIndex?: number) {
    const status = getRowStatus?.(row.original);
    const selected = status === 'selected' || row.getIsSelected();
    const clickable = Boolean(onRowClick) || Boolean(onRowDoubleClick);
    const justCreated = recentlyCreated.has(rowKey(row.original));
    const activate = (
      event: MouseEvent<HTMLTableRowElement> | KeyboardEvent<HTMLTableRowElement>,
    ) => {
      if (!onRowClick) return;
      if (isInteractiveTarget(event.target, event.currentTarget)) return;
      onRowClick(row.original);
    };
    return (
      <tr
        key={row.id}
        data-index={virtualIndex}
        ref={virtualIndex !== undefined ? virtualizer.measureElement : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-selected={selectable ? row.getIsSelected() : undefined}
        data-state={selected ? 'selected' : undefined}
        onClick={onRowClick ? activate : undefined}
        onDoubleClick={
          onRowDoubleClick
            ? (event) => {
                if (isInteractiveTarget(event.target, event.currentTarget)) return;
                onRowDoubleClick(row.original);
              }
            : undefined
        }
        onKeyDown={
          clickable
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                // Enter opens when there is somewhere to open; otherwise it falls back to the
                // single-click action, so a keyboard user is never worse off than a mouse user.
                if (event.key === 'Enter' && onRowDoubleClick) {
                  event.preventDefault();
                  onRowDoubleClick(row.original);
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate(event);
                }
              }
            : undefined
        }
        className={cn(
          rowHeightClass,
          'group/row transition-colors duration-(--duration-fast)',
          // A row created seconds ago is outlined so the person can see where it landed. The
          // outline removes itself; see `lib/recent-creates`.
          justCreated && 'relative outline-2 -outline-offset-2 outline-nw-done-icon',
          selected ? 'bg-nw-selected hover:bg-nw-selected' : 'hover:bg-nw-hover',
          status === 'muted' && 'text-nw-text-3',
          clickable &&
            'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
        )}
      >
        {row.getVisibleCells().map((cell) => {
          const meta = cell.column.columnDef.meta;
          const isPrimary = cell.column.id === primaryColumnId;
          return (
            <td
              key={cell.id}
              className={cn(
                'border-b border-nw-border px-2.5 align-middle text-sm whitespace-nowrap',
                status === 'muted' ? 'text-nw-text-3' : 'text-nw-text',
                meta?.align === 'right' && 'tabular',
                alignClass(meta),
                // ID / primary columns are bold (SPEC §7 tables).
                isPrimary && 'font-bold text-nw-text',
                meta?.className,
              )}
            >
              <FlexRender cell={cell} />
            </td>
          );
        })}
      </tr>
    );
  }

  let body: ReactNode;
  if (loading) {
    body = (
      <tr>
        <td colSpan={colCount} className="p-0">
          <TableSkeleton rows={Math.min(pageSize, 8)} columns={Math.min(colCount, 6)} />
        </td>
      </tr>
    );
  } else if (error) {
    body = (
      <tr>
        <td colSpan={colCount} className="p-0">
          <ErrorState size="sm" error={error} onRetry={onRetry} />
        </td>
      </tr>
    );
  } else if (rows.length === 0) {
    body = (
      <tr>
        <td colSpan={colCount} className="p-0">
          {empty ?? (
            <EmptyState
              size="sm"
              title={emptyTitle}
              description={emptyDescription}
              action={emptyAction}
            />
          )}
        </td>
      </tr>
    );
  } else if (virtualItems) {
    body = (
      <>
        {paddingTop > 0 ? (
          <tr aria-hidden style={{ height: paddingTop }}>
            <td colSpan={colCount} className="p-0" />
          </tr>
        ) : null}
        {virtualItems.map((item) => renderRow(rows[item.index]!, item.index))}
        {paddingBottom > 0 ? (
          <tr aria-hidden style={{ height: paddingBottom }}>
            <td colSpan={colCount} className="p-0" />
          </tr>
        ) : null}
      </>
    );
  } else {
    body = rows.map((row) => renderRow(row));
  }

  return (
    <RowActionsContext.Provider value={rowActionsValue}>
      <div
        id={id}
        data-dense={dense || undefined}
        className={cn(
          'flex min-w-0 flex-col overflow-hidden rounded-lg border border-nw-border bg-nw-panel',
          className,
        )}
      >
        {showBulkBar ? (
          <BulkActionBar count={selectedCount} onClear={() => onStateChange({ rowSelection: {} })}>
            {bulkContent}
          </BulkActionBar>
        ) : showToolbar ? (
          <div className="flex min-h-14 flex-wrap items-center gap-3 border-b border-nw-border px-4 py-3">
            {toolbar ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {toolbarRight}
              {onExport ? (
                <Button size="sm" variant="secondary" icon={<Download />} onClick={onExport}>
                  Export
                </Button>
              ) : null}
              {showColumnChooser ? (
                <ColumnChooser
                  columns={chooserColumns}
                  onToggle={(columnId, visible) =>
                    onStateChange({
                      columnVisibility: { ...state.columnVisibility, [columnId]: visible },
                    })
                  }
                  onReset={() => onStateChange({ columnVisibility: {} })}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          ref={scrollRef}
          data-virtualized={virtualize || undefined}
          className="scroll-quiet relative w-full min-w-0 overflow-auto"
          style={bodyStyle}
        >
          <table
            aria-busy={loading || undefined}
            className="w-full border-separate border-spacing-0 text-sm"
          >
            {caption ? <caption className="sr-only">{caption}</caption> : null}
            <thead className={cn(sticky && 'sticky top-0 z-10')}>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => (
                    <HeaderCell key={header.id} header={header} />
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>{body}</tbody>
          </table>
        </div>

        {showFooter ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-nw-border px-3 py-2">
            <p className="tabular text-xs text-nw-text-3">
              {formatPaginationRange(page, pageSize, rowCount)}
            </p>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={rowCount}
              pageSizes={pageSizes}
              showRange={false}
              onPageChange={(nextPage) =>
                onStateChange({ pagination: { page: nextPage, pageSize } })
              }
              onPageSizeChange={(nextSize) =>
                onStateChange({ pagination: { page: 1, pageSize: nextSize } })
              }
            />
          </div>
        ) : null}
      </div>
    </RowActionsContext.Provider>
  );
}

/** Mirrors TanStack's id resolution for columns without an explicit `id`. */
function columnIdOf<T extends RowData>(column: DataTableColumnDef<T>): string | undefined {
  if ('accessorKey' in column && column.accessorKey !== undefined) {
    return String(column.accessorKey).replace(/\./g, '_');
  }
  if (typeof column.header === 'string') return column.header;
  return undefined;
}

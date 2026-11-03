import { Archive, Eye, Pencil, Plus, Send, Trash2, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Button,
  BulkActionBar,
  ColumnChooser,
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  Pagination,
  StatusBadge,
  createColumns,
  useDataTableState,
  useToast,
  type ColumnChooserColumn,
  type DataTableColumnDef,
  type FilterDefinition,
} from '@/design-system';
import type { Truck } from '@/demo';
import { formatDate, formatMiles } from '@/lib/format';
import { galleryTrucks, TRUCK_STATUSES } from '../galleryData';
import { getStatus } from '@/design-system';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const col = createColumns<Truck>();

const truckColumns: DataTableColumnDef<Truck>[] = col.columns([
  col.accessor('unitNumber', {
    header: 'Unit',
    cell: (info) => `Unit ${info.getValue()}`,
    meta: { primary: true, width: 110 },
  }),
  col.accessor((row) => `${row.year} ${row.make} ${row.model}`, {
    id: 'vehicle',
    header: 'Vehicle',
    meta: { label: 'Vehicle' },
  }),
  col.accessor('status', {
    header: 'Status',
    cell: (info) => <StatusBadge status={info.getValue()} />,
    meta: { width: 140 },
  }),
  col.accessor('currentDriverName', {
    header: 'Driver',
    cell: (info) => info.getValue() ?? <span className="text-muted">Unassigned</span>,
  }),
  col.accessor((row) => (row.location ? `${row.location.city}, ${row.location.state}` : ''), {
    id: 'location',
    header: 'Location',
    cell: (info) => info.getValue() || <span className="text-muted">No signal</span>,
  }),
  col.accessor('odometer', {
    header: 'Odometer',
    cell: (info) => formatMiles(info.getValue()),
    meta: { align: 'right', width: 120 },
  }),
  col.accessor('nextServiceDate', {
    header: 'Next service',
    cell: (info) => formatDate(info.getValue()),
    meta: { width: 130 },
  }),
]);

const compactColumns = truckColumns.slice(0, 5);

const statusFilterOptions = TRUCK_STATUSES.map((s) => ({ value: s, label: getStatus(s).label }));

const filterDefinitions: FilterDefinition[] = [
  { key: 'status', label: 'Status', type: 'select', options: statusFilterOptions },
  {
    key: 'make',
    label: 'Make',
    type: 'multiselect',
    options: ['Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International'].map((m) => ({
      value: m,
      label: m,
    })),
  },
  { key: 'service', label: 'Next service', type: 'daterange' },
  { key: 'driver', label: 'Driver', type: 'text', placeholder: 'Driver name' },
];

function FullTable() {
  const { toast } = useToast();
  const [state, onStateChange] = useDataTableState({ pagination: { page: 1, pageSize: 10 } });
  return (
    <DataTable
      caption="Trucks"
      columns={truckColumns}
      data={galleryTrucks}
      rowKey={(t) => t.id}
      state={state}
      onStateChange={onStateChange}
      selectable
      stickyHeader
      onRowClick={(t) => toast({ tone: 'info', title: `Opens Unit ${t.unitNumber}` })}
      onExport={() =>
        toast({ tone: 'success', title: 'Export started', description: '25 trucks · CSV' })
      }
      pageSizes={[10, 25, 50]}
      toolbar={<span className="text-sm text-muted">Select rows to see the bulk action bar.</span>}
      bulkActions={(rows) => (
        <>
          <Button
            size="sm"
            variant="secondary"
            icon={<Wrench />}
            onClick={() =>
              toast({ tone: 'info', title: `Schedule maintenance for ${rows.length} trucks` })
            }
          >
            Schedule maintenance
          </Button>
          <Button size="sm" variant="secondary" icon={<Archive />}>
            Archive
          </Button>
        </>
      )}
      rowActions={(t) => (
        <>
          <MenuItem icon={<Eye />}>View Unit {t.unitNumber}</MenuItem>
          <MenuItem icon={<Pencil />} shortcut="E">
            Edit
          </MenuItem>
          <MenuItem icon={<Send />}>Assign driver</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} destructive>
            Retire truck
          </MenuItem>
        </>
      )}
    />
  );
}

function StandalonePagination() {
  const [page, setPage] = useState(3);
  const [pageSize, setPageSize] = useState(25);
  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      total={377}
      onPageChange={setPage}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setPage(1);
      }}
    />
  );
}

function StandaloneFilterBar() {
  const [search, setSearch] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({ status: 'driving' });
  return (
    <FilterBar
      search={{ value: search, onChange: setSearch, placeholder: 'Search trucks…' }}
      filters={filterDefinitions}
      values={values}
      onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
      onClear={() => setValues({})}
    />
  );
}

function StandaloneColumnChooser() {
  const [columns, setColumns] = useState<ColumnChooserColumn[]>([
    { id: 'unit', label: 'Unit', visible: true, canHide: false },
    { id: 'vehicle', label: 'Vehicle', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'driver', label: 'Driver', visible: false },
    { id: 'odometer', label: 'Odometer', visible: true },
  ]);
  return (
    <ColumnChooser
      columns={columns}
      onToggle={(id, visible) =>
        setColumns((c) => c.map((x) => (x.id === id ? { ...x, visible } : x)))
      }
      onReset={() => setColumns((c) => c.map((x) => ({ ...x, visible: true })))}
    />
  );
}

export function TablesSection() {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const error = useMemo(() => new Error('GET /api/trucks 503 Service Unavailable'), []);
  const denseRows = galleryTrucks.slice(0, 6);

  return (
    <GallerySection
      id="tables"
      index={7}
      title="Tables"
      note="Header 36px on surface-muted, rows 40px (34 dense), numeric columns right-aligned and tabular, primary column link-styled, actions in a trailing menu. Every table has loading, empty and error states."
    >
      <Example
        caption="DataTable · 25 demo trucks · sorting, selection + bulk bar, row actions, column chooser, export, sticky header, clickable rows"
        bare
      >
        <FullTable />
      </Example>

      <ExampleGrid columns={2}>
        <Example caption="Dense · 34px rows, no toolbar" bare>
          <DataTable
            caption="Trucks (dense)"
            columns={compactColumns}
            data={denseRows}
            rowKey={(t) => t.id}
            dense
            showColumnChooser={false}
            pageSizes={[25]}
          />
        </Example>
        <Example caption="Loading · skeleton rows" bare>
          <DataTable
            caption="Trucks (loading)"
            columns={compactColumns}
            data={[]}
            rowKey={(t) => t.id}
            loading
            showColumnChooser={false}
          />
        </Example>
        <Example caption="Empty · with a create action" bare>
          <DataTable
            caption="Trucks (empty)"
            columns={compactColumns}
            data={[]}
            rowKey={(t) => t.id}
            emptyTitle="No trucks match"
            emptyDescription="Try another status or clear the filters."
            emptyAction={
              <Button variant="primary" size="sm" icon={<Plus />}>
                Add truck
              </Button>
            }
            showColumnChooser={false}
          />
        </Example>
        <Example caption="Error · retry" bare>
          <DataTable
            caption="Trucks (error)"
            columns={compactColumns}
            data={[]}
            rowKey={(t) => t.id}
            error={error}
            onRetry={() => {
              setRetrying(true);
              setTimeout(() => {
                setRetrying(false);
                toast({
                  tone: 'warning',
                  title: 'Still unavailable',
                  description: 'The demo error never recovers.',
                });
              }, 600);
            }}
            showColumnChooser={false}
            aria-busy={retrying}
          />
        </Example>
      </ExampleGrid>

      <ExampleGroup title="Table toolbar pieces">
        <ExampleGrid columns={2}>
          <Example caption="Pagination · standalone with rows-per-page">
            <StandalonePagination />
          </Example>
          <Example caption="Pagination · without page size, first page">
            <Pagination page={1} pageSize={25} total={48} onPageChange={() => undefined} />
          </Example>
          <Example
            caption="FilterBar · search + select, multiselect, date range, text; chips show active values"
            wide
          >
            <StandaloneFilterBar />
          </Example>
          <Example caption="BulkActionBar · standalone">
            <div className="-m-4 overflow-hidden rounded-lg">
              <BulkActionBar
                count={3}
                noun="trucks"
                onClear={() => undefined}
                className="border-b-0"
              >
                <Button size="sm" variant="secondary" icon={<Wrench />}>
                  Schedule maintenance
                </Button>
                <Button size="sm" variant="secondary" icon={<Archive />}>
                  Archive
                </Button>
              </BulkActionBar>
            </div>
          </Example>
          <Example caption="ColumnChooser · standalone, one column locked" row>
            <StandaloneColumnChooser />
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}

import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { SortingState } from '@tanstack/react-table';
import { ClipboardCheck, ExternalLink, Play, Plus, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { InspectionState } from '@neway/shared';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  PageHeader,
  cn,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { startInspection } from '@/demo';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import {
  SafetyExceptionPanel,
  SafetySummaryStrip,
  type SafetySummarySegment,
} from './components/SafetyKit';
import { RecordResultDialog } from './components/RecordResultDialog';
import {
  DASH,
  INSPECTION_KIND_LABEL,
  INSPECTION_STATE_LABEL,
  INSPECTION_STATE_TONE,
  SEVERITY_TONE,
} from './safety-ui';
import {
  DATE_PRESETS,
  inspectionsSearchSchema,
  matchesInspection,
  parseIds,
  type InspectionsSearch,
} from './inspections-search';
import { useInvalidateSafety, useSafety, type SafetyInspection } from './useSafety';

const PAGE_SIZE = 25;

/** The buckets the strip offers, in the order the brief asks for. */
const SUMMARY_BUCKETS: ReadonlyArray<{
  key: InspectionState;
  label: string;
  tone?: SafetySummarySegment['tone'];
}> = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'passed', label: 'Passed', tone: 'success' },
  { key: 'failed', label: 'Failed', tone: 'danger' },
  { key: 'corrective_action_required', label: 'Corrective action', tone: 'warning' },
  { key: 'overdue', label: 'Overdue', tone: 'danger' },
];

function parseSort(value: string | undefined): SortingState {
  if (!value) return [];
  const desc = value.startsWith('-');
  return [{ id: desc ? value.slice(1) : value, desc }];
}

function serializeSort(sorting: SortingState): string | undefined {
  const first = sorting[0];
  if (!first) return undefined;
  return first.desc ? `-${first.id}` : first.id;
}

const col = createColumns<SafetyInspection>();

/**
 * The Inspections list.
 *
 * The status column shows the **derived** lifecycle, not the stored pass/fail: an inspection that
 * passed but left two defects open is not finished work, and calling it "Passed" is how a defect
 * gets forgotten. The stored result is still visible in its own column, so nothing is hidden.
 *
 * Single click selects, double click or the inspection number opens — the same rule as Fleet, so a
 * list can be used to compare two rows rather than only to leave it.
 */
export function InspectionsPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => inspectionsSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();

  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [recording, setRecording] = useState<SafetyInspection | null>(null);

  const safetyQuery = useSafety();
  const bundle = safetyQuery.data;
  const today = bundle?.today ?? '';

  const begin = useMutation({
    mutationFn: (id: string) => startInspection({ id }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That could not be started', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.inspection?.inspectionNumber} started` });
    },
  });

  function updateSearch(patch: Partial<InspectionsSearch>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  function open(row: SafetyInspection) {
    void navigate({
      to: '/safety/inspections/$inspectionId',
      params: { inspectionId: row.inspection.id },
    });
  }

  const rows = useMemo(
    () => (bundle?.inspections ?? []).filter((row) => matchesInspection(row, search, today)),
    [bundle, search, today],
  );

  // Counted with the same predicate the table filters on, minus the state facet itself.
  const counts = useMemo(() => {
    const base = (bundle?.inspections ?? []).filter((row) =>
      matchesInspection(row, { ...search, state: undefined }, today),
    );
    const map = new Map<string, number>();
    for (const row of base) map.set(row.state.state, (map.get(row.state.state) ?? 0) + 1);
    return { map, total: base.length };
  }, [bundle, search, today]);

  const segments: SafetySummarySegment[] = useMemo(() => {
    const all: SafetySummarySegment[] = [
      {
        key: '__total',
        label: 'Total',
        count: bundle ? counts.total : null,
        onSelect: () => updateSearch({ state: undefined, ids: undefined, page: undefined }),
      },
    ];
    for (const bucket of SUMMARY_BUCKETS) {
      all.push({
        key: bucket.key,
        label: bucket.label,
        count: bundle ? (counts.map.get(bucket.key) ?? 0) : null,
        tone: bucket.tone,
        onSelect: () =>
          updateSearch({
            state: search.state === bucket.key ? undefined : bucket.key,
            ids: undefined,
            page: undefined,
          }),
      });
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.state]);

  const filters = useMemo<FilterDefinition[]>(() => {
    const all = bundle?.inspections ?? [];
    const inspectors = [...new Set(all.map((r) => r.inspection.inspector))].sort();
    const units = [
      ...new Map(all.map((r) => [r.inspection.assetId, r.inspection.unitNumber])),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    const drivers = [
      ...new Map(
        all
          .filter((r) => r.inspection.driverId)
          .map((r) => [r.inspection.driverId as string, r.inspection.driverName as string]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1]));

    return [
      {
        key: 'state',
        label: 'Status',
        type: 'select',
        options: SUMMARY_BUCKETS.map((b) => ({ value: b.key, label: b.label })).concat([
          { value: 'cancelled', label: 'Cancelled' },
        ]),
      },
      {
        key: 'kind',
        label: 'Type',
        type: 'select',
        options: Object.entries(INSPECTION_KIND_LABEL).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'result',
        label: 'Result',
        type: 'select',
        options: [
          { value: 'pass', label: 'Pass' },
          { value: 'fail', label: 'Fail' },
        ],
      },
      {
        key: 'driver',
        label: 'Driver',
        type: 'select',
        options: drivers.map(([value, label]) => ({ value, label })),
      },
      {
        key: 'unit',
        label: 'Unit',
        type: 'select',
        options: units.map(([value, label]) => ({ value, label })),
      },
      {
        key: 'inspector',
        label: 'Inspector',
        type: 'select',
        options: inspectors.map((value) => ({ value, label: value })),
      },
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        options: [
          { value: 'critical', label: 'Critical' },
          { value: 'high', label: 'High' },
          { value: 'medium', label: 'Medium' },
          { value: 'low', label: 'Low' },
        ],
      },
      {
        key: 'defects',
        label: 'Corrective action',
        type: 'select',
        options: [
          { value: 'open', label: 'Defects still open' },
          { value: 'overdue', label: 'Repair overdue' },
          { value: 'blocking', label: 'Out of service' },
        ],
      },
      {
        key: 'range',
        label: 'Date',
        type: 'select',
        options: DATE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
      },
    ];
  }, [bundle]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'inspectionNumber',
          header: 'Inspection #',
          meta: { primary: true, width: 140 },
          cell: ({ row }) => (
            <Link
              to="/safety/inspections/$inspectionId"
              params={{ inspectionId: row.original.inspection.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.inspection.inspectionNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'at',
          header: 'Date',
          meta: { width: 120 },
          cell: ({ row }) => (
            <span title={formatDateTime(row.original.inspection.at)}>
              {formatIsoDate(row.original.inspection.at.slice(0, 10))}
            </span>
          ),
        }),
        col.display({
          id: 'kind',
          header: 'Type',
          meta: { width: 120 },
          cell: ({ row }) => INSPECTION_KIND_LABEL[row.original.inspection.kind],
        }),
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { width: 90 },
          cell: ({ row }) => (
            <Link
              to="/fleet/trucks/$truckId"
              params={{ truckId: row.original.inspection.assetId }}
              className="hover:underline"
            >
              {row.original.inspection.unitNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'driver',
          header: 'Driver',
          cell: ({ row }) =>
            row.original.inspection.driverId ? (
              <Link
                to="/drivers"
                search={{ driver: row.original.inspection.driverId }}
                className="truncate hover:underline"
              >
                {row.original.inspection.driverName}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'location',
          header: 'Location',
          cell: ({ row }) =>
            row.original.inspection.location ? (
              `${row.original.inspection.location.city}, ${row.original.inspection.location.state}`
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'inspector',
          header: 'Inspector',
          cell: ({ row }) => (
            <span className="truncate" title={row.original.inspection.inspectorAgency ?? undefined}>
              {row.original.inspection.inspector}
            </span>
          ),
        }),
        col.display({
          id: 'result',
          header: 'Result',
          meta: { width: 90 },
          cell: ({ row }) => {
            const result = row.original.inspection.result;
            if (!result) {
              return (
                <span className="text-faint" title="Not performed yet">
                  {DASH}
                </span>
              );
            }
            return (
              <Badge tone={result === 'pass' ? 'success' : 'danger'}>
                {result === 'pass' ? 'Pass' : 'Fail'}
              </Badge>
            );
          },
        }),
        col.display({
          id: 'defects',
          header: 'Findings',
          meta: { align: 'right', width: 110 },
          cell: ({ row }) => {
            const total = row.original.defects.length;
            if (total === 0) return <span className="text-faint">{DASH}</span>;
            const open = row.original.openDefects;
            return (
              <span className={cn(open > 0 && 'font-medium text-warning-text')}>
                {open > 0 ? `${open} of ${total} open` : `${total} cleared`}
              </span>
            );
          },
        }),
        col.display({
          id: 'severity',
          header: 'Severity',
          meta: { width: 100 },
          cell: ({ row }) => {
            const worst = [...row.original.defects].sort(
              (a, b) => a.urgency.rank - b.urgency.rank,
            )[0];
            if (!worst) return <span className="text-faint">{DASH}</span>;
            return (
              <Badge tone={SEVERITY_TONE[worst.defect.severity]}>
                {worst.defect.severity[0]?.toUpperCase() + worst.defect.severity.slice(1)}
              </Badge>
            );
          },
        }),
        col.display({
          id: 'state',
          header: 'Status',
          meta: { width: 150 },
          cell: ({ row }) => (
            <Badge
              tone={INSPECTION_STATE_TONE[row.original.state.state]}
              title={row.original.state.reasons.join('. ')}
            >
              {INSPECTION_STATE_LABEL[row.original.state.state]}
            </Badge>
          ),
        }),
      ]),
    [],
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Inspections"
        description="Monitor inspections, findings, corrective actions and compliance status across your fleet."
      />

      {bundle ? (
        <SafetyExceptionPanel
          items={bundle.exceptions.items.filter((item) => item.target.to === '/safety/inspections')}
          unavailable={bundle.exceptions.unavailable}
          onSelect={(item) =>
            updateSearch({
              state: undefined,
              defects: undefined,
              ...item.target.search,
              ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      <SafetySummaryStrip
        segments={segments}
        activeKey={search.state ?? (search.ids ? null : '__total')}
        loading={safetyQuery.isPending}
      />

      {search.ids ? (
        <p className="text-sm text-secondary">
          Showing the {parseIds(search.ids).length} inspections behind one finding.{' '}
          <button
            type="button"
            className="font-medium text-primary-text hover:underline"
            onClick={() => updateSearch({ ids: undefined, page: undefined })}
          >
            Show them all
          </button>
        </p>
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(row) => row.inspection.id}
        state={{
          sorting: parseSort(search.sort),
          pagination: { page: search.page ?? 1, pageSize: PAGE_SIZE },
          rowSelection,
          columnVisibility,
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.sorting !== undefined) {
            updateSearch({ sort: serializeSort(patch.sorting as SortingState), page: undefined });
          }
          if (patch.pagination !== undefined) {
            updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined });
          }
          if (patch.rowSelection !== undefined) setRowSelection(patch.rowSelection);
          if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility);
        }}
        loading={safetyQuery.isPending}
        error={safetyQuery.error ?? undefined}
        onRetry={() => void safetyQuery.refetch()}
        emptyTitle="No inspections yet"
        emptyDescription="Inspections record what was checked on a unit, what was found, and what was done about it. Book one to start the file."
        emptyAction={
          <Button icon={<Plus />} onClick={() => void navigate({ to: '/safety/inspections/new' })}>
            Create inspection
          </Button>
        }
        selectable
        caption="Inspections"
        onRowClick={(row) =>
          setRowSelection((current) => {
            const next = { ...current };
            if (next[row.inspection.id]) delete next[row.inspection.id];
            else next[row.inspection.id] = true;
            return next;
          })
        }
        onRowDoubleClick={open}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search inspection, driver, unit, location…',
            }}
            filters={filters}
            values={{
              state: search.state,
              kind: search.kind,
              result: search.result,
              driver: search.driver,
              unit: search.unit,
              inspector: search.inspector,
              severity: search.severity,
              defects: search.defects,
              range: search.range,
            }}
            onChange={(key, value) =>
              updateSearch({
                [key]: (value as string | undefined) || undefined,
                ids: undefined,
                page: undefined,
              })
            }
            onClear={() =>
              updateSearch({
                state: undefined,
                kind: undefined,
                result: undefined,
                driver: undefined,
                unit: undefined,
                inspector: undefined,
                severity: undefined,
                defects: undefined,
                range: undefined,
                from: undefined,
                to: undefined,
                ids: undefined,
                page: undefined,
              })
            }
          >
            {/* Search, filters and the primary action on one row. */}
            <span className="ml-auto flex items-center gap-2">
              <Button
                variant="primary"
                icon={<Plus />}
                onClick={() => void navigate({ to: '/safety/inspections/new' })}
              >
                Create inspection
              </Button>
            </span>
          </FilterBar>
        }
        rowActions={(row) => (
          <>
            <MenuItem icon={<ExternalLink />} onSelect={() => open(row)}>
              Open inspection
            </MenuItem>
            {/* The actions follow the derived state, so the menu never offers a move that
                the inspection's own history makes impossible. */}
            {row.state.state === 'scheduled' || row.state.state === 'overdue' ? (
              <MenuItem icon={<Play />} onSelect={() => begin.mutate(row.inspection.id)}>
                Start inspection
              </MenuItem>
            ) : null}
            {row.state.state === 'in_progress' ? (
              <MenuItem icon={<ClipboardCheck />} onSelect={() => setRecording(row)}>
                Record result
              </MenuItem>
            ) : null}
            {row.openDefects > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem icon={<Wrench />} onSelect={() => open(row)}>
                  {row.openDefects} open finding{row.openDefects === 1 ? '' : 's'}
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      />

      {recording ? (
        <RecordResultDialog
          open
          onOpenChange={(next) => {
            if (!next) setRecording(null);
          }}
          inspection={recording}
          onDone={() => setRecording(null)}
        />
      ) : null}
    </div>
  );
}

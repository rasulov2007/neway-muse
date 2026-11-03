import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { SortingState } from '@tanstack/react-table';
import { CheckCircle2, ExternalLink, Gavel, Plus, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { VIOLATION_CATEGORIES } from '@neway/shared';
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
import { updateViolation } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { CreateCorrectiveActionDialog } from './components/CreateCorrectiveActionDialog';
import {
  SafetyExceptionPanel,
  SafetyIndicatorRow,
  SafetySummaryStrip,
  type SafetySummarySegment,
} from './components/SafetyKit';
import { DATE_PRESETS } from './inspections-search';
import {
  DASH,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  VIOLATION_CATEGORY_LABEL,
  VIOLATION_STATE_LABEL,
  VIOLATION_STATE_TONE,
} from './safety-ui';
import {
  matchesViolation,
  parseIds,
  violationsSearchSchema,
  type ViolationsSearch,
} from './violations-search';
import { useInvalidateSafety, useSafety, type SafetyViolation } from './useSafety';

const PAGE_SIZE = 25;

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

const col = createColumns<SafetyViolation>();

/**
 * The Violations list.
 *
 * The intelligence strip under the header is statements of fact — "4 violations in the last 30
 * days", "2 repeat hours of service violations" — each of which opens exactly the records it
 * counted. There is no risk score, because FMCSA's severity weighting and peer percentiles are
 * data this system does not hold; the engine names that as unavailable rather than inventing a
 * number to fill the space.
 */
export function ViolationsPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => violationsSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();

  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [raising, setRaising] = useState<SafetyViolation | null>(null);

  const safetyQuery = useSafety();
  const bundle = safetyQuery.data;
  const today = bundle?.today ?? '';

  const resolve = useMutation({
    mutationFn: (id: string) => updateViolation({ id, resolved: true, reason: 'Marked resolved' }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.violation?.violationNumber} resolved` });
    },
  });

  const contest = useMutation({
    mutationFn: ({ id, contested }: { id: string; contested: boolean }) =>
      updateViolation({
        id,
        contested,
        reason: contested ? 'Contested by the carrier' : 'Challenge withdrawn',
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'info',
        title: `${result.violation?.violationNumber} ${result.violation?.contested ? 'contested' : 'no longer contested'}`,
        description: result.violation?.contested
          ? 'It still counts against the carrier until the challenge succeeds.'
          : undefined,
      });
    },
  });

  function updateSearch(patch: Partial<ViolationsSearch>) {
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

  function open(row: SafetyViolation) {
    void navigate({
      to: '/safety/violations/$violationId',
      params: { violationId: row.violation.id },
    });
  }

  const rows = useMemo(
    () => (bundle?.violations ?? []).filter((row) => matchesViolation(row, search, today)),
    [bundle, search, today],
  );

  const counts = useMemo(() => {
    const base = (bundle?.violations ?? []).filter((row) =>
      matchesViolation(row, { ...search, state: undefined }, today),
    );
    const outstanding = base.filter((r) => r.state.state !== 'resolved');
    return {
      total: base.length,
      open: outstanding.length,
      disputed: base.filter((r) => r.state.state === 'disputed').length,
      critical: outstanding.filter((r) => r.violation.severity === 'critical').length,
      needsAction: base.filter((r) => r.state.state === 'corrective_action_required').length,
      resolved: base.filter((r) => r.state.state === 'resolved').length,
      overdue: base.filter((r) => r.state.state === 'overdue').length,
    };
  }, [bundle, search, today]);

  const segments: SafetySummarySegment[] = useMemo(() => {
    const define = (
      key: string,
      label: string,
      count: number,
      tone?: SafetySummarySegment['tone'],
    ): SafetySummarySegment => ({
      key,
      label,
      count: bundle ? count : null,
      tone,
      onSelect: () =>
        updateSearch({
          state: key === '__total' ? undefined : search.state === key ? undefined : key,
          ids: undefined,
          page: undefined,
        }),
    });
    return [
      define('__total', 'Total', counts.total),
      define('open', 'Open', counts.open),
      define('disputed', 'Contested', counts.disputed),
      define('corrective_action_required', 'Corrective action', counts.needsAction, 'warning'),
      define('overdue', 'Overdue', counts.overdue, 'danger'),
      define('resolved', 'Resolved', counts.resolved, 'success'),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.state]);

  const filters = useMemo<FilterDefinition[]>(() => {
    const all = bundle?.violations ?? [];
    const drivers = [
      ...new Map(
        all
          .filter((r) => r.violation.driverId)
          .map((r) => [r.violation.driverId as string, r.violation.driverName as string]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    const units = [
      ...new Map(
        all
          .filter((r) => r.violation.truckId)
          .map((r) => [r.violation.truckId as string, r.violation.unitNumber as string]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    const states = [
      ...new Set(all.flatMap((r) => (r.violation.location ? [r.violation.location.state] : []))),
    ].sort();

    return [
      {
        key: 'state',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'corrective_action_required', label: 'Corrective action' },
          { value: 'disputed', label: 'Contested' },
          { value: 'overdue', label: 'Overdue' },
          { value: 'resolved', label: 'Resolved' },
        ],
      },
      {
        key: 'category',
        label: 'BASIC',
        type: 'select',
        options: VIOLATION_CATEGORIES.map((value) => ({
          value,
          label: VIOLATION_CATEGORY_LABEL[value],
        })),
      },
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        options: (['critical', 'high', 'medium', 'low'] as const).map((value) => ({
          value,
          label: SEVERITY_LABEL[value],
        })),
      },
      {
        key: 'source',
        label: 'Source',
        type: 'select',
        options: [
          { value: 'roadside', label: 'Roadside inspection' },
          { value: 'company', label: 'Internal review' },
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
        key: 'st',
        label: 'State',
        type: 'select',
        options: states.map((value) => ({ value, label: value })),
      },
      {
        key: 'inspection',
        label: 'Inspection',
        type: 'select',
        options: [
          { value: 'linked', label: 'From an inspection' },
          { value: 'none', label: 'No inspection' },
        ],
      },
      {
        key: 'action',
        label: 'Corrective action',
        type: 'select',
        options: [
          { value: 'open', label: 'Action outstanding' },
          { value: 'none', label: 'No action raised' },
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
          id: 'violationNumber',
          header: 'Violation #',
          meta: { primary: true, width: 140 },
          cell: ({ row }) => (
            <Link
              to="/safety/violations/$violationId"
              params={{ violationId: row.original.violation.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.violation.violationNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'onDate',
          header: 'Date',
          meta: { width: 110 },
          cell: ({ row }) => formatIsoDate(row.original.violation.onDate),
        }),
        col.display({
          id: 'driver',
          header: 'Driver',
          cell: ({ row }) =>
            row.original.violation.driverId ? (
              <Link
                to="/drivers"
                search={{ driver: row.original.violation.driverId }}
                className="truncate hover:underline"
              >
                {row.original.violation.driverName}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { width: 90 },
          cell: ({ row }) =>
            row.original.violation.truckId ? (
              <Link
                to="/fleet/trucks/$truckId"
                params={{ truckId: row.original.violation.truckId }}
                className="hover:underline"
              >
                {row.original.violation.unitNumber}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'code',
          header: 'Code',
          meta: { width: 130 },
          cell: ({ row }) => (
            <span className="font-mono text-xs" title={row.original.violation.description}>
              {row.original.violation.code}
            </span>
          ),
        }),
        col.display({
          id: 'category',
          header: 'BASIC',
          meta: { width: 160 },
          cell: ({ row }) => VIOLATION_CATEGORY_LABEL[row.original.violation.category],
        }),
        col.display({
          id: 'location',
          header: 'Location',
          cell: ({ row }) =>
            row.original.violation.location ? (
              `${row.original.violation.location.city}, ${row.original.violation.location.state}`
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'severity',
          header: 'Severity',
          meta: { width: 100 },
          cell: ({ row }) => (
            <Badge tone={SEVERITY_TONE[row.original.violation.severity]}>
              {SEVERITY_LABEL[row.original.violation.severity]}
            </Badge>
          ),
        }),
        col.display({
          id: 'source',
          header: 'Source',
          meta: { width: 130 },
          cell: ({ row }) =>
            row.original.violation.source === 'roadside' ? (
              row.original.inspection ? (
                <Link
                  to="/safety/inspections/$inspectionId"
                  params={{ inspectionId: row.original.inspection.id }}
                  className="hover:underline"
                >
                  Roadside
                </Link>
              ) : (
                'Roadside'
              )
            ) : (
              'Internal review'
            ),
        }),
        col.display({
          id: 'citation',
          header: 'Citation',
          meta: { width: 110 },
          cell: ({ row }) =>
            row.original.violation.citationNumber ?? <span className="text-faint">{DASH}</span>,
        }),
        col.display({
          id: 'fine',
          header: 'Fine',
          meta: { align: 'right', width: 90 },
          cell: ({ row }) =>
            row.original.violation.fineAmount === null ? (
              <span className="text-faint">{DASH}</span>
            ) : (
              formatMoney(row.original.violation.fineAmount)
            ),
        }),
        col.display({
          id: 'points',
          header: 'Weight',
          meta: { align: 'right', width: 90 },
          cell: ({ row }) =>
            row.original.violation.points === null ? (
              <span
                className="text-faint"
                title="An internally recorded finding never went on a roadside report, so it carries no FMCSA weight."
              >
                {DASH}
              </span>
            ) : (
              row.original.violation.points
            ),
        }),
        col.display({
          id: 'action',
          header: 'Corrective action',
          meta: { width: 150 },
          cell: ({ row }) => {
            const outstanding = row.original.correctiveActions.filter((a) => a.state.outstanding);
            if (row.original.correctiveActions.length === 0) {
              return <span className="text-faint">None raised</span>;
            }
            if (outstanding.length === 0)
              return <span className="text-success-text">Complete</span>;
            const worst = outstanding.find((a) => a.state.state === 'overdue') ?? outstanding[0];
            return (
              <span
                className={cn(worst?.state.state === 'overdue' && 'font-medium text-danger-text')}
                title={worst?.state.reasons.join('. ')}
              >
                {worst?.state.state === 'overdue'
                  ? `Overdue ${worst.state.daysLate}d`
                  : `${outstanding.length} open`}
              </span>
            );
          },
        }),
        col.display({
          id: 'state',
          header: 'Status',
          meta: { width: 140 },
          cell: ({ row }) => (
            <Badge
              tone={VIOLATION_STATE_TONE[row.original.state.state]}
              title={row.original.state.reasons.join('. ')}
            >
              {VIOLATION_STATE_LABEL[row.original.state.state]}
            </Badge>
          ),
        }),
      ]),
    [],
  );

  const summary = bundle?.violationSummary;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Violations"
        description="Monitor driver and vehicle violations, severity, corrective actions and compliance risk."
      />

      {bundle ? (
        <SafetyExceptionPanel
          items={bundle.exceptions.items.filter((item) => item.target.to === '/safety/violations')}
          unavailable={bundle.exceptions.unavailable}
          onSelect={(item) =>
            updateSearch({
              state: undefined,
              severity: undefined,
              ...item.target.search,
              ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      {summary && summary.indicators.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SafetyIndicatorRow
            indicators={summary.indicators}
            onSelect={(ids) =>
              updateSearch({ ids: ids.join(','), state: undefined, page: undefined })
            }
          />
          <p className="text-xs text-faint">
            Counts and repetition, computed from these records. A CSA percentile and a driver risk
            score need {summary.unavailable.map((u) => u.requires.toLowerCase()).join(', and ')} —
            neither is estimated here.
          </p>
        </div>
      ) : null}

      <SafetySummaryStrip
        segments={segments}
        activeKey={search.state ?? (search.ids ? null : '__total')}
        loading={safetyQuery.isPending}
      />

      {search.ids ? (
        <p className="text-sm text-secondary">
          Showing the {parseIds(search.ids).length} violations behind one finding.{' '}
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
        rowKey={(row) => row.violation.id}
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
        emptyTitle="No violations found"
        emptyDescription="Violations record what a roadside inspection or an internal review found against a driver or a unit, and what was done about it."
        emptyAction={
          <Button icon={<Plus />} onClick={() => void navigate({ to: '/safety/violations/new' })}>
            Record violation
          </Button>
        }
        selectable
        caption="Violations"
        onRowClick={(row) =>
          setRowSelection((current) => {
            const next = { ...current };
            if (next[row.violation.id]) delete next[row.violation.id];
            else next[row.violation.id] = true;
            return next;
          })
        }
        onRowDoubleClick={open}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search violation, driver, unit, citation…',
            }}
            filters={filters}
            values={{
              state: search.state,
              category: search.category,
              severity: search.severity,
              source: search.source,
              driver: search.driver,
              unit: search.unit,
              st: search.st,
              inspection: search.inspection,
              action: search.action,
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
                category: undefined,
                severity: undefined,
                source: undefined,
                driver: undefined,
                unit: undefined,
                st: undefined,
                inspection: undefined,
                action: undefined,
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
                onClick={() => void navigate({ to: '/safety/violations/new' })}
              >
                Record violation
              </Button>
            </span>
          </FilterBar>
        }
        rowActions={(row) => (
          <>
            <MenuItem icon={<ExternalLink />} onSelect={() => open(row)}>
              Open violation
            </MenuItem>
            {row.state.state !== 'resolved' ? (
              <>
                {row.correctiveActions.every((a) => !a.state.outstanding) ? (
                  <MenuItem icon={<ShieldAlert />} onSelect={() => setRaising(row)}>
                    Create corrective action
                  </MenuItem>
                ) : null}
                <MenuItem
                  icon={<Gavel />}
                  onSelect={() =>
                    contest.mutate({
                      id: row.violation.id,
                      contested: !row.violation.contested,
                    })
                  }
                >
                  {row.violation.contested ? 'Withdraw challenge' : 'Contest violation'}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<CheckCircle2 />} onSelect={() => resolve.mutate(row.violation.id)}>
                  Mark resolved
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      />

      {raising ? (
        <CreateCorrectiveActionDialog
          open
          onOpenChange={(next) => {
            if (!next) setRaising(null);
          }}
          subjectType="violation"
          subjectId={raising.violation.id}
          subjectLabel={raising.violation.violationNumber}
          severity={raising.violation.severity}
          defaultTitle={`Corrective action: ${VIOLATION_CATEGORY_LABEL[raising.violation.category]}`}
          defaultDescription={raising.violation.description}
          onDone={() => setRaising(null)}
        />
      ) : null}
    </div>
  );
}

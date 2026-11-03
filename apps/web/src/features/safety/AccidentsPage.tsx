import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { SortingState } from '@tanstack/react-table';
import { ExternalLink, FileWarning, Plus, Search, ShieldAlert, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ACCIDENT_SEVERITIES } from '@neway/shared';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  PageHeader,
  StatusBadge,
  cn,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { demoUsers, updateAccident } from '@/demo';
import { formatDateTime, formatIsoDate, formatMoney, formatNumber, formatTime } from '@/lib/format';
import { CreateClaimDialog } from './components/CreateClaimDialog';
import {
  SafetyExceptionPanel,
  SafetySummaryStrip,
  type SafetySummarySegment,
} from './components/SafetyKit';
import { DATE_PRESETS } from './inspections-search';
import {
  ACCIDENT_KIND_LABEL,
  ACCIDENT_SEVERITY_LABEL,
  ACCIDENT_SEVERITY_TONE,
  DASH,
  PREVENTABILITY_LABEL,
  PREVENTABILITY_TONE,
} from './safety-ui';
import {
  accidentsSearchSchema,
  matchesAccident,
  parseIds,
  type AccidentsSearch,
} from './accidents-search';
import { useInvalidateSafety, useSafety, type SafetyAccident } from './useSafety';

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

const col = createColumns<SafetyAccident>();

/**
 * The Accidents list.
 *
 * Two columns carry more weight than they look: **Preventability**, which stays amber while it is
 * undetermined because an undecided file settles neither the driver's record nor the insurer
 * conversation; and **DOT**, which applies 49 CFR 390.5 to what was reported rather than asking
 * anyone to remember the rule.
 */
export function AccidentsPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => accidentsSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();

  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [claiming, setClaiming] = useState<SafetyAccident | null>(null);

  const safetyQuery = useSafety();
  const bundle = safetyQuery.data;
  const today = bundle?.today ?? '';

  const beginInvestigation = useMutation({
    mutationFn: (row: SafetyAccident) =>
      updateAccident({
        id: row.accident.id,
        status: 'investigating',
        ownerId:
          row.accident.ownerId ?? demoUsers.find((u) => u.department === 'safety')?.id ?? null,
        reason: 'Investigation opened',
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${result.accident?.accidentNumber} under investigation`,
        description: result.accident?.ownerName
          ? `Assigned to ${result.accident.ownerName}.`
          : undefined,
      });
    },
  });

  function updateSearch(patch: Partial<AccidentsSearch>) {
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

  function open(row: SafetyAccident) {
    void navigate({
      to: '/safety/accidents/$accidentId',
      params: { accidentId: row.accident.id },
    });
  }

  const rows = useMemo(
    () => (bundle?.accidents ?? []).filter((row) => matchesAccident(row, search, today)),
    [bundle, search, today],
  );

  const counts = useMemo(() => {
    const base = (bundle?.accidents ?? []).filter((row) =>
      matchesAccident(row, { ...search, status: undefined }, today),
    );
    return {
      total: base.length,
      open: base.filter((r) => r.review.open).length,
      investigating: base.filter((r) => r.accident.status === 'investigating').length,
      critical: base.filter((r) => r.accident.severity === 'critical').length,
      injury: base.filter((r) => r.accident.injuries.length > 0 || r.accident.fatalities > 0)
        .length,
      preventable: base.filter((r) => r.accident.preventable === 'yes').length,
      undetermined: base.filter((r) => r.review.open && r.accident.preventable === 'undetermined')
        .length,
      closed: base.filter((r) => r.accident.status === 'closed').length,
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
          status: key === '__total' ? undefined : search.status === key ? undefined : key,
          preventable: undefined,
          injury: undefined,
          ids: undefined,
          page: undefined,
        }),
    });
    return [
      define('__total', 'Total', counts.total),
      define('open', 'Open', counts.open),
      define('investigating', 'Investigating', counts.investigating),
      {
        key: '__injury',
        label: 'Injury',
        count: bundle ? counts.injury : null,
        tone: 'warning',
        onSelect: () =>
          updateSearch({
            injury: search.injury === 'yes' ? undefined : 'yes',
            status: undefined,
            ids: undefined,
            page: undefined,
          }),
      },
      {
        key: '__preventable',
        label: 'Preventable',
        count: bundle ? counts.preventable : null,
        tone: 'danger',
        onSelect: () =>
          updateSearch({
            preventable: search.preventable === 'yes' ? undefined : 'yes',
            status: undefined,
            ids: undefined,
            page: undefined,
          }),
      },
      {
        key: '__undetermined',
        label: 'Undecided',
        count: bundle ? counts.undetermined : null,
        tone: 'warning',
        onSelect: () =>
          updateSearch({
            preventable: search.preventable === 'undetermined' ? undefined : 'undetermined',
            status: search.preventable === 'undetermined' ? undefined : 'open',
            ids: undefined,
            page: undefined,
          }),
      },
      define('closed', 'Closed', counts.closed, 'success'),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.status, search.preventable, search.injury]);

  const filters = useMemo<FilterDefinition[]>(() => {
    const all = bundle?.accidents ?? [];
    const drivers = [...new Map(all.map((r) => [r.accident.driverId, r.accident.driverName]))].sort(
      (a, b) => a[1].localeCompare(b[1]),
    );
    const units = [...new Map(all.map((r) => [r.accident.truckId, r.accident.unitNumber]))].sort(
      (a, b) => a[1].localeCompare(b[1]),
    );
    const owners = [
      ...new Map(
        all
          .filter((r) => r.accident.ownerId)
          .map((r) => [r.accident.ownerId as string, r.accident.ownerName as string]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1]));

    return [
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'open', label: 'Open (any stage)' },
          { value: 'reported', label: 'Reported' },
          { value: 'under_review', label: 'Under review' },
          { value: 'investigating', label: 'Investigating' },
          { value: 'pending_documents', label: 'Pending documents' },
          { value: 'safety_review', label: 'Safety review' },
          { value: 'management_review', label: 'Management review' },
          { value: 'closed', label: 'Closed' },
        ],
      },
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        options: ACCIDENT_SEVERITIES.map((value) => ({
          value,
          label: ACCIDENT_SEVERITY_LABEL[value],
        })),
      },
      {
        key: 'kind',
        label: 'Type',
        type: 'select',
        options: Object.entries(ACCIDENT_KIND_LABEL).map(([value, label]) => ({ value, label })),
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
        key: 'preventable',
        label: 'Preventability',
        type: 'select',
        options: [
          { value: 'yes', label: 'Preventable' },
          { value: 'no', label: 'Non-preventable' },
          { value: 'undetermined', label: 'Undetermined' },
        ],
      },
      {
        key: 'injury',
        label: 'Injury',
        type: 'select',
        options: [
          { value: 'yes', label: 'With injury' },
          { value: 'fatality', label: 'With fatality' },
          { value: 'none', label: 'No injury' },
        ],
      },
      {
        key: 'owner',
        label: 'Owner',
        type: 'select',
        options: [
          { value: 'unassigned', label: 'Unassigned' },
          ...owners.map(([value, label]) => ({ value, label })),
        ],
      },
      {
        key: 'claim',
        label: 'Claim',
        type: 'select',
        options: [
          { value: 'linked', label: 'Claim opened' },
          { value: 'none', label: 'No claim' },
        ],
      },
      {
        key: 'recordable',
        label: 'DOT recordable',
        type: 'select',
        options: [
          { value: 'yes', label: 'Recordable' },
          { value: 'no', label: 'Not recordable' },
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
          id: 'accidentNumber',
          header: 'Accident #',
          meta: { primary: true, width: 140 },
          cell: ({ row }) => (
            <Link
              to="/safety/accidents/$accidentId"
              params={{ accidentId: row.original.accident.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.accident.accidentNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'at',
          header: 'Date',
          meta: { width: 110 },
          cell: ({ row }) => (
            <span title={formatDateTime(row.original.accident.at)}>
              {formatIsoDate(row.original.accident.at.slice(0, 10))}
            </span>
          ),
        }),
        col.display({
          id: 'time',
          header: 'Time',
          meta: { width: 80 },
          cell: ({ row }) => formatTime(row.original.accident.at),
        }),
        col.display({
          id: 'location',
          header: 'Location',
          cell: ({ row }) => (
            <span className="truncate">
              {row.original.accident.location.city}, {row.original.accident.location.state}
              {row.original.accident.location.highway
                ? ` · ${row.original.accident.location.highway}`
                : ''}
            </span>
          ),
        }),
        col.display({
          id: 'driver',
          header: 'Driver',
          cell: ({ row }) => (
            <Link
              to="/drivers"
              search={{ driver: row.original.accident.driverId }}
              className="truncate hover:underline"
            >
              {row.original.accident.driverName}
            </Link>
          ),
        }),
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { width: 90 },
          cell: ({ row }) => (
            <Link
              to="/fleet/trucks/$truckId"
              params={{ truckId: row.original.accident.truckId }}
              className="hover:underline"
            >
              {row.original.accident.unitNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'kind',
          header: 'Type',
          meta: { width: 130 },
          cell: ({ row }) => ACCIDENT_KIND_LABEL[row.original.accident.kind],
        }),
        col.display({
          id: 'severity',
          header: 'Severity',
          meta: { width: 100 },
          cell: ({ row }) => (
            <Badge tone={ACCIDENT_SEVERITY_TONE[row.original.accident.severity]}>
              {ACCIDENT_SEVERITY_LABEL[row.original.accident.severity]}
            </Badge>
          ),
        }),
        col.display({
          id: 'injury',
          header: 'Injury',
          meta: { width: 90 },
          cell: ({ row }) => {
            const { injuries, fatalities } = row.original.accident;
            if (fatalities > 0) {
              return <span className="font-medium text-danger-text">{fatalities} fatal</span>;
            }
            if (injuries.length === 0) return <span className="text-faint">None</span>;
            return <span className="text-warning-text">{injuries.length}</span>;
          },
        }),
        col.display({
          id: 'preventable',
          header: 'Preventability',
          meta: { width: 140 },
          cell: ({ row }) => (
            <Badge
              tone={PREVENTABILITY_TONE[row.original.accident.preventable] ?? 'neutral'}
              title={
                row.original.accident.preventabilityDecidedBy
                  ? `Decided by ${row.original.accident.preventabilityDecidedBy}`
                  : 'Nobody has decided this yet'
              }
            >
              {PREVENTABILITY_LABEL[row.original.accident.preventable]}
            </Badge>
          ),
        }),
        col.display({
          id: 'dot',
          header: 'DOT',
          meta: { width: 110 },
          cell: ({ row }) =>
            row.original.accident.dotRecordable ? (
              <Badge tone="danger" title={row.original.recordability.reasons.join('. ')}>
                Recordable
              </Badge>
            ) : (
              <span className="text-faint" title={row.original.recordability.reasons.join('. ')}>
                Not recordable
              </span>
            ),
        }),
        col.display({
          id: 'claim',
          header: 'Claim',
          meta: { width: 130 },
          cell: ({ row }) =>
            row.original.claim ? (
              <Link
                to="/safety/claims/$claimId"
                params={{ claimId: row.original.claim.id }}
                title={`${row.original.claim.insurer} · ${row.original.claim.status}`}
                className="text-primary-text hover:underline"
                // The row is a selection target; opening the claim is not selecting the accident.
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {row.original.claim.claimNumber}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'damage',
          header: 'Damage',
          meta: { align: 'right', width: 110 },
          cell: ({ row }) =>
            row.original.totalDamage === null ? (
              <span className="text-faint" title="Nothing has been assessed yet.">
                {DASH}
              </span>
            ) : (
              formatMoney(row.original.totalDamage, { compact: true })
            ),
        }),
        col.display({
          id: 'owner',
          header: 'Owner',
          cell: ({ row }) =>
            row.original.accident.ownerName ?? (
              <span className="font-medium text-warning-text">Unassigned</span>
            ),
        }),
        col.display({
          id: 'daysOpen',
          header: 'Days open',
          meta: { align: 'right', width: 100 },
          cell: ({ row }) =>
            row.original.review.open ? (
              <span
                className={cn(row.original.review.daysOpen > 60 && 'font-medium text-warning-text')}
              >
                {formatNumber(row.original.review.daysOpen)}
              </span>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 150 },
          cell: ({ row }) => <StatusBadge status={row.original.accident.status} />,
        }),
      ]),
    [],
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Accidents"
        description="Track accidents, investigations, injuries, damages, insurance exposure and corrective actions."
      />

      {bundle ? (
        <SafetyExceptionPanel
          items={bundle.exceptions.items.filter((item) => item.target.to === '/safety/accidents')}
          unavailable={bundle.exceptions.unavailable}
          onSelect={(item) =>
            updateSearch({
              status: undefined,
              preventable: undefined,
              owner: undefined,
              evidence: undefined,
              ...item.target.search,
              ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      <SafetySummaryStrip
        segments={segments}
        activeKey={
          search.preventable === 'yes'
            ? '__preventable'
            : search.preventable === 'undetermined'
              ? '__undetermined'
              : search.injury === 'yes'
                ? '__injury'
                : (search.status ?? (search.ids ? null : '__total'))
        }
        loading={safetyQuery.isPending}
      />

      {search.ids ? (
        <p className="text-sm text-secondary">
          Showing the {parseIds(search.ids).length} accidents behind one finding.{' '}
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
        rowKey={(row) => row.accident.id}
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
        emptyTitle="No accidents reported"
        emptyDescription="An accident file holds what happened, who was involved, what it cost, what the investigation concluded and what changed afterwards."
        emptyAction={
          <Button icon={<Plus />} onClick={() => void navigate({ to: '/safety/accidents/new' })}>
            Report accident
          </Button>
        }
        selectable
        caption="Accidents"
        onRowClick={(row) =>
          setRowSelection((current) => {
            const next = { ...current };
            if (next[row.accident.id]) delete next[row.accident.id];
            else next[row.accident.id] = true;
            return next;
          })
        }
        onRowDoubleClick={open}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search accident, driver, unit, location…',
            }}
            filters={filters}
            values={{
              status: search.status,
              severity: search.severity,
              kind: search.kind,
              driver: search.driver,
              unit: search.unit,
              preventable: search.preventable,
              injury: search.injury,
              owner: search.owner,
              claim: search.claim,
              recordable: search.recordable,
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
                status: undefined,
                severity: undefined,
                kind: undefined,
                driver: undefined,
                unit: undefined,
                preventable: undefined,
                injury: undefined,
                owner: undefined,
                claim: undefined,
                evidence: undefined,
                recordable: undefined,
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
                onClick={() => void navigate({ to: '/safety/accidents/new' })}
              >
                Report accident
              </Button>
            </span>
          </FilterBar>
        }
        rowActions={(row) => (
          <>
            <MenuItem icon={<ExternalLink />} onSelect={() => open(row)}>
              Open file
            </MenuItem>
            {row.accident.status === 'reported' || row.accident.status === 'under_review' ? (
              <MenuItem icon={<Search />} onSelect={() => beginInvestigation.mutate(row)}>
                Start investigation
              </MenuItem>
            ) : null}
            {!row.accident.ownerId ? (
              <MenuItem icon={<UserPlus />} onSelect={() => open(row)}>
                Assign an investigator
              </MenuItem>
            ) : null}
            {!row.accident.claimId ? (
              <MenuItem icon={<ShieldAlert />} onSelect={() => setClaiming(row)}>
                Create claim
              </MenuItem>
            ) : null}
            {row.review.missingEvidence.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem icon={<FileWarning />} onSelect={() => open(row)}>
                  {row.review.missingEvidence.length} document
                  {row.review.missingEvidence.length === 1 ? '' : 's'} missing
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      />

      {claiming ? (
        <CreateClaimDialog
          open
          onOpenChange={(next) => {
            if (!next) setClaiming(null);
          }}
          accident={claiming}
          onDone={() => setClaiming(null)}
        />
      ) : null}
    </div>
  );
}

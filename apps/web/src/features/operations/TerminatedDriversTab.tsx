import { ChevronLeft, ListFilter, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  createColumns,
} from '@/design-system';
import { TERMINATION_REASON_LABEL, listTerminations, type TerminationRecord } from '@/demo';
import { formatIsoDate, formatMoney, formatNumber } from '@/lib/format';

const col = createColumns<TerminationRecord>();

type RehireFilter = '' | 'eligible' | 'ineligible';

export interface TerminatedDriversTabProps {
  /** Returns to the working roster; the empty state offers it because there is nothing else to do here. */
  onBackToRoster?: () => void;
}

/**
 * Everyone who has left, and how it was settled.
 *
 * The register exists because a termination has a tail: property that never came back, an accident
 * still open, escrow owed in one direction or the other. A driver who simply vanishes from the
 * roster takes all of that with them.
 */
export function TerminatedDriversTab({ onBackToRoster }: TerminatedDriversTabProps) {
  const [search, setSearch] = useState('');
  const [rehire, setRehire] = useState<RehireFilter>('');
  const rows = useMemo(() => listTerminations(), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((row) =>
        rehire === '' ? true : rehire === 'eligible' ? row.rehireEligible : !row.rehireEligible,
      )
      .filter((row) =>
        q
          ? [row.driverName, row.driverNumber, TERMINATION_REASON_LABEL[row.reason], row.reasonNote]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(q))
          : true,
      );
  }, [rows, search, rehire]);

  const columns = col.columns([
    col.display({
      id: 'driver',
      header: 'Driver',
      meta: { primary: true, width: 200 },
      cell: ({ row }) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium text-ink">{row.original.driverName}</span>
          <span className="text-xs font-normal text-muted">{row.original.driverNumber}</span>
        </span>
      ),
    }),
    col.display({
      id: 'left',
      header: 'Last day',
      meta: { width: 110 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-secondary">
          {formatIsoDate(row.original.effectiveOn)}
        </span>
      ),
    }),
    col.display({
      id: 'reason',
      header: 'Reason',
      meta: { width: 230 },
      cell: ({ row }) => (
        <span className="flex flex-col leading-tight">
          <span className="text-ink">{TERMINATION_REASON_LABEL[row.original.reason]}</span>
          {row.original.reasonNote ? (
            <span className="line-clamp-2 text-xs text-muted">{row.original.reasonNote}</span>
          ) : null}
        </span>
      ),
    }),
    col.display({
      id: 'rehire',
      header: 'Rehire eligibility',
      meta: { width: 140 },
      cell: ({ row }) =>
        row.original.rehireEligible ? (
          <Badge tone="success" dot>
            Eligible
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Do not rehire
          </Badge>
        ),
    }),
    col.display({
      id: 'equipment',
      header: 'Property not returned',
      meta: { width: 240 },
      cell: ({ row }) => {
        const missing = row.original.equipment.filter((item) => !item.returned);
        if (missing.length === 0) return <span className="text-success-text">All returned</span>;
        return (
          <span className="flex flex-col leading-tight">
            <span className="line-clamp-2 text-secondary">
              {missing.map((item) => item.label).join(', ')}
            </span>
            <span className="tabular text-xs text-danger-text">
              {formatMoney(row.original.equipmentCharge)}
            </span>
          </span>
        );
      },
    }),
    col.display({
      id: 'accident',
      header: 'Accident',
      meta: { width: 130 },
      cell: ({ row }) =>
        row.original.accident ? (
          <span className="flex flex-col items-start gap-0.5">
            <Badge tone="danger" dot>
              Yes
            </Badge>
            {row.original.accidentCharge > 0 ? (
              <span className="tabular text-xs text-muted">
                {formatMoney(row.original.accidentCharge)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-faint">No</span>
        ),
    }),
    col.display({
      id: 'escrow',
      header: 'Escrow',
      meta: { width: 210 },
      cell: ({ row }) => (
        <span className="flex flex-col leading-tight">
          <span className="tabular text-secondary">
            {formatMoney(row.original.escrowApplied)} taken of{' '}
            {formatMoney(row.original.escrowHeld)}
          </span>
          {row.original.escrowRefund > 0 ? (
            <span className="tabular text-xs text-success-text">
              {formatMoney(row.original.escrowRefund)} owed back
            </span>
          ) : null}
          {row.original.shortfall > 0 ? (
            <span className="tabular text-xs text-danger-text">
              {formatMoney(row.original.shortfall)} to final settlement
            </span>
          ) : null}
        </span>
      ),
    }),
  ]);

  const rehireSelect = (
    <Select
      size="sm"
      aria-label="Rehire eligibility"
      options={[
        { value: '', label: 'Any rehire eligibility' },
        { value: 'eligible', label: 'Eligible' },
        { value: 'ineligible', label: 'Do not rehire' },
      ]}
      value={rehire}
      onValueChange={(value) => setRehire(value as RehireFilter)}
    />
  );

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line-soft bg-surface">
      <DataTable
        data={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        stickyHeader
        className="rounded-none border-0 shadow-none"
        caption="Drivers who have left, with what was settled on the way out"
        empty={
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-full bg-neutral-soft text-neutral-text [&_svg]:size-6"
            >
              <UserX />
            </span>
            <h3 className="mt-4 text-md font-bold text-ink">No terminated drivers</h3>
            <p className="mt-1 max-w-sm text-sm text-muted">
              Termination details, returned property and escrow settlements will appear here.
            </p>
            {onBackToRoster ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<ChevronLeft />}
                className="mt-4"
                onClick={onBackToRoster}
              >
                Back to roster
              </Button>
            ) : null}
          </div>
        }
        toolbar={
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: 'Search name, driver number or reason',
            }}
            values={{}}
            onChange={() => {}}
            onClear={() => setSearch('')}
          >
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="secondary" size="sm" icon={<ListFilter />}>
                  Filters{rehire ? ' · 1' : ''}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="flex w-64 flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Rehire eligibility
                  {rehireSelect}
                </label>
                {rehire ? (
                  <Button variant="ghost" size="sm" onClick={() => setRehire('')}>
                    Clear filters
                  </Button>
                ) : null}
              </PopoverContent>
            </Popover>
          </FilterBar>
        }
      />
      {/* The table hides its own footer with no rows; the register still states its size. */}
      {filtered.length === 0 ? (
        <p className="border-t border-line-soft px-3 py-2 text-xs text-muted tabular">
          {formatNumber(filtered.length)} records
        </p>
      ) : null}
    </div>
  );
}

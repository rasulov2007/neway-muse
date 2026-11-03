import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Badge, DataTable, FilterBar, createColumns, getStatus } from '@/design-system';
import { UNIT_EXIT_REASON_LABEL, exposureOf, listUnitExits, type UnitExitRecord } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { exitReasonTone } from './unit-status-look';

const col = createColumns<UnitExitRecord>();

/**
 * Every unit that has left the road, and what it cost.
 *
 * The account lives on each unit's own page, where the question is usually asked. This is the
 * other view of the same records: what the fleet has lost this year, in one list an accountant or
 * an insurer can read straight down.
 */
export function UnitExitsTab() {
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const rows = useMemo(() => listUnitExits(), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [
        row.unitNumber,
        UNIT_EXIT_REASON_LABEL[row.reason],
        row.narrative,
        row.buyer,
        row.insuranceClaimNumber,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const columns = col.columns([
    col.display({
      id: 'unit',
      header: 'Unit',
      meta: { primary: true, width: 130 },
      cell: ({ row }) => (
        <span className="flex flex-col leading-tight">
          <span className="font-semibold text-nw-accent-ink">{row.original.unitNumber}</span>
          <span className="text-xs text-muted">
            {row.original.entity === 'truck' ? 'Truck' : 'Trailer'}
          </span>
        </span>
      ),
    }),
    col.display({
      id: 'when',
      header: 'Date',
      meta: { width: 110 },
      cell: ({ row }) =>
        row.original.redacted || !row.original.occurredOn ? null : (
          <span className="whitespace-nowrap text-secondary">
            {formatIsoDate(row.original.occurredOn)}
          </span>
        ),
    }),
    col.display({
      id: 'reason',
      header: 'Reason',
      meta: { width: 150 },
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={exitReasonTone(row.original.reason)} size="sm" dot>
            {UNIT_EXIT_REASON_LABEL[row.original.reason]}
          </Badge>
          <span className="text-xs text-muted">{getStatus(row.original.toStatus).label}</span>
        </span>
      ),
    }),
    col.display({
      id: 'account',
      header: 'Account',
      meta: { width: 420 },
      // A long account wraps to two lines and the rest is a hover away, so one police report
      // cannot push every other column off the screen.
      cell: ({ row }) =>
        row.original.redacted ? (
          <span className="text-muted">Restricted</span>
        ) : (
          <span
            title={row.original.narrative}
            className="line-clamp-2 max-w-[420px] whitespace-normal break-words leading-snug text-secondary"
          >
            {row.original.narrative}
          </span>
        ),
    }),
    col.display({
      id: 'contents',
      header: 'In it / broken',
      meta: { width: 220 },
      cell: ({ row }) => {
        if (row.original.redacted) return null;
        const missing = row.original.contents.filter((item) => !item.recovered);
        const parts = row.original.damage;
        if (missing.length === 0 && parts.length === 0) {
          return <span className="text-faint">—</span>;
        }
        return (
          <span className="flex flex-col text-xs">
            {missing.length > 0 ? (
              <span className="text-danger-text">
                {missing.map((item) => item.label).join(', ')}
              </span>
            ) : null}
            {parts.length > 0 ? (
              <span className="text-secondary">{parts.map((item) => item.part).join(', ')}</span>
            ) : null}
          </span>
        );
      },
    }),
    col.display({
      id: 'money',
      header: 'Money',
      meta: { width: 200 },
      cell: ({ row }) => {
        const record = row.original;
        // A stolen unit, for someone without the administrator role: no money is shown.
        if (record.redacted) return null;
        const exposure = exposureOf(record);
        return (
          <span className="flex flex-col text-xs">
            {record.salePrice !== null ? (
              <span className="tabular text-success-text">
                Sold {formatMoney(record.salePrice)}
              </span>
            ) : null}
            {record.insuranceClaimNumber ? (
              <span className="text-secondary">Claim {record.insuranceClaimNumber}</span>
            ) : null}
            <span className={exposure > 0 ? 'tabular text-danger-text' : 'tabular text-muted'}>
              {exposure > 0 ? `${formatMoney(exposure)} exposed` : 'No exposure recorded'}
            </span>
          </span>
        );
      },
    }),
    col.display({
      id: 'by',
      header: 'Recorded by',
      meta: { width: 160 },
      cell: ({ row }) =>
        row.original.redacted ? null : (
          <span className="flex flex-col text-xs">
            <span className="text-secondary">{row.original.recordedByName}</span>
            {row.original.driverName ? (
              <span className="text-muted">driver {row.original.driverName}</span>
            ) : null}
          </span>
        ),
    }),
  ]);

  return (
    <DataTable
      data={filtered}
      columns={columns}
      rowKey={(row) => row.id}
      stickyHeader
      onRowClick={(row) =>
        void navigate(
          row.entity === 'truck'
            ? { to: '/fleet/trucks/$truckId', params: { truckId: row.unitId } }
            : { to: '/fleet/trailers/$trailerId', params: { trailerId: row.unitId } },
        )
      }
      caption="Units that have left the road, with the account of why"
      emptyTitle="Nothing has left the road"
      emptyDescription="When a unit is taken out of service or made inactive, the reason, what was in it, what broke and what it cost are recorded here."
      toolbar={
        <FilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: 'Search unit, reason or claim',
          }}
          values={{}}
          onChange={() => {}}
          onClear={() => setSearch('')}
        />
      }
    />
  );
}

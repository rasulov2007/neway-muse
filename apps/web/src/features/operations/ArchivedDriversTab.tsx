import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ChevronLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Button,
  DataTable,
  FilterBar,
  StatusBadge,
  createColumns,
  useToast,
} from '@/design-system';
import { restoreDriverRecord, type Driver } from '@/demo';
import { formatDate } from '@/lib/format';
import { DASH } from './operations-ui';
import { useHasPermission } from './usePermissions';

const col = createColumns<Driver>();

export interface ArchivedDriversTabProps {
  drivers: Driver[];
  onBackToRoster?: () => void;
}

/**
 * Drivers taken off the roster without being terminated (owner, 2026-10-02): hidden from the
 * Drivers list, every picker and both dispatch boards, kept whole, and brought back with Restore.
 * Restore puts the driver file and the board row the archive took off back together; the archive
 * time shown is the version check, so a driver somebody else already restored is not restored twice.
 */
export function ArchivedDriversTab({ drivers, onBackToRoster }: ArchivedDriversTabProps) {
  const [search, setSearch] = useState('');
  const canRestore = useHasPermission('drivers.edit');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const restore = useMutation({
    mutationFn: (driver: Driver) => restoreDriverRecord(driver.id, driver.archivedAt ?? ''),
    onSuccess: async (_updated, driver) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
        queryClient.invalidateQueries({ queryKey: ['dispatch-board'] }),
      ]);
      toast({ tone: 'success', title: `${driver.name} is back on the roster`, description: 'And on the dispatch boards from this week.' });
    },
    onError: (err: unknown, driver) =>
      toast({ tone: 'danger', title: `${driver.name} could not be restored`, description: err instanceof Error ? err.message : String(err) }),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...drivers]
      .filter((d) => !q || [d.name, d.driverNumber, d.currentTruckUnit, d.archivedReason].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [drivers, search]);

  const columns = col.columns([
    col.display({
      id: 'driver',
      header: 'Driver',
      meta: { primary: true, width: 220 },
      cell: ({ row }) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium text-ink">{row.original.name}</span>
          <span className="text-xs font-normal text-muted">{row.original.driverNumber}</span>
        </span>
      ),
    }),
    col.display({
      id: 'status',
      header: 'Status when archived',
      meta: { width: 170 },
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
    col.display({
      id: 'unit',
      header: 'Unit',
      meta: { width: 90 },
      cell: ({ row }) => row.original.currentTruckUnit ?? <span className="text-faint">{DASH}</span>,
    }),
    col.display({
      id: 'archived',
      header: 'Archived',
      meta: { width: 130 },
      cell: ({ row }) => <span className="whitespace-nowrap text-secondary">{row.original.archivedAt ? formatDate(row.original.archivedAt) : DASH}</span>,
    }),
    col.display({
      id: 'reason',
      header: 'Reason',
      cell: ({ row }) => <span className="text-secondary">{row.original.archivedReason ?? DASH}</span>,
    }),
    col.display({
      id: 'restore',
      header: '',
      meta: { align: 'right', width: 120 },
      cell: ({ row }) =>
        canRestore ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<ArchiveRestore />}
            loading={restore.isPending && restore.variables?.id === row.original.id}
            disabled={restore.isPending}
            onClick={(event) => {
              event.stopPropagation();
              restore.mutate(row.original);
            }}
          >
            Restore
          </Button>
        ) : null,
    }),
  ]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      rowKey={(row) => row.id}
      stickyHeader
      caption="Archived drivers: hidden from the roster, the pickers and the dispatch boards, and restorable"
      emptyTitle={drivers.length === 0 ? 'No archived drivers' : 'No archived drivers match'}
      emptyDescription={drivers.length === 0 ? 'Drivers taken off the roster without a termination are listed here.' : 'Widen the search.'}
      emptyAction={
        drivers.length === 0 && onBackToRoster ? (
          <Button variant="secondary" size="sm" icon={<ChevronLeft />} onClick={onBackToRoster}>
            Back to the roster
          </Button>
        ) : undefined
      }
      toolbar={
        <FilterBar
          search={{ value: search, onChange: setSearch, placeholder: 'Search driver, driver #, unit or reason' }}
          values={{}}
          onChange={() => {}}
          onClear={() => setSearch('')}
        />
      }
    />
  );
}

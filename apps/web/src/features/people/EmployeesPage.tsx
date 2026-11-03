import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ChevronDown, Download, EllipsisVertical, Headset, Plus, UserRound } from 'lucide-react';
import {
  COMMON_POSITIONS,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  safeCell,
  type EmployeeRecord,
} from '@neway/shared';
import {
  Alert,
  Avatar,
  Button,
  IconButton,
  DataTable,
  DropdownMenu,
  EmptyState,
  FilterBar,
  MenuItem,
  PageHeader,
  StatusBadge,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { useHasPermission } from '@/features/operations/usePermissions';
import { formatIsoDate } from '@/lib/format';
import {
  EmployeeStatusBadge,
  EmployeeSummaryStrip,
  type SummarySegment,
} from './components/EmployeeKit';
import { departmentLabel, employmentTypeLabel } from './employee-labels';
import { employeesSearchSchema } from './employees-search';
import { CreateEmployeeDialog, type CreateEmployeePreset } from './CreateEmployeeDialog';
import {
  employeesPageScope,
  fetchAllEmployees,
  useEmployees,
  useWorkforceSummary,
} from './useEmployees';

const col = createColumns<EmployeeRecord>();

/** Column id â†’ the field name the API sorts on. Only sortable columns appear. */
const SORT_FIELD_BY_COLUMN: Record<string, string> = {
  employee: 'name',
  employeeNumber: 'employeeNumber',
  department: 'department',
  position: 'position',
  status: 'status',
  hireDate: 'hireDate',
};

/** The "Not yet filled" word: symbol + word, never colour alone. */
function ProfileStateBadge({ state }: { state: EmployeeRecord['profileState'] }) {
  if (state === 'asked') return <StatusBadge status="pending" label="Asked to complete profile" />;
  if (state === 'no_account') return <StatusBadge status="not_started" label="No account" />;
  return <span className="text-faint">â€”</span>;
}

function csvCell(value: string | number | null | undefined): string {
  const text = String(safeCell(value ?? ''));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadEmployeesCsv(rows: EmployeeRecord[], view: 'complete' | 'incomplete'): void {
  const header = ['Name', 'Employee #', 'Role', 'Department', 'Employment', 'Location', 'Status', 'Hire date', 'Work email', 'Phone'];
  if (view === 'incomplete') header.push('Profile');
  const lines = [header.map(csvCell).join(',')];
  for (const e of rows) {
    const cells: (string | null)[] = [
      e.name,
      e.employeeNumber,
      e.position,
      departmentLabel(e.department),
      employmentTypeLabel(e.employmentType),
      e.location,
      e.status,
      e.hireDate,
      e.workEmail,
      e.phone,
    ];
    if (view === 'incomplete') {
      cells.push(
        e.profileState === 'asked' ? 'Asked to complete profile' : e.profileState === 'no_account' ? 'No account' : '',
      );
    }
    lines.push(cells.map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = view === 'incomplete' ? 'employees_not_yet_filled.csv' : 'employees.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The workforce.
 *
 * Owner, 2026-10-26: only people who filled in Complete your profile are employees here; the rest
 * sit behind "Not yet filled" until they do, and drivers are on the Drivers page. Display only â€”
 * the placeholder rows still serve the dispatcher pickers, team names and commission splits.
 *
 * Paging, filtering and sorting happen on the server. The summary strip along the top is not
 * decoration: each segment is the filter that produced its own count, so clicking one narrows the
 * list to exactly the rows behind the number.
 */
export function EmployeesPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => employeesSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Both hooks run every render; `||` between two hook calls would skip the second one.
  const mayCreate = useHasPermission('employees.create');
  const mayEdit = useHasPermission('employees.edit');
  const canCreate = mayCreate || mayEdit;
  // Create employee / dispatcher opens over this page: the list, its filters and the scroll stay put.
  const [creating, setCreating] = useState<CreateEmployeePreset | null>(null);

  const scope = employeesPageScope(search);
  const incompleteView = scope === 'profile_incomplete';
  const query = useEmployees(search, scope);
  const summary = useWorkforceSummary(search, scope);
  const [exporting, setExporting] = useState(false);

  async function exportView() {
    setExporting(true);
    try {
      const rows = await fetchAllEmployees(search, scope);
      downloadEmployeesCsv(rows, incompleteView ? 'incomplete' : 'complete');
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setExporting(false);
    }
  }

  function update(patch: Record<string, unknown>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        // Any change to a filter returns to the first page; staying on page 7 of a two-page
        // result is how a list appears empty for no reason.
        if (!('page' in patch)) delete next.page;
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined || value === '' || value === null) delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  const segments: SummarySegment[] = useMemo(() => {
    const data = summary.data;
    const statusCount = (status: string) =>
      data ? (data.byStatus.find((s) => s.status === status)?.count ?? 0) : null;
    return [
      {
        key: 'all',
        label: 'Total employees',
        count: data?.total ?? null,
        onSelect: () => update({ status: undefined }),
      },
      {
        key: 'active',
        label: 'Active',
        count: statusCount('active'),
        tone: 'success',
        onSelect: () => update({ status: 'active' }),
      },
      {
        key: 'on_leave',
        label: 'On leave',
        count: statusCount('on_leave'),
        tone: 'warning',
        onSelect: () => update({ status: 'on_leave' }),
      },
      {
        key: 'suspended',
        label: 'Suspended',
        count: statusCount('suspended'),
        tone: 'warning',
        onSelect: () => update({ status: 'suspended' }),
      },
      {
        key: 'terminated',
        label: 'Terminated',
        count: statusCount('terminated'),
        tone: 'danger',
        onSelect: () => update({ status: 'terminated', includeInactive: '1' }),
      },
    ];
  }, [summary.data]);

  const activeSegment = search.status ?? 'all';

  const locations = useMemo(() => {
    const found = new Set((query.data?.data ?? []).map((e) => e.location).filter(Boolean));
    return [...found].sort();
  }, [query.data]);

  const filters: FilterDefinition[] = [
    {
      key: 'department',
      label: 'Department',
      type: 'select',
      options: EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] })),
    },
    {
      key: 'position',
      label: 'Position',
      type: 'select',
      // Drivers are not on this page, so the position filter does not offer them either.
      options: COMMON_POSITIONS.filter((p) => p !== 'Driver').map((p) => ({ value: p, label: p })),
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: EMPLOYEE_STATUSES.map((s) => ({
        value: s,
        label: s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      })),
    },
    {
      key: 'employmentType',
      label: 'Employment type',
      type: 'select',
      options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: employmentTypeLabel(t) })),
    },
    // Only offered when the rows on file actually carry a location; an empty filter is worse than
    // no filter.
    ...(locations.length > 0
      ? [
          {
            key: 'location',
            label: 'Location',
            type: 'select' as const,
            options: locations.map((l) => ({ value: l as string, label: l as string })),
          },
        ]
      : []),
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: 'Employee',
          meta: { primary: true, width: 260 },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <Avatar name={row.original.name} size="md" />
              <span className="min-w-0">
                <Link
                  to="/hr/employees/$employeeId"
                  params={{ employeeId: row.original.id }}
                  className="block truncate font-semibold text-ink hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.original.name}
                </Link>
                <span className="block text-xs text-muted">{row.original.employeeNumber}</span>
              </span>
            </span>
          ),
        }),
        col.accessor('position', { header: 'Role', meta: { width: 150 } }),
        col.display({
          id: 'department',
          header: 'Department',
          meta: { width: 170 },
          cell: ({ row }) => departmentLabel(row.original.department),
        }),
        col.display({
          id: 'employmentType',
          header: 'Employment',
          meta: { width: 120 },
          cell: ({ row }) => employmentTypeLabel(row.original.employmentType),
        }),
        col.display({
          id: 'location',
          header: 'Location',
          meta: { width: 150 },
          cell: ({ row }) => row.original.location ?? <span className="text-faint">â€”</span>,
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 110 },
          cell: ({ row }) => <EmployeeStatusBadge status={row.original.status} />,
        }),
        col.accessor('hireDate', {
          header: 'Hire date',
          meta: { width: 120 },
          cell: ({ getValue }) => formatIsoDate(getValue()),
        }),
        ...(incompleteView
          ? [
              col.display({
                id: 'profile',
                header: 'Profile',
                meta: { width: 210 },
                cell: ({ row }) => <ProfileStateBadge state={row.original.profileState} />,
              }),
            ]
          : []),
        col.display({
          id: 'actions',
          header: 'Actions',
          meta: { width: 170 },
          cell: ({ row }) => (
            <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <Button variant="secondary" size="sm" asChild>
                <Link to="/hr/employees/$employeeId" params={{ employeeId: row.original.id }}>
                  View profile
                </Link>
              </Button>
              <DropdownMenu
                trigger={
                  <IconButton label={`More for ${row.original.name}`} size="sm" variant="secondary">
                    <EllipsisVertical />
                  </IconButton>
                }
              >
                <MenuItem
                  onSelect={() =>
                    void navigate({
                      to: '/hr/employees/$employeeId',
                      params: { employeeId: row.original.id },
                    })
                  }
                >
                  Open profile
                </MenuItem>
                {row.original.driverId ? (
                  <MenuItem
                    onSelect={() =>
                      void navigate({
                        to: '/drivers/$driverId',
                        params: { driverId: row.original.driverId as string },
                      })
                    }
                  >
                    Open driver profile
                  </MenuItem>
                ) : null}
              </DropdownMenu>
            </span>
          ),
        }),
      ]),
    [navigate, incompleteView],
  );

  const page = query.data;
  const tableState: DataTableState = {
    sorting: [
      {
        id:
          Object.entries(SORT_FIELD_BY_COLUMN).find(
            ([, field]) => field === (search.sort ?? 'name'),
          )?.[0] ?? 'employee',
        desc: search.sortDir === 'desc',
      },
    ],
    pagination: { page: search.page ?? 1, pageSize: search.pageSize ?? 25 },
    rowSelection: {},
    columnVisibility: {},
    globalFilter: '',
  };

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Employees"
        description="Manage your team, roles and employee records."
        actions={
          <span className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Download />}
              disabled={exporting}
              onClick={() => void exportView()}
            >
              {exporting ? 'Exportingâ€¦' : 'Export'}
            </Button>
            {canCreate ? (
              <span className="flex items-center">
                <Button
                  variant="primary"
                  icon={<Plus />}
                  className="rounded-r-none"
                  onClick={() => setCreating('employee')}
                >
                  Add employee
                </Button>
                <DropdownMenu
                  trigger={
                    <Button
                      variant="primary"
                      className="rounded-l-none border-l border-nw-on-accent/30 px-2"
                      aria-label="More ways to add"
                    >
                      <ChevronDown />
                    </Button>
                  }
                >
                  <MenuItem icon={<Headset />} onSelect={() => setCreating('dispatcher')}>
                    Add dispatcher
                  </MenuItem>
                  <MenuItem
                    icon={<UserRound />}
                    onSelect={() => void navigate({ to: '/hr/employees/new' })}
                  >
                    Full employee form
                  </MenuItem>
                </DropdownMenu>
              </span>
            ) : null}
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span role="group" aria-label="Which employees" className="flex items-center gap-1">
          {(
            [
              { key: 'complete', label: 'Profile complete', count: summary.data?.profileViews?.complete },
              { key: 'incomplete', label: 'Not yet filled', count: summary.data?.profileViews?.incomplete },
            ] as const
          ).map((option, index) => {
            const active = (option.key === 'incomplete') === incompleteView;
            return (
              <span key={option.key} className="flex items-center gap-1">
                {index > 0 ? <span className="text-faint" aria-hidden="true">Â·</span> : null}
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ view: option.key === 'incomplete' ? 'incomplete' : undefined })}
                  className={
                    active
                      ? 'rounded-md px-1.5 py-0.5 font-semibold text-ink'
                      : 'rounded-md px-1.5 py-0.5 text-muted hover:text-ink hover:underline'
                  }
                >
                  {option.label} ({option.count === undefined ? 'â€¦' : option.count})
                </button>
              </span>
            );
          })}
        </span>
        <span className="text-muted">
          Drivers are on the{' '}
          <Link to="/drivers" className="font-medium text-primary-text hover:underline">
            Drivers page
          </Link>
          .
        </span>
      </div>

      <EmployeeSummaryStrip
        segments={segments}
        activeKey={activeSegment}
        loading={summary.isPending}
      />

      {query.error ? (
        <Alert
          tone="danger"
          title="The workforce could not be loaded"
          description={query.error instanceof Error ? query.error.message : 'Unknown error'}
        />
      ) : null}

      <DataTable
        columns={columns}
        data={page?.data ?? []}
        rowKey={(employee) => employee.id}
        caption="Employees"
        loading={query.isPending}
        error={query.error ?? undefined}
        onRetry={() => void query.refetch()}
        serverSide
        total={page?.total ?? 0}
        state={tableState}
        onStateChange={(next) => {
          const sort = next.sorting?.[0];
          // The column that shows the person is called `employee`; the field the server sorts on
          // is `name`. Sending the column id would silently sort by nothing.
          if (next.sorting) {
            const field = sort ? (SORT_FIELD_BY_COLUMN[sort.id] ?? sort.id) : undefined;
            update({ sort: field, sortDir: sort?.desc ? 'desc' : 'asc' });
          }
          if (next.pagination) {
            update({ page: next.pagination.page, pageSize: next.pagination.pageSize });
          }
        }}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => update({ q: value || undefined }),
              placeholder: 'Search name, ID or email',
            }}
            filters={filters}
            values={{
              status: search.status,
              department: search.department,
              position: search.position,
              employmentType: search.employmentType,
              location: search.location,
            }}
            onChange={(key, value) => update({ [key]: value })}
            onClear={() =>
              void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
            }
          ></FilterBar>
        }
        // Single click selects, double click opens â€” the same contract as every other list here.
        onRowDoubleClick={(employee) =>
          void navigate({
            to: '/hr/employees/$employeeId',
            params: { employeeId: employee.id },
          })
        }
        empty={
          search.q || search.status || search.department ? (
            <EmptyState
              icon={<UserRound />}
              title="No employees match these filters"
              description="Try a different search, or clear the filters to see the whole workforce."
              action={
                <Button
                  variant="secondary"
                  onClick={() =>
                    void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
                  }
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<UserRound />}
              title="No employees yet"
              description="Create your first employee to start building your workforce."
              action={
                canCreate ? (
                  <Button icon={<Plus />} onClick={() => setCreating('employee')}>
                    Add employee
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
      <CreateEmployeeDialog
        open={creating !== null}
        preset={creating ?? 'employee'}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
      />
    </div>
  );
}

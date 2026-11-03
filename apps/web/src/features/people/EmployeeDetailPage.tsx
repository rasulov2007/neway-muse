import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IdCard, PauseCircle, PlayCircle, Shuffle, UserMinus } from 'lucide-react';
import {
  employeeAttention,
  employeeTransitions,
  PAY_TYPE_LABELS,
  type EmployeeRecord,
  type EmployeeStatus,
} from '@neway/shared';
import {
  BackButton,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  cn,
} from '@/design-system';
import { useHasPermission } from '@/features/operations/usePermissions';
import { formatIsoDate } from '@/lib/format';
import {
  EmployeeFactList,
  EmployeePanel,
  EmployeeStatusBadge,
  NeedsAttentionPanel,
} from './components/EmployeeKit';
import {
  ChangeStatusModal,
  ReassignModal,
  SetCompensationModal,
} from './components/EmployeeDialogs';
import {
  EmployeeAttendanceTab,
  EmployeeOnboardingTab,
  EmployeePerformanceTab,
  EmployeePtoTab,
  EmployeeRecruitingTab,
} from '@/features/hr/components/EmployeeHrTabs';
import { departmentLabel, employmentTypeLabel } from './employee-labels';
import { employeesSearchSchema } from './employees-search';
import { TERMINATION_REASON_LABEL, fetchDriverAccount } from '@/demo';

/** The termination checkout, given the escrow balance the one driver account reports. */
function TerminateDriverForEmployee(props: Omit<React.ComponentProps<typeof TerminateDriverDialog>, 'escrowHeldCents'>) {
  const account = useQuery({ queryKey: ['accounting', 'driver-account', props.driverId], queryFn: () => fetchDriverAccount(props.driverId) });
  if (account.isPending) return null;
  return <TerminateDriverDialog {...props} escrowHeldCents={account.data?.escrow.balanceCents ?? 0} />;
}
import { TerminateDriverDialog } from '@/features/operations/TerminateDriverDialog';
import {
  useChangeEmployeeStatus,
  useCompensationHistory,
  useDirectReports,
  useEmployee,
  useEmployeeActivity,
  useEmploymentHistory,
} from './useEmployees';

export function EmployeeDetailRoute() {
  const { employeeId } = useParams({ from: '/hr/employees/$employeeId' });
  return <EmployeeDetailPage employeeId={employeeId} />;
}

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'employment', label: 'Employment' },
  { value: 'organization', label: 'Role & organization' },
  { value: 'documents', label: 'Documents' },
  { value: 'compensation', label: 'Compensation' },
  { value: 'payroll', label: 'Payroll' },
  { value: 'safety', label: 'Safety' },
  { value: 'operations', label: 'Operations' },
  { value: 'activity', label: 'Activity' },
  { value: 'recruiting', label: 'Recruiting' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'pto', label: 'PTO' },
  { value: 'performance', label: 'Performance' },
];

/**
 * Employee 360.
 *
 * The point of this page is that one person's whole standing is answerable in one place without
 * any of it being copied here. Driver, safety, payroll and documents are all *links into* the
 * modules that own them; this page holds the employment relationship and nothing else. A second
 * copy of a CDL expiry or a pay rate would be a second answer waiting to disagree with the first.
 */
export function EmployeeDetailPage({ employeeId }: { employeeId: string }) {
  const navigate = useNavigate();
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => employeesSearchSchema.parse(raw), [raw]);

  const query = useEmployee(employeeId);
  const employment = useEmploymentHistory(employeeId);
  const compensation = useCompensationHistory(employeeId);
  const reports = useDirectReports(employeeId);
  const activity = useEmployeeActivity(employeeId);

  const canEdit = useHasPermission('employees.edit');
  // Both hooks run every render; `||` between two hook calls would skip the second one.
  const mayViewEmployeePay = useHasPermission('employees.view_financial');
  const mayViewPayroll = useHasPermission('payroll.view');
  const canSeePay = mayViewEmployeePay || mayViewPayroll;

  const [dialog, setDialog] = useState<'reassign' | 'compensation' | null>(null);
  const [statusTo, setStatusTo] = useState<EmployeeStatus | null>(null);
  // Ending the employment record after a driver checkout; the dialog owns the money side.
  const changeStatus = useChangeEmployeeStatus(employeeId);

  const tab = search.tab ?? 'overview';
  const setTab = (value: string) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, tab: value }),
      replace: true,
    });

  if (query.isPending) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.error) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const employee = query.data;
  if (!employee) {
    return (
      <EmptyState
        title="That employee is not on file"
        description="They may have been archived, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/hr/employees' })}>Back to employees</Button>
        }
      />
    );
  }

  const attention = employeeAttention(employee, {
    hasDriverProfile: Boolean(employee.driverId),
    // Compliance and payroll are not consulted from this page: both live in modules that are still
    // session-generated, and reporting their silence as "fine" would be worse than declaring it.
    payrollConsulted: false,
    directReports: reports.data?.length ?? 0,
  });

  const transitions = employeeTransitions(employee.status);

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/hr/employees" />}
        title={employee.name}
        description={`${employee.employeeNumber} · ${employee.position} · ${departmentLabel(employee.department)}`}
        actions={
          canEdit ? (
            <>
              <Button variant="secondary" icon={<Shuffle />} onClick={() => setDialog('reassign')}>
                Change role
              </Button>
              {transitions.includes('suspended') ? (
                <Button
                  variant="secondary"
                  icon={<PauseCircle />}
                  onClick={() => setStatusTo('suspended')}
                >
                  Deactivate
                </Button>
              ) : null}
              {transitions.includes('active') ? (
                <Button
                  variant="secondary"
                  icon={<PlayCircle />}
                  onClick={() => setStatusTo('active')}
                >
                  Activate
                </Button>
              ) : null}
              {transitions.includes('terminated') ? (
                <Button
                  variant="secondary"
                  icon={<UserMinus />}
                  onClick={() => setStatusTo('terminated')}
                >
                  Terminate
                </Button>
              ) : null}
              {transitions.includes('archived') ? (
                <Button variant="secondary" onClick={() => setStatusTo('archived')}>
                  Archive
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <EmployeeStatusBadge status={employee.status} />
        <Badge tone="neutral">{employmentTypeLabel(employee.employmentType)}</Badge>
        {employee.driverId ? (
          <Link
            to="/drivers"
            search={{ driver: employee.driverId } as never}
            className="inline-flex items-center gap-1 text-sm text-primary-text hover:underline"
          >
            <IdCard className="size-3.5" aria-hidden />
            Open driver profile
          </Link>
        ) : null}
        {employee.userId ? (
          <Badge tone="neutral" title={`Signs in as ${employee.userId}`}>
            Has an account
          </Badge>
        ) : (
          <Badge tone="neutral" title="This person cannot sign in">
            No account
          </Badge>
        )}
      </div>

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Employee">
        {/* -------------------------------------------------------------------------- overview */}
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <EmployeePanel title="Who this is">
                <EmployeeFactList
                  facts={[
                    { label: 'Employee ID', value: employee.employeeNumber },
                    { label: 'Position', value: employee.position },
                    { label: 'Department', value: departmentLabel(employee.department) },
                    {
                      label: 'Employment type',
                      value: employmentTypeLabel(employee.employmentType),
                    },
                    { label: 'Status', value: <EmployeeStatusBadge status={employee.status} /> },
                    { label: 'Hired', value: formatIsoDate(employee.hireDate) },
                    ...(employee.terminationDate
                      ? [{ label: 'Terminated', value: formatIsoDate(employee.terminationDate) }]
                      : []),
                    { label: 'Manager', value: employee.managerName },
                    { label: 'Location', value: employee.location },
                    { label: 'Time zone', value: employee.timezone },
                    { label: 'Nickname', value: employee.preferredName },
                    { label: 'Shift time', value: employee.shiftTime ?? null },
                    { label: 'Home address', value: employee.homeAddress ?? null },
                    // Personal data (2026-10-26): withheld by the server from most readers.
                    {
                      label: 'Date of birth',
                      value: employee.dateOfBirth ? formatIsoDate(employee.dateOfBirth) : null,
                      title: employee.personalMasked ? 'Restricted: only Safety, the HR / recruiting manager and administrators see this' : undefined,
                    },
                    {
                      label: 'Passport / ID number',
                      value: employee.idNumber ?? null,
                      title: employee.personalMasked ? 'Restricted: only Safety, the HR / recruiting manager and administrators see this' : undefined,
                    },
                  ]}
                />
              </EmployeePanel>

              <EmployeePanel title="Pay and organization">
                <EmployeeFactList
                  facts={[
                    { label: 'Department', value: departmentLabel(employee.department) },
                    { label: 'Position', value: employee.position },
                    { label: 'Manager', value: employee.managerName },
                    { label: 'Location', value: employee.location },
                    ...(canSeePay
                      ? employee.driverId
                        ? [
                            { label: 'Paid as', value: 'Driver — pay plan on the driver profile' },
                            { label: 'Paid through', value: 'Driver settlements' },
                          ]
                        : [
                            {
                              label: 'Pay type',
                              value: employee.payType ? PAY_TYPE_LABELS[employee.payType] : null,
                              title: employee.payType ? undefined : 'No pay type has been recorded',
                            },
                            {
                              label: 'Rate',
                              value:
                                employee.payRate === null
                                  ? null
                                  : employee.payRate.toLocaleString(undefined, {
                                      style: 'currency',
                                      currency: 'USD',
                                    }),
                              title:
                                employee.payRate === null
                                  ? 'No rate on file. Nothing here estimates one.'
                                  : undefined,
                              emphasis: true,
                            },
                            { label: 'Paid through', value: 'Payroll' },
                          ]
                      : []),
                  ]}
                />
                {canSeePay ? (
                  <div className="mt-3 flex flex-wrap gap-4">
                    {employee.driverId ? (
                      <Link
                        to="/accounting/settlements"
                        search={{ driver: employee.driverId } as never}
                        className="text-sm text-primary-text hover:underline"
                      >
                        Open their settlements
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="text-sm text-primary-text hover:underline"
                        onClick={() => setTab('compensation')}
                      >
                        Open compensation
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted">
                    Pay is hidden: your role does not include permission to see it.
                  </p>
                )}
              </EmployeePanel>

              <EmployeePanel title="How to reach them">
                <EmployeeFactList
                  facts={[
                    { label: 'Work email', value: employee.workEmail },
                    { label: 'Personal email', value: employee.personalEmail },
                    { label: 'Phone', value: employee.phone },
                    { label: 'Secondary phone', value: employee.secondaryPhone },
                    { label: 'Emergency contact', value: employee.emergencyContactName },
                    { label: 'Emergency phone', value: employee.emergencyContactPhone },
                    {
                      label: 'Relationship',
                      value: employee.emergencyContactRelationship,
                    },
                  ]}
                />
              </EmployeePanel>

              {employee.notes ? (
                <EmployeePanel title="Notes">
                  <p className="text-sm whitespace-pre-wrap text-secondary">{employee.notes}</p>
                </EmployeePanel>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              <NeedsAttentionPanel items={attention.items} unavailable={attention.unavailable} />
              <EmployeePanel title={`Reports (${reports.data?.length ?? 0})`}>
                {reports.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : reports.data && reports.data.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {reports.data.map((person) => (
                      <li key={person.id}>
                        <Link
                          to="/hr/employees/$employeeId"
                          params={{ employeeId: person.id }}
                          className="text-sm text-primary-text hover:underline"
                        >
                          {person.name}
                        </Link>
                        <span className="ml-2 text-xs text-muted">{person.position}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-faint">Nobody reports to this person.</p>
                )}
              </EmployeePanel>
            </div>
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------------------ employment */}
        <TabsContent value="employment" className="pt-4">
          <Card className="p-4">
            <h3 className="text-md font-bold text-ink">Employment history</h3>
            <p className="mt-1 text-xs text-muted">
              Every appointment this person has held. A role change opens a new row; it never
              overwrites the last one.
            </p>
            {employment.isPending ? (
              <Skeleton className="mt-3 h-24 w-full" />
            ) : (
              <table className="mt-3 w-full text-sm">
                <thead className="text-xs font-semibold text-secondary">
                  <tr>
                    <th className="py-1 text-left font-medium">From</th>
                    <th className="py-1 text-left font-medium">To</th>
                    <th className="py-1 text-left font-medium">Position</th>
                    <th className="py-1 text-left font-medium">Department</th>
                    <th className="py-1 text-left font-medium">Manager</th>
                    <th className="py-1 text-left font-medium">Location</th>
                    <th className="py-1 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(employment.data ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-line-soft">
                      <td className="py-1.5 whitespace-nowrap">
                        {formatIsoDate(row.effectiveFrom)}
                      </td>
                      <td className="py-1.5 whitespace-nowrap">
                        {row.effectiveTo ? (
                          formatIsoDate(row.effectiveTo)
                        ) : (
                          <span className="text-success-text">Current</span>
                        )}
                      </td>
                      <td className="py-1.5">{row.position}</td>
                      <td className="py-1.5">{departmentLabel(row.department)}</td>
                      <td className="py-1.5">
                        {row.managerName ?? <span className="text-faint">—</span>}
                      </td>
                      <td className="py-1.5">
                        {row.location ?? <span className="text-faint">—</span>}
                      </td>
                      <td className="py-1.5 text-muted">
                        {row.reason ?? <span className="text-faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </TabsContent>

        {/* ---------------------------------------------------------------------- organization */}
        <TabsContent value="organization" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <EmployeePanel
              title="Current assignment"
              action={
                canEdit ? (
                  <Button variant="ghost" onClick={() => setDialog('reassign')}>
                    Change
                  </Button>
                ) : null
              }
            >
              <EmployeeFactList
                facts={[
                  { label: 'Department', value: departmentLabel(employee.department) },
                  { label: 'Position', value: employee.position },
                  {
                    label: 'Manager',
                    value: employee.managerEmployeeId ? (
                      <Link
                        to="/hr/employees/$employeeId"
                        params={{ employeeId: employee.managerEmployeeId }}
                        className="text-primary-text hover:underline"
                      >
                        {employee.managerName}
                      </Link>
                    ) : null,
                  },
                  { label: 'Location', value: employee.location },
                ]}
              />
            </EmployeePanel>
            <EmployeePanel title="Direct reports">
              {reports.data && reports.data.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {reports.data.map((person) => (
                    <li key={person.id} className="flex items-center justify-between gap-3">
                      <Link
                        to="/hr/employees/$employeeId"
                        params={{ employeeId: person.id }}
                        className="text-sm text-primary-text hover:underline"
                      >
                        {person.name}
                      </Link>
                      <span className="text-xs text-muted">{person.position}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-faint">Nobody reports to this person.</p>
              )}
            </EmployeePanel>
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------------------- documents */}
        <TabsContent value="documents" className="pt-4">
          <Card className="p-6">
            <h3 className="text-md font-bold text-ink">Documents</h3>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              Employee documents are stored by the existing document system, which files them
              against the person they belong to and owns their expiry and verification.
            </p>
            {employee.driverId ? (
              <p className="mt-3 max-w-prose text-sm text-secondary">
                This person drives, so their CDL, medical certificate and other qualification
                documents live in their driver qualification file rather than being copied here.
              </p>
            ) : null}
            <p className="mt-3 text-xs text-faint">
              Employee-scoped document storage is not wired up yet: the document tables are not in
              the database, so nothing is listed here rather than showing a list that is not real.
            </p>
            {employee.driverId ? (
              <div className="mt-4">
                <Link
                  to="/safety/compliance"
                  search={{ entity: employee.driverId } as never}
                  className="text-sm text-primary-text hover:underline"
                >
                  Open the qualification file
                </Link>
              </div>
            ) : null}
          </Card>
        </TabsContent>

        {/* ---------------------------------------------------------------------- compensation */}
        <TabsContent value="compensation" className="pt-4">
          {!canSeePay ? (
            <Card className="p-6">
              <h3 className="text-md font-bold text-ink">Compensation is restricted</h3>
              <p className="mt-2 text-sm text-secondary">
                Your role does not include permission to see pay information.
              </p>
            </Card>
          ) : employee.driverId ? (
            <Card className="p-6">
              <h3 className="text-md font-bold text-ink">Paid as a driver</h3>
              <p className="mt-2 max-w-prose text-sm text-secondary">
                This person is paid from the pay plan on their driver profile — per mile or as a
                percentage of linehaul — and their settlements are calculated from it. It is not
                repeated here, because a second rate is a second answer.
              </p>
              <div className="mt-4">
                <Link
                  to="/accounting/settlements"
                  search={{ driver: employee.driverId } as never}
                  className="text-sm text-primary-text hover:underline"
                >
                  Open their settlements
                </Link>
              </div>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <EmployeePanel
                title="Current compensation"
                action={
                  canEdit ? (
                    <Button variant="ghost" onClick={() => setDialog('compensation')}>
                      Change
                    </Button>
                  ) : null
                }
              >
                <EmployeeFactList
                  facts={[
                    {
                      label: 'Pay type',
                      value: employee.payType ? PAY_TYPE_LABELS[employee.payType] : null,
                      title: employee.payType ? undefined : 'No pay type has been recorded',
                    },
                    {
                      label: 'Rate',
                      value:
                        employee.payRate === null
                          ? null
                          : employee.payRate.toLocaleString(undefined, {
                              style: 'currency',
                              currency: 'USD',
                            }),
                      title:
                        employee.payRate === null
                          ? 'No rate on file. Nothing here estimates one.'
                          : undefined,
                      emphasis: true,
                    },
                  ]}
                />
              </EmployeePanel>
              <EmployeePanel title="History">
                {compensation.data && compensation.data.length > 0 ? (
                  <ul className="divide-y divide-line-soft">
                    {compensation.data.map((row) => (
                      <li key={row.id} className="flex items-start justify-between gap-3 py-2">
                        <span className="min-w-0">
                          <span className="block text-sm text-ink">
                            {PAY_TYPE_LABELS[row.payType] ?? row.payType} ·{' '}
                            {row.payRate.toLocaleString(undefined, {
                              style: 'currency',
                              currency: 'USD',
                            })}
                          </span>
                          <span className="block text-xs text-muted">
                            from {formatIsoDate(row.effectiveFrom)}
                            {row.reason ? ` · ${row.reason}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-faint">No compensation has been recorded.</p>
                )}
              </EmployeePanel>
            </div>
          )}
        </TabsContent>

        {/* --------------------------------------------------------------------------- payroll */}
        <TabsContent value="payroll" className="pt-4">
          <Card className="p-6">
            <h3 className="text-md font-bold text-ink">Payroll</h3>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              Payroll is the financial source of truth for what this person is actually paid. This
              page links to it rather than restating it.
            </p>
            <p className="mt-3 text-xs text-faint">
              Payroll periods are still generated per session and are not yet keyed to this employee
              id, so no figures are shown here. Showing a number that came from a different identity
              would be worse than showing none.
            </p>
            <div className="mt-4 flex gap-4">
              {employee.driverId ? (
                <Link
                  to="/accounting/settlements"
                  className="text-sm text-primary-text hover:underline"
                >
                  Driver settlements
                </Link>
              ) : (
                <Link
                  to="/accounting/payroll"
                  className="text-sm text-primary-text hover:underline"
                >
                  Staff payroll
                </Link>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* ---------------------------------------------------------------------------- safety */}
        <TabsContent value="safety" className="pt-4">
          <Card className="p-6">
            {employee.driverId ? (
              <>
                <h3 className="text-md font-bold text-ink">Safety</h3>
                <p className="mt-2 max-w-prose text-sm text-secondary">
                  Inspections, violations, accidents and the qualification file are owned by Safety
                  and are not duplicated here.
                </p>
                <p className="mt-3 text-xs text-faint">
                  Safety records are still generated per session and are keyed to the driver
                  profile, not to this employee id, so no counts are shown rather than counts that
                  might be about somebody else.
                </p>
                <div className="mt-4 flex flex-wrap gap-4">
                  <Link to="/safety" className="text-sm text-primary-text hover:underline">
                    Safety overview
                  </Link>
                  <Link
                    to="/safety/inspections"
                    className="text-sm text-primary-text hover:underline"
                  >
                    Inspections
                  </Link>
                  <Link
                    to="/safety/violations"
                    className="text-sm text-primary-text hover:underline"
                  >
                    Violations
                  </Link>
                  <Link
                    to="/safety/accidents"
                    className="text-sm text-primary-text hover:underline"
                  >
                    Accidents
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-md font-bold text-ink">No safety profile</h3>
                <p className="mt-2 text-sm text-secondary">
                  Safety records attach to a driving profile, and this person does not have one.
                </p>
              </>
            )}
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------------------ operations */}
        <TabsContent value="operations" className="pt-4">
          <Card className="p-6">
            <h3 className="text-md font-bold text-ink">Operations</h3>
            {employee.driverId ? (
              <p className="mt-2 max-w-prose text-sm text-secondary">
                Their current truck, trailer, load and availability are held on the driver profile,
                which is where dispatch reads and writes them.
              </p>
            ) : employee.department === 'dispatch' ? (
              <p className="mt-2 max-w-prose text-sm text-secondary">
                Loads are assigned to a dispatcher by user account today, not by employee id. Until
                dispatch keys on the employee, this page will not claim to list their loads.
              </p>
            ) : (
              <p className="mt-2 max-w-prose text-sm text-secondary">
                This person has no operational assignments recorded against them.
              </p>
            )}
            {employee.driverId ? (
              <div className="mt-4 flex gap-4">
                <Link to="/drivers" className="text-sm text-primary-text hover:underline">
                  Driver board
                </Link>
                <Link to="/dispatch" className="text-sm text-primary-text hover:underline">
                  Dispatch
                </Link>
              </div>
            ) : null}
          </Card>
        </TabsContent>

        {/* -------------------------------------------------------------------------- activity */}
        <TabsContent value="activity" className="pt-4">
          <Card className="p-4">
            <h3 className="text-md font-bold text-ink">Activity</h3>
            <p className="mt-1 text-xs text-muted">
              Read from the audit log, which is the same log every other module writes to.
            </p>
            {activity.isPending ? (
              <Skeleton className="mt-3 h-24 w-full" />
            ) : activity.data && activity.data.length > 0 ? (
              <ol className="mt-3 flex flex-col gap-3">
                {activity.data.map((entry) => (
                  <li key={entry.id} className="flex gap-3">
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        entry.action === 'status_change'
                          ? 'bg-warning'
                          : entry.action === 'create'
                            ? 'bg-success'
                            : 'bg-line-strong',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">{entry.summary}</span>
                      <span className="block text-xs text-muted">
                        {entry.actorName} · {new Date(entry.at).toLocaleString()}
                        {entry.reason ? ` · ${entry.reason}` : ''}
                      </span>
                      {entry.changes.length > 0 ? (
                        <span className="mt-1 block text-xs text-faint">
                          {entry.changes
                            .map((c) => `${c.field}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-sm text-faint">
                Nothing has been recorded against this person.
              </p>
            )}
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------- the rest of the lifecycle */}
        <TabsContent value="recruiting" className="pt-4">
          <EmployeeRecruitingTab employee={employee} />
        </TabsContent>
        <TabsContent value="onboarding" className="pt-4">
          <EmployeeOnboardingTab employee={employee} />
        </TabsContent>
        <TabsContent value="attendance" className="pt-4">
          <EmployeeAttendanceTab employee={employee} />
        </TabsContent>
        <TabsContent value="pto" className="pt-4">
          <EmployeePtoTab employee={employee} />
        </TabsContent>
        <TabsContent value="performance" className="pt-4">
          <EmployeePerformanceTab employee={employee} />
        </TabsContent>
      </Tabs>

      {dialog === 'reassign' ? (
        <ReassignModal employee={employee} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'compensation' ? (
        <SetCompensationModal employee={employee} onClose={() => setDialog(null)} />
      ) : null}
      {/*
        Terminating a driver is not a status change: company property has to be accounted for and
        their escrow settled. The driver dialog does both, then ends the employment here, so there
        is one checkout rather than two half-answers.
      */}
      {statusTo === 'terminated' && employee.driverId ? (
        <TerminateDriverForEmployee
          driverId={employee.driverId}
          driverName={employee.name}
          onClose={() => setStatusTo(null)}
          onTerminated={(record) =>
            changeStatus.mutate({
              status: 'terminated',
              reason: [TERMINATION_REASON_LABEL[record.reason], record.reasonNote]
                .filter(Boolean)
                .join(' — '),
            })
          }
        />
      ) : statusTo ? (
        <ChangeStatusModal
          employee={employee}
          to={statusTo}
          reports={reports.data ?? []}
          onClose={() => setStatusTo(null)}
        />
      ) : null}
    </div>
  );
}

export type { EmployeeRecord };

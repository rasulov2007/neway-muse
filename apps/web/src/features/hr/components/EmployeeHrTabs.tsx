import { Link } from '@tanstack/react-router';
import {
  DEPARTMENT_LABELS,
  goalProgress,
  onboardingProgress,
  type EmployeeRecord,
} from '@neway/shared';
import { Card, EmptyState, Skeleton } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { FactRow, HrPanel, HrStatus, ProgressBar } from './HrKit';
import {
  useAttendance,
  useCandidates,
  useGoals,
  useOnboardingList,
  usePtoBalances,
  usePtoRequests,
  useReviews,
} from '../useHr';

/**
 * The Phase 11 half of Employee 360.
 *
 * Each panel queries by `employeeId`, which is the whole point of the architecture: recruiting,
 * onboarding, attendance, PTO and performance all reference the same person by the same id, so this
 * page assembles them without any of them holding a second copy of who the person is.
 */

export function EmployeeOnboardingTab({ employee }: { employee: EmployeeRecord }) {
  const list = useOnboardingList({
    pageSize: 5,
    includeFinished: 'true',
    search: employee.employeeNumber,
  });
  const plan = list.data?.data.find((c) => c.employeeId === employee.id);

  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  if (!plan) {
    return (
      <EmptyState
        title="No onboarding plan"
        description="Hiring a candidate creates one automatically. One can also be started from the Onboarding page."
      />
    );
  }
  const progress = onboardingProgress(plan.completedItems, plan.totalItems);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <HrPanel
        title="Onboarding"
        action={
          <Link
            to="/hr/onboarding/$checklistId"
            params={{ checklistId: plan.id }}
            className="text-sm text-primary-text hover:underline"
          >
            Open plan
          </Link>
        }
      >
        <FactRow label="Status" value={<HrStatus value={plan.status} />} />
        <FactRow label="Started" value={formatIsoDate(plan.startDate)} />
        <FactRow label="Due" value={plan.dueDate ? formatIsoDate(plan.dueDate) : null} />
        <FactRow
          label="Progress"
          value={
            <ProgressBar value={progress} label={`${plan.completedItems}/${plan.totalItems}`} />
          }
        />
        <FactRow label="Blocked" value={plan.blockedItems > 0 ? String(plan.blockedItems) : null} />
        <FactRow label="Overdue" value={plan.overdueItems > 0 ? String(plan.overdueItems) : null} />
      </HrPanel>
    </div>
  );
}

export function EmployeeAttendanceTab({ employee }: { employee: EmployeeRecord }) {
  const list = useAttendance({ employeeId: employee.id, pageSize: 15 });
  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  const rows = list.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No attendance recorded"
        description="Attendance records will appear here as time is recorded for this person."
      />
    );
  }
  const finished = rows.filter((r) => r.workedHours !== null);
  const total = finished.reduce((sum, r) => sum + (r.workedHours ?? 0), 0);
  const overtime = finished.reduce((sum, r) => sum + (r.overtimeHours ?? 0), 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-xs font-semibold text-secondary">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">In</th>
              <th className="px-4 py-2 text-left font-medium">Out</th>
              <th className="px-4 py-2 text-right font-medium">Hours</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Exception</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line-soft">
                <td className="px-4 py-1.5">{formatIsoDate(row.entryDate)}</td>
                <td className="px-4 py-1.5">
                  {row.checkInAt
                    ? new Date(row.checkInAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'}
                </td>
                <td className="px-4 py-1.5">
                  {row.checkOutAt
                    ? new Date(row.checkOutAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'}
                </td>
                <td className="px-4 py-1.5 text-right tabular-nums">
                  {row.workedHours === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    row.workedHours.toFixed(2)
                  )}
                </td>
                <td className="px-4 py-1.5">
                  <HrStatus value={row.status} />
                </td>
                <td className="px-4 py-1.5 text-xs text-muted">
                  {row.exception ? row.exception.replace(/_/g, ' ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <HrPanel title="Recent totals">
        <FactRow label="Days on file" value={String(rows.length)} />
        <FactRow label="Finished days" value={String(finished.length)} />
        <FactRow label="Hours worked" value={finished.length > 0 ? total.toFixed(2) : null} />
        <FactRow label="Overtime" value={overtime > 0 ? overtime.toFixed(2) : null} />
        <p className="mt-2 text-xs text-faint">
          Only finished days are totalled. A day with a missing punch has unknown hours, not zero.
        </p>
      </HrPanel>
    </div>
  );
}

export function EmployeePtoTab({ employee }: { employee: EmployeeRecord }) {
  const balances = usePtoBalances(employee.id);
  const requests = usePtoRequests({ employeeId: employee.id, pageSize: 10 });

  if (balances.isPending) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <HrPanel title="Balances">
        {balances.data && balances.data.length > 0 ? (
          <ul className="divide-y divide-line-soft">
            {balances.data.map((b) => (
              <li key={b.policyId} className="py-2">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-ink">{b.policyName}</span>
                  <span className="text-sm tabular-nums text-ink">{b.available.toFixed(1)} h</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {b.balance.toFixed(1)} balance · {b.used.toFixed(1)} used · {b.pending.toFixed(1)}{' '}
                  pending
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No PTO policies apply to this person yet.</p>
        )}
        <p className="mt-3 border-t border-line-soft pt-3 text-xs text-faint">
          Every figure is the sum of the transaction ledger. Nobody can type over a balance.
        </p>
      </HrPanel>
      <HrPanel
        title="Requests"
        action={
          <Link
            to="/hr/pto"
            search={{ q: employee.employeeNumber } as never}
            className="text-sm text-primary-text hover:underline"
          >
            All requests
          </Link>
        }
      >
        {requests.data && requests.data.data.length > 0 ? (
          <ul className="divide-y divide-line-soft">
            {requests.data.data.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {r.policyName} · {r.hours.toFixed(1)} h
                  </span>
                  <span className="block text-xs text-muted">
                    {formatIsoDate(r.startsOn)} – {formatIsoDate(r.endsOn)}
                    {r.approverName ? ` · ${r.approverName}` : ''}
                  </span>
                </span>
                <HrStatus value={r.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No PTO requests.</p>
        )}
      </HrPanel>
    </div>
  );
}

export function EmployeePerformanceTab({ employee }: { employee: EmployeeRecord }) {
  const goals = useGoals({ employeeId: employee.id, pageSize: 20 });
  const reviews = useReviews({ employeeId: employee.id, pageSize: 10 });

  if (goals.isPending) return <Skeleton className="h-40 w-full" />;
  const goalRows = goals.data?.data ?? [];
  const reviewRows = reviews.data?.data ?? [];

  if (goalRows.length === 0 && reviewRows.length === 0) {
    return (
      <EmptyState
        title="No performance records"
        description="Goals and reviews will appear here as performance cycles begin."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <HrPanel title={`Goals (${goalRows.length})`}>
        {goalRows.length > 0 ? (
          <ul className="divide-y divide-line-soft">
            {goalRows.map((g) => (
              <li key={g.id} className="py-2">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink">{g.title}</span>
                  <HrStatus value={g.status} />
                </span>
                <span className="mt-1 flex items-center justify-between gap-3">
                  <ProgressBar
                    value={goalProgress(g)}
                    label={
                      g.measure === 'numeric' && g.currentValue !== null
                        ? `${g.currentValue} / ${g.targetValue ?? '—'}${g.unit ? ` ${g.unit}` : ''}`
                        : undefined
                    }
                  />
                  <span className="text-xs text-muted">due {formatIsoDate(g.dueDate)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No goals set.</p>
        )}
      </HrPanel>
      <HrPanel title={`Reviews (${reviewRows.length})`}>
        {reviewRows.length > 0 ? (
          <ul className="divide-y divide-line-soft">
            {reviewRows.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {formatIsoDate(r.periodStart)} – {formatIsoDate(r.periodEnd)}
                  </span>
                  <span className="block text-xs text-muted">
                    {r.reviewerName ?? 'No reviewer'} ·{' '}
                    {r.rating === null ? 'not rated' : `rated ${r.rating}/5`}
                  </span>
                </span>
                <HrStatus value={r.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No reviews.</p>
        )}
      </HrPanel>
    </div>
  );
}

/** Where this person came from, when they came through recruiting. */
export function EmployeeRecruitingTab({ employee }: { employee: EmployeeRecord }) {
  const candidates = useCandidates({ includeClosed: 'true', stage: 'hired', pageSize: 10_000 });
  const origin = candidates.data?.data.find((c) => c.hiredEmployeeId === employee.id);

  if (candidates.isPending) return <Skeleton className="h-40 w-full" />;
  if (!origin) {
    return (
      <EmptyState
        title="Not hired through recruiting"
        description="This employee was created directly rather than converted from a candidate."
      />
    );
  }

  return (
    <HrPanel
      title="Hired from"
      action={
        <Link
          to="/hr/recruiting/$candidateId"
          params={{ candidateId: origin.id }}
          className="text-sm text-primary-text hover:underline"
        >
          Open candidate
        </Link>
      }
    >
      <FactRow label="Candidate" value={`${origin.applicantNumber} · ${origin.name}`} />
      <FactRow label="Applied" value={formatIsoDate(origin.appliedOn)} />
      <FactRow label="Hired" value={origin.hiredOn ? formatIsoDate(origin.hiredOn) : null} />
      <FactRow label="Opening" value={origin.jobTitle} />
      <FactRow label="Source" value={origin.source?.replace(/_/g, ' ')} />
      <FactRow label="Recruiter" value={origin.recruiterName} />
      <FactRow label="Department" value={DEPARTMENT_LABELS[origin.department]} />
      <p className="mt-3 border-t border-line-soft pt-3 text-xs text-faint">
        The candidate record points at this employee. There is one person, referenced twice — never
        two records of the same human being.
      </p>
    </HrPanel>
  );
}

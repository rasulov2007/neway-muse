import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { CalendarCheck, Plus } from 'lucide-react';
import {
  ATTENDANCE_EXCEPTIONS,
  ATTENDANCE_EXCEPTION_LABELS,
  ATTENDANCE_STATUSES,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  type AttendanceEntryRecord,
} from '@neway/shared';
import {
  Alert,
  Button,
  DataTable,
  DatePicker,
  EmptyState,
  FilterBar,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
  createColumns,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { HrKpiStrip, HrStatus, type KpiSegment } from './components/HrKit';
import { Field } from './RecruitingPage';
import { hrSearchSchema } from './hr-search';
import { hrApi, useAttendance, useAttendanceSummary, useHrMutation } from './useHr';

const col = createColumns<AttendanceEntryRecord>();

/**
 * Attendance.
 *
 * Workforce time, deliberately separate from a driver's hours of service: HOS is a safety record
 * the ELD owns and answers "may this person legally drive". This answers "were they at work".
 */
export function AttendancePage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => hrSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [resolving, setResolving] = useState<AttendanceEntryRecord | null>(null);

  const onDate = search.onDate ?? new Date().toISOString().slice(0, 10);
  const summary = useAttendanceSummary(onDate);

  const params = useMemo(
    () => ({
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      department: search.department,
      status: search.status,
      exception: search.exception,
      from: search.from,
      to: search.to,
      unresolvedOnly: search.unresolvedOnly ? 'true' : undefined,
    }),
    [search],
  );
  const list = useAttendance(params);
  const approve = useHrMutation((id: string) => hrApi.approveAttendance(id));

  function update(patch: Record<string, unknown>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        if (!('page' in patch)) delete next.page;
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === '' || v === null) delete next[k];
        }
        return next;
      },
      replace: true,
    });
  }

  const s = summary.data;
  const segments: KpiSegment[] = [
    { key: 'present', label: 'Present today', value: s?.present ?? null, tone: 'success' },
    { key: 'absent', label: 'Absent', value: s?.absent ?? null, tone: 'danger' },
    { key: 'late', label: 'Late', value: s?.late ?? null, tone: 'warning' },
    { key: 'leave', label: 'On leave', value: s?.onLeave ?? null },
    { key: 'missing', label: 'Missing punch', value: s?.missingPunch ?? null, tone: 'warning' },
    { key: 'ot', label: 'Overtime', value: s?.overtimeHours ?? null, suffix: 'h' },
    {
      key: 'exceptions',
      label: 'Open exceptions',
      value: s?.openExceptions ?? null,
      tone: 'warning',
      onSelect: () => update({ unresolvedOnly: search.unresolvedOnly ? undefined : '1' }),
    },
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('employeeName', { header: 'Employee', meta: { primary: true, width: 190 } }),
        col.display({
          id: 'department',
          header: 'Department',
          meta: { width: 150 },
          cell: ({ row }) => DEPARTMENT_LABELS[row.original.department],
        }),
        col.accessor('entryDate', {
          header: 'Date',
          meta: { width: 110 },
          cell: ({ getValue }) => formatIsoDate(getValue()),
        }),
        col.display({
          id: 'in',
          header: 'Clock in',
          meta: { width: 100 },
          cell: ({ row }) =>
            row.original.checkInAt ? (
              new Date(row.original.checkInAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            ) : (
              <span className="text-danger-text">—</span>
            ),
        }),
        col.display({
          id: 'out',
          header: 'Clock out',
          meta: { width: 100 },
          cell: ({ row }) =>
            row.original.checkOutAt ? (
              new Date(row.original.checkOutAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            ) : (
              <span className="text-danger-text">—</span>
            ),
        }),
        col.display({
          id: 'hours',
          header: 'Hours',
          meta: { width: 90, align: 'right' },
          cell: ({ row }) =>
            // Null hours means the day is unfinished, not that nothing was worked.
            row.original.workedHours === null ? (
              <span className="text-faint" title="The day has not finished">
                —
              </span>
            ) : (
              row.original.workedHours.toFixed(2)
            ),
        }),
        col.display({
          id: 'ot',
          header: 'OT',
          meta: { width: 70, align: 'right' },
          cell: ({ row }) =>
            row.original.overtimeHours ? (
              <span className="text-warning-text">{row.original.overtimeHours.toFixed(2)}</span>
            ) : (
              <span className="text-faint">—</span>
            ),
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 110 },
          cell: ({ row }) => <HrStatus value={row.original.status} />,
        }),
        col.display({
          id: 'exception',
          header: 'Exception',
          meta: { width: 200 },
          cell: ({ row }) => {
            const entry = row.original;
            if (!entry.exception) return <span className="text-faint">—</span>;
            const label = ATTENDANCE_EXCEPTION_LABELS[entry.exception];
            return entry.exceptionResolvedAt ? (
              <span className="text-xs text-muted" title={entry.exceptionNote ?? undefined}>
                {label} · resolved
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setResolving(entry)}>
                {label}
              </Button>
            );
          },
        }),
        col.display({
          id: 'approve',
          header: '',
          meta: { width: 100 },
          cell: ({ row }) =>
            row.original.approvedAt ? (
              <span className="text-xs text-success-text">Approved</span>
            ) : (
              <Button
                variant="ghost"
                onClick={() =>
                  approve.mutate(row.original.id, {
                    onSuccess: () => toast({ tone: 'success', title: 'Approved' }),
                    onError: (error) =>
                      toast({
                        tone: 'danger',
                        title: 'Not approved',
                        description: error instanceof ApiError ? error.message : undefined,
                      }),
                  })
                }
              >
                Approve
              </Button>
            ),
        }),
      ]),
    [approve, toast],
  );

  const page = list.data;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Attendance"
        description="Workforce time and exceptions. A driver's hours of service are a separate safety record."
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Summary for</span>
          <DatePicker
            value={onDate}
            onIsoChange={(e) => update({ onDate: e })}
            className="w-40"
          />
        </label>
      </div>

      <HrKpiStrip segments={segments} loading={summary.isPending} />

      {list.error ? (
        <Alert
          tone="danger"
          title="Attendance could not be loaded"
          description={list.error instanceof Error ? list.error.message : 'Unknown error'}
        />
      ) : null}

      <DataTable
        columns={columns}
        data={page?.data ?? []}
        rowKey={(e) => e.id}
        caption="Attendance"
        loading={list.isPending}
        serverSide
        total={page?.total ?? 0}
        state={{
          sorting: [],
          pagination: { page: search.page ?? 1, pageSize: search.pageSize ?? 25 },
          rowSelection: {},
          columnVisibility: {},
          globalFilter: '',
        }}
        onStateChange={(next) => {
          if (next.pagination)
            update({ page: next.pagination.page, pageSize: next.pagination.pageSize });
        }}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (v) => update({ q: v || undefined }),
              placeholder: 'Search employee…',
            }}
            filters={[
              {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: ATTENDANCE_STATUSES.map((v) => ({
                  value: v,
                  label: v.replace(/_/g, ' '),
                })),
              },
              {
                key: 'exception',
                label: 'Exception',
                type: 'select',
                options: ATTENDANCE_EXCEPTIONS.map((v) => ({
                  value: v,
                  label: ATTENDANCE_EXCEPTION_LABELS[v],
                })),
              },
              {
                key: 'department',
                label: 'Department',
                type: 'select',
                options: EMPLOYEE_DEPARTMENTS.map((d) => ({
                  value: d,
                  label: DEPARTMENT_LABELS[d],
                })),
              },
            ]}
            values={{
              status: search.status,
              exception: search.exception,
              department: search.department,
            }}
            onChange={(k, v) => update({ [k]: v })}
            onClear={() =>
              void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
            }
          >
            {/* Search, filters and the primary action on one row. */}
            <span className="ml-auto flex items-center gap-2">
              <Button variant="primary" icon={<Plus />} onClick={() => setAddOpen(true)}>
                Add entry
              </Button>
            </span>
          </FilterBar>
        }
        empty={
          <EmptyState
            icon={<CalendarCheck />}
            title="No attendance records"
            description="Attendance records will appear here as employees record time."
            action={
              <Button icon={<Plus />} onClick={() => setAddOpen(true)}>
                Add entry
              </Button>
            }
          />
        }
      />

      {addOpen ? <AddEntryModal onClose={() => setAddOpen(false)} /> : null}
      {resolving ? <ResolveModal entry={resolving} onClose={() => setResolving(null)} /> : null}
    </div>
  );
}

function AddEntryModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createAttendance(body));
  const [form, setForm] = useState({
    employeeId: '',
    entryDate: new Date().toISOString().slice(0, 10),
    checkInAt: '',
    checkOutAt: '',
    breakMinutes: '30',
    status: 'present',
    notes: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add attendance entry"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.employeeId}
            onClick={() =>
              create.mutate(
                {
                  employeeId: form.employeeId,
                  entryDate: form.entryDate,
                  checkInAt: form.checkInAt ? new Date(form.checkInAt).toISOString() : null,
                  checkOutAt: form.checkOutAt ? new Date(form.checkOutAt).toISOString() : null,
                  breakMinutes: Number(form.breakMinutes) || 0,
                  status: form.status,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Entry recorded' });
                    onClose();
                  },
                },
              )
            }
          >
            Save entry
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {create.error ? (
          <Alert
            tone="danger"
            title="Not saved"
            description={create.error instanceof ApiError ? create.error.message : 'Failed.'}
          />
        ) : null}
        <Field label="Employee">
          <Select
            value={form.employeeId}
            onValueChange={(v) => set('employeeId', v)}
            placeholder={directory.isPending ? 'Loading…' : 'Choose an employee'}
            options={(directory.data ?? []).map((e) => ({
              value: e.id,
              label: e.name,
              description: e.employeeNumber,
            }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date">
            <DatePicker
              value={form.entryDate}
              onIsoChange={(e) => set('entryDate', e)}
            />
          </Field>
          <Field label="Status">
            <Select
              value={form.status}
              onValueChange={(v) => set('status', v)}
              options={ATTENDANCE_STATUSES.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field label="Clock in">
            <Input
              type="datetime-local"
              value={form.checkInAt}
              onChange={(e) => set('checkInAt', e.target.value)}
            />
          </Field>
          <Field label="Clock out">
            <Input
              type="datetime-local"
              value={form.checkOutAt}
              onChange={(e) => set('checkOutAt', e.target.value)}
            />
          </Field>
          <Field label="Break (minutes)">
            <Input
              type="number"
              min="0"
              value={form.breakMinutes}
              onChange={(e) => set('breakMinutes', e.target.value)}
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Leaving a punch blank is allowed and raises an exception. Hours stay unknown rather than
          being guessed.
        </p>
      </div>
    </Modal>
  );
}

function ResolveModal({ entry, onClose }: { entry: AttendanceEntryRecord; onClose: () => void }) {
  const { toast } = useToast();
  const resolve = useHrMutation((note: string) => hrApi.resolveAttendance(entry.id, note));
  const [note, setNote] = useState('');

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={entry.exception ? ATTENDANCE_EXCEPTION_LABELS[entry.exception] : 'Resolve'}
      description={`${entry.employeeName} · ${formatIsoDate(entry.entryDate)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={resolve.isPending}
            disabled={!note.trim()}
            onClick={() =>
              resolve.mutate(note.trim(), {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Exception resolved' });
                  onClose();
                },
              })
            }
          >
            Resolve
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="What was done about it">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">
          Recorded against this day in the audit trail. Correcting the punches instead will clear
          the exception on its own.
        </p>
      </div>
    </Modal>
  );
}

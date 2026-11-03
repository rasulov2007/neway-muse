import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { CalendarDays, Plus } from 'lucide-react';
import {
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  PTO_POLICY_KINDS,
  PTO_REQUEST_STATUSES,
  inclusiveDays,
  ptoTransitions,
  type PtoRequestRecord,
  type PtoRequestStatus,
} from '@neway/shared';
import {
  Alert,
  Button,
  Card,
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
import {
  hrApi,
  useHrMutation,
  usePtoBalances,
  usePtoPolicies,
  usePtoRequests,
  usePtoSummary,
} from './useHr';

const col = createColumns<PtoRequestRecord>();

/** Time off. Balances come from the transaction ledger, so nobody can type over one. */
export function PtoPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => hrSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [requestOpen, setRequestOpen] = useState(false);
  const [deciding, setDeciding] = useState<PtoRequestRecord | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);

  const summary = usePtoSummary();
  const policies = usePtoPolicies();
  const params = useMemo(
    () => ({
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      status: search.status,
      department: search.department,
      policyId: search.policy,
      from: search.from,
      to: search.to,
    }),
    [search],
  );
  const list = usePtoRequests(params);

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
    {
      key: 'submitted',
      label: 'Pending requests',
      value: s?.pending ?? null,
      tone: 'warning',
      onSelect: () => update({ status: 'submitted' }),
    },
    { key: 'hours', label: 'Hours awaiting decision', value: s?.pendingHours ?? null, suffix: 'h' },
    {
      key: 'approved',
      label: 'Approved this month',
      value: s?.approvedThisMonth ?? null,
      tone: 'success',
      onSelect: () => update({ status: 'approved' }),
    },
    { key: 'upcoming', label: 'Upcoming', value: s?.upcoming ?? null },
    { key: 'out', label: 'Off today', value: s?.outToday ?? null },
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('employeeName', { header: 'Employee', meta: { primary: true, width: 180 } }),
        col.accessor('requestNumber', { header: 'Request', meta: { width: 110 } }),
        col.accessor('policyName', { header: 'Type', meta: { width: 120 } }),
        col.display({
          id: 'dates',
          header: 'Dates',
          meta: { width: 200 },
          cell: ({ row }) => (
            <span>
              {formatIsoDate(row.original.startsOn)} – {formatIsoDate(row.original.endsOn)}
              <span className="ml-2 text-xs text-muted">
                {inclusiveDays(row.original.startsOn, row.original.endsOn)}d
              </span>
            </span>
          ),
        }),
        col.accessor('hours', {
          header: 'Hours',
          meta: { width: 90, align: 'right' },
          cell: ({ getValue }) => getValue().toFixed(1),
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 120 },
          cell: ({ row }) => <HrStatus value={row.original.status} />,
        }),
        col.display({
          id: 'approver',
          header: 'Decided by',
          meta: { width: 150 },
          cell: ({ row }) => row.original.approverName ?? <span className="text-faint">—</span>,
        }),
        col.display({
          id: 'actions',
          header: '',
          meta: { width: 110 },
          cell: ({ row }) =>
            ptoTransitions(row.original.status).length > 0 ? (
              <Button variant="ghost" onClick={() => setDeciding(row.original)}>
                Decide
              </Button>
            ) : null,
        }),
      ]),
    [],
  );

  const page = list.data;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="PTO"
        description="Requests, approvals and balances. Every hour is a ledger entry, so a balance can always be explained."
      />

      <HrKpiStrip
        segments={segments}
        activeKey={search.status ?? null}
        loading={summary.isPending}
      />

      {policies.data && policies.data.length === 0 ? (
        <Alert
          tone="info"
          title="No PTO types yet"
          description="A request needs a policy to draw from — it decides the accrual and whether the balance may go negative."
        />
      ) : null}

      {list.error ? (
        <Alert
          tone="danger"
          title="PTO could not be loaded"
          description={list.error instanceof Error ? list.error.message : 'Unknown error'}
        />
      ) : null}

      <DataTable
        columns={columns}
        data={page?.data ?? []}
        rowKey={(r) => r.id}
        caption="PTO requests"
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
              placeholder: 'Search employee or request…',
            }}
            filters={[
              {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: PTO_REQUEST_STATUSES.map((v) => ({ value: v, label: v })),
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
              ...(policies.data && policies.data.length > 0
                ? [
                    {
                      key: 'policy',
                      label: 'Type',
                      type: 'select' as const,
                      options: policies.data.map((p) => ({ value: p.id, label: p.name })),
                    },
                  ]
                : []),
            ]}
            values={{
              status: search.status,
              department: search.department,
              policy: search.policy,
            }}
            onChange={(k, v) => update({ [k]: v })}
            onClear={() =>
              void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
            }
          >
            {/* Search, filters and the primary action on one row. */}
            <span className="ml-auto flex items-center gap-2">
              <Button variant="secondary" onClick={() => setPolicyOpen(true)}>
                Add PTO type
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setRequestOpen(true)}>
                New request
              </Button>
            </span>
          </FilterBar>
        }
        empty={
          <EmptyState
            icon={<CalendarDays />}
            title="No PTO requests"
            description="PTO requests will appear here when employees submit time off."
            action={
              <Button icon={<Plus />} onClick={() => setRequestOpen(true)}>
                New request
              </Button>
            }
          />
        }
      />

      {requestOpen ? <RequestModal onClose={() => setRequestOpen(false)} /> : null}
      {policyOpen ? <PolicyModal onClose={() => setPolicyOpen(false)} /> : null}
      {deciding ? (
        <DecideModal
          request={deciding}
          onClose={() => setDeciding(null)}
          onDone={(status) => toast({ tone: 'success', title: `Request ${status}` })}
        />
      ) : null}
    </div>
  );
}

function RequestModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const policies = usePtoPolicies();
  const create = useHrMutation((body: unknown) => hrApi.createPtoRequest(body));
  const [form, setForm] = useState({
    employeeId: '',
    policyId: '',
    startsOn: '',
    endsOn: '',
    hours: '',
    reason: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const balances = usePtoBalances(form.employeeId);
  const balance = balances.data?.find((b) => b.policyId === form.policyId);

  const days = form.startsOn && form.endsOn ? inclusiveDays(form.startsOn, form.endsOn) : 0;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New PTO request"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={
              !form.employeeId || !form.policyId || !form.startsOn || !form.endsOn || !form.hours
            }
            onClick={() =>
              create.mutate(
                {
                  employeeId: form.employeeId,
                  policyId: form.policyId,
                  startsOn: form.startsOn,
                  endsOn: form.endsOn,
                  hours: Number(form.hours),
                  reason: form.reason || null,
                  notes: null,
                  asDraft: false,
                },
                {
                  onSuccess: (result) => {
                    toast({
                      tone: 'success',
                      title: `${result.request.requestNumber} submitted`,
                      description:
                        result.conflicts.length > 0
                          ? `${result.conflicts.length} warning${result.conflicts.length === 1 ? '' : 's'} recorded for the approver.`
                          : undefined,
                    });
                    onClose();
                  },
                },
              )
            }
          >
            Submit request
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {create.error ? (
          <Alert
            tone="danger"
            title="Not submitted"
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
        <Field label="PTO type">
          <Select
            value={form.policyId}
            onValueChange={(v) => set('policyId', v)}
            placeholder="Choose a type"
            options={(policies.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>
        {balance ? (
          <Card className="px-3 py-2 text-xs text-secondary">
            {balance.available.toFixed(1)} hours available ({balance.balance.toFixed(1)} balance,{' '}
            {balance.pending.toFixed(1)} already pending)
          </Card>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From">
            <DatePicker
              value={form.startsOn}
              onIsoChange={(e) => set('startsOn', e)}
            />
          </Field>
          <Field label="To">
            <DatePicker
              value={form.endsOn}
              onIsoChange={(e) => set('endsOn', e)}
            />
          </Field>
          <Field label="Hours">
            <Input
              type="number"
              step="0.5"
              min="0"
              value={form.hours}
              onChange={(e) => set('hours', e.target.value)}
            />
          </Field>
        </div>
        {days > 0 ? (
          <p className="text-xs text-muted">
            {days} calendar day{days === 1 ? '' : 's'}, both ends counted.
          </p>
        ) : null}
        <Field label="Reason (optional)">
          <Textarea rows={2} value={form.reason} onChange={(e) => set('reason', e.target.value)} />
        </Field>
        <p className="text-xs text-faint">
          Medical detail is never required here. A reason is optional and free text.
        </p>
      </div>
    </Modal>
  );
}

function DecideModal({
  request,
  onClose,
  onDone,
}: {
  request: PtoRequestRecord;
  onClose: () => void;
  onDone: (status: string) => void;
}) {
  const decide = useHrMutation((body: unknown) => hrApi.decidePto(request.id, body));
  const [status, setStatus] = useState<PtoRequestStatus>(
    ptoTransitions(request.status)[0] ?? 'approved',
  );
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const needsNote = status === 'rejected';

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${request.requestNumber} · ${request.employeeName}`}
      description={`${request.hours} hours, ${formatIsoDate(request.startsOn)} to ${formatIsoDate(request.endsOn)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={decide.isPending}
            disabled={needsNote && !note.trim()}
            onClick={() =>
              decide.mutate(
                { status, note: note.trim() || null, overrideBalance: override },
                {
                  onSuccess: () => {
                    onDone(status);
                    onClose();
                  },
                },
              )
            }
          >
            Confirm
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {decide.error ? (
          <Alert
            tone="danger"
            title="Refused"
            description={decide.error instanceof ApiError ? decide.error.message : 'Failed.'}
          />
        ) : null}
        <Field label="Decision">
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as PtoRequestStatus)}
            options={ptoTransitions(request.status).map((s) => ({ value: s, label: s }))}
          />
        </Field>
        <Field label={needsNote ? 'Reason (required)' : 'Note (optional)'}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {status === 'approved' ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            <span className="text-secondary">
              Approve even if it takes the balance negative
              <span className="ml-1 text-xs text-muted">(recorded as an override)</span>
            </span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}

function PolicyModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useHrMutation((body: unknown) => hrApi.createPtoPolicy(body));
  const [form, setForm] = useState({
    name: '',
    kind: 'vacation',
    accrualHoursPerPeriod: '6.67',
    period: 'monthly',
    maxBalanceHours: '',
    allowsNegativeBalance: false,
  });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add PTO type"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.name}
            onClick={() =>
              create.mutate(
                {
                  name: form.name,
                  kind: form.kind,
                  accrualHoursPerPeriod: Number(form.accrualHoursPerPeriod) || 0,
                  period: form.period,
                  maxBalanceHours: form.maxBalanceHours ? Number(form.maxBalanceHours) : null,
                  carryoverHours: null,
                  allowsNegativeBalance: form.allowsNegativeBalance,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'PTO type added' });
                    onClose();
                  },
                },
              )
            }
          >
            Add type
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          />
        </Field>
        <Field label="Kind">
          <Select
            value={form.kind}
            onValueChange={(v) => setForm((p) => ({ ...p, kind: v }))}
            options={PTO_POLICY_KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accrual per period">
            <Input
              type="number"
              step="0.01"
              value={form.accrualHoursPerPeriod}
              onChange={(e) => setForm((p) => ({ ...p, accrualHoursPerPeriod: e.target.value }))}
            />
          </Field>
          <Field label="Period">
            <Select
              value={form.period}
              onValueChange={(v) => setForm((p) => ({ ...p, period: v }))}
              options={['weekly', 'biweekly', 'monthly', 'annually'].map((v) => ({
                value: v,
                label: v,
              }))}
            />
          </Field>
        </div>
        <Field label="Maximum balance (optional)">
          <Input
            type="number"
            value={form.maxBalanceHours}
            onChange={(e) => setForm((p) => ({ ...p, maxBalanceHours: e.target.value }))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.allowsNegativeBalance}
            onChange={(e) => setForm((p) => ({ ...p, allowsNegativeBalance: e.target.checked }))}
          />
          <span className="text-secondary">Allow the balance to go negative</span>
        </label>
      </div>
    </Modal>
  );
}

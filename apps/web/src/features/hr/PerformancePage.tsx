import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Activity, Plus } from 'lucide-react';
import {
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  GOAL_CATEGORIES,
  GOAL_MEASURES,
  GOAL_STATUSES,
  RATING_SCALE,
  REVIEW_STATUSES,
  goalProgress,
  type PerformanceGoalRecord,
  type PerformanceReviewRecord,
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
  Tabs,
  TabsContent,
  Textarea,
  createColumns,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { HrKpiStrip, HrStatus, ProgressBar, type KpiSegment } from './components/HrKit';
import { Field } from './RecruitingPage';
import { hrSearchSchema } from './hr-search';
import {
  hrApi,
  useGoals,
  useHrMutation,
  usePerformanceCycles,
  usePerformanceSummary,
  useReviews,
} from './useHr';

const goalCol = createColumns<PerformanceGoalRecord>();
const reviewCol = createColumns<PerformanceReviewRecord>();

/**
 * Performance.
 *
 * Goals and reviews on one page because they are one conversation about a person. A goal that
 * cannot be expressed as a percentage is not forced into one, and a review with no rating shows no
 * rating rather than a zero.
 */
export function PerformancePage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => hrSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'goal' | 'review' | 'cycle' | null>(null);
  const [editing, setEditing] = useState<PerformanceReviewRecord | null>(null);

  const summary = usePerformanceSummary();
  const cycles = usePerformanceCycles();
  const tab = search.tab ?? 'goals';

  const params = useMemo(
    () => ({
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      department: search.department,
      cycleId: search.cycle,
      goalStatus: tab === 'goals' ? search.status : undefined,
      reviewStatus: tab === 'reviews' ? search.status : undefined,
    }),
    [search, tab],
  );
  const goals = useGoals(params);
  const reviews = useReviews(params);

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
      key: 'due',
      label: 'Reviews due',
      value: s?.reviewsDue ?? null,
      tone: 'warning',
      onSelect: () => update({ tab: 'reviews', status: undefined }),
    },
    {
      key: 'done',
      label: 'Reviews completed',
      value: s?.reviewsCompleted ?? null,
      tone: 'success',
    },
    {
      key: 'risk',
      label: 'Goals at risk',
      value: s?.goalsAtRisk ?? null,
      tone: 'danger',
      onSelect: () => update({ tab: 'goals', status: 'at_risk' }),
    },
    {
      key: 'goalsDone',
      label: 'Goals completed',
      value: s?.goalsCompleted ?? null,
      tone: 'success',
    },
    { key: 'nogoals', label: 'Without goals', value: s?.employeesWithoutGoals ?? null },
    {
      key: 'plans',
      label: 'Open action plans',
      value: s?.openActionPlans ?? null,
      tone: 'warning',
    },
  ];

  const goalColumns = useMemo(
    () =>
      goalCol.columns([
        goalCol.accessor('employeeName', {
          header: 'Employee',
          meta: { primary: true, width: 170 },
        }),
        goalCol.accessor('title', { header: 'Goal', meta: { width: 220 } }),
        goalCol.accessor('category', { header: 'Category', meta: { width: 120 } }),
        goalCol.display({
          id: 'measure',
          header: 'Measure',
          meta: { width: 110 },
          cell: ({ row }) => (
            <span className="text-xs text-muted">
              {row.original.measure}
              {row.original.unit ? ` · ${row.original.unit}` : ''}
            </span>
          ),
        }),
        goalCol.display({
          id: 'progress',
          header: 'Progress',
          meta: { width: 170 },
          cell: ({ row }) => {
            const value = goalProgress(row.original);
            const label =
              row.original.measure === 'numeric' && row.original.currentValue !== null
                ? `${row.original.currentValue} / ${row.original.targetValue ?? '—'}`
                : undefined;
            return <ProgressBar value={value} label={label} />;
          },
        }),
        goalCol.accessor('dueDate', {
          header: 'Due',
          meta: { width: 110 },
          cell: ({ getValue }) => formatIsoDate(getValue()),
        }),
        goalCol.display({
          id: 'status',
          header: 'Status',
          meta: { width: 120 },
          cell: ({ row }) => <HrStatus value={row.original.status} />,
        }),
        goalCol.display({
          id: 'update',
          header: '',
          meta: { width: 90 },
          cell: ({ row }) => <UpdateGoalButton goal={row.original} />,
        }),
      ]),
    [],
  );

  const reviewColumns = useMemo(
    () =>
      reviewCol.columns([
        reviewCol.accessor('employeeName', {
          header: 'Employee',
          meta: { primary: true, width: 170 },
        }),
        reviewCol.accessor('position', { header: 'Role', meta: { width: 140 } }),
        reviewCol.display({
          id: 'period',
          header: 'Period',
          meta: { width: 190 },
          cell: ({ row }) =>
            `${formatIsoDate(row.original.periodStart)} – ${formatIsoDate(row.original.periodEnd)}`,
        }),
        reviewCol.display({
          id: 'reviewer',
          header: 'Reviewer',
          meta: { width: 150 },
          cell: ({ row }) => row.original.reviewerName ?? <span className="text-faint">—</span>,
        }),
        reviewCol.display({
          id: 'rating',
          header: 'Rating',
          meta: { width: 160 },
          cell: ({ row }) =>
            // No rating is shown as no rating. It is never a zero.
            row.original.rating === null ? (
              <span className="text-faint" title="Nobody has rated this yet">
                —
              </span>
            ) : (
              <span>
                {row.original.rating} ·{' '}
                <span className="text-xs text-muted">
                  {RATING_SCALE.find((r) => r.value === row.original.rating)?.label}
                </span>
              </span>
            ),
        }),
        reviewCol.display({
          id: 'status',
          header: 'Status',
          meta: { width: 130 },
          cell: ({ row }) => <HrStatus value={row.original.status} />,
        }),
        reviewCol.display({
          id: 'open',
          header: '',
          meta: { width: 80 },
          cell: ({ row }) => (
            <Button variant="ghost" onClick={() => setEditing(row.original)}>
              Open
            </Button>
          ),
        }),
      ]),
    [],
  );

  const goalPage = goals.data;
  const reviewPage = reviews.data;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Performance"
        description="Goals, reviews and action plans across the workforce."
      />

      <HrKpiStrip segments={segments} loading={summary.isPending} />

      <Tabs
        items={[
          { value: 'goals', label: `Goals${goalPage ? ` (${goalPage.total})` : ''}` },
          { value: 'reviews', label: `Reviews${reviewPage ? ` (${reviewPage.total})` : ''}` },
        ]}
        value={tab}
        onValueChange={(v) => update({ tab: v, status: undefined })}
        aria-label="Performance"
      >
        <TabsContent value="goals" className="pt-4">
          {goals.error ? (
            <Alert
              tone="danger"
              title="Goals could not be loaded"
              description={goals.error instanceof Error ? goals.error.message : 'Unknown error'}
            />
          ) : null}
          <DataTable
            columns={goalColumns}
            data={goalPage?.data ?? []}
            rowKey={(g) => g.id}
            caption="Goals"
            loading={goals.isPending}
            serverSide
            total={goalPage?.total ?? 0}
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
                  placeholder: 'Search goal or employee…',
                }}
                filters={[
                  {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: GOAL_STATUSES.map((v) => ({ value: v, label: v.replace(/_/g, ' ') })),
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
                  ...(cycles.data && cycles.data.length > 0
                    ? [
                        {
                          key: 'cycle',
                          label: 'Cycle',
                          type: 'select' as const,
                          options: cycles.data.map((c) => ({ value: c.id, label: c.name })),
                        },
                      ]
                    : []),
                ]}
                values={{
                  status: search.status,
                  department: search.department,
                  cycle: search.cycle,
                }}
                onChange={(k, v) => update({ [k]: v })}
                onClear={() =>
                  void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
                }
              >
                {/* Search, filters and the primary action on one row. */}
                <span className="ml-auto flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setDialog('cycle')}>
                    New cycle
                  </Button>
                  <Button variant="secondary" onClick={() => setDialog('review')}>
                    Start review
                  </Button>
                  <Button variant="primary" icon={<Plus />} onClick={() => setDialog('goal')}>
                    Set goal
                  </Button>
                </span>
              </FilterBar>
            }
            empty={
              <EmptyState
                icon={<Activity />}
                title="No performance records"
                description="Goals and reviews will appear here as performance cycles begin."
                action={
                  <Button icon={<Plus />} onClick={() => setDialog('goal')}>
                    Set the first goal
                  </Button>
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="reviews" className="pt-4">
          <DataTable
            columns={reviewColumns}
            data={reviewPage?.data ?? []}
            rowKey={(r) => r.id}
            caption="Reviews"
            loading={reviews.isPending}
            serverSide
            total={reviewPage?.total ?? 0}
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
                    options: REVIEW_STATUSES.map((v) => ({
                      value: v,
                      label: v.replace(/_/g, ' '),
                    })),
                  },
                ]}
                values={{ status: search.status }}
                onChange={(k, v) => update({ [k]: v })}
                onClear={() =>
                  void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
                }
              />
            }
            empty={
              <EmptyState
                icon={<Activity />}
                title="No reviews"
                description="A review covers a period and needs a rating before it can be submitted."
                action={<Button onClick={() => setDialog('review')}>Start a review</Button>}
              />
            }
          />
        </TabsContent>
      </Tabs>

      {dialog === 'goal' ? (
        <GoalModal cycles={cycles.data ?? []} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'review' ? (
        <StartReviewModal cycles={cycles.data ?? []} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'cycle' ? <CycleModal onClose={() => setDialog(null)} /> : null}
      {editing ? (
        <ReviewWorkspace
          review={editing}
          onClose={() => setEditing(null)}
          onSaved={() => toast({ tone: 'success', title: 'Review saved' })}
        />
      ) : null}
    </div>
  );
}

function UpdateGoalButton({ goal }: { goal: PerformanceGoalRecord }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const update = useHrMutation((body: unknown) => hrApi.updateGoal(goal.id, body));
  const [value, setValue] = useState(goal.currentValue === null ? '' : String(goal.currentValue));
  const [status, setStatus] = useState(goal.status);

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Update
      </Button>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => !o && setOpen(false)}
          title={goal.title}
          description={`${goal.employeeName} · due ${formatIsoDate(goal.dueDate)}`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    {
                      currentValue: value === '' ? null : Number(value),
                      status,
                    },
                    {
                      onSuccess: () => {
                        toast({ tone: 'success', title: 'Goal updated' });
                        setOpen(false);
                      },
                    },
                  )
                }
              >
                Save
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            {goal.measure === 'milestone' || goal.measure === 'binary' ? (
              <p className="text-sm text-secondary">
                This goal is reached or it is not — mark it completed when it is done.
              </p>
            ) : (
              <Field
                label={
                  goal.measure === 'percent'
                    ? 'Progress (%)'
                    : `Current value${goal.unit ? ` (${goal.unit})` : ''}`
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Not recorded"
                />
              </Field>
            )}
            <Field label="Status">
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as typeof status)}
                options={GOAL_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function GoalModal({
  cycles,
  onClose,
}: {
  cycles: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createGoal(body));
  const [form, setForm] = useState({
    employeeId: '',
    cycleId: '',
    title: '',
    category: 'performance',
    measure: 'percent',
    targetValue: '',
    currentValue: '',
    unit: '',
    startDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    description: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const numeric = form.measure === 'numeric';

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Set a goal"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.employeeId || !form.title || !form.dueDate}
            onClick={() =>
              create.mutate(
                {
                  employeeId: form.employeeId,
                  cycleId: form.cycleId || null,
                  title: form.title,
                  description: form.description || null,
                  category: form.category,
                  measure: form.measure,
                  targetValue: form.targetValue ? Number(form.targetValue) : null,
                  currentValue: form.currentValue ? Number(form.currentValue) : null,
                  unit: form.unit || null,
                  startDate: form.startDate,
                  dueDate: form.dueDate,
                  notes: null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Goal set' });
                    onClose();
                  },
                },
              )
            }
          >
            Set goal
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {create.error ? (
          <Alert
            tone="danger"
            title="Not created"
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
        <Field label="Goal">
          <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select
              value={form.category}
              onValueChange={(v) => set('category', v)}
              options={GOAL_CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="How it is measured">
            <Select
              value={form.measure}
              onValueChange={(v) => set('measure', v)}
              options={GOAL_MEASURES.map((m) => ({ value: m, label: m }))}
            />
          </Field>
          {numeric ? (
            <>
              <Field label="Target">
                <Input
                  type="number"
                  step="0.01"
                  value={form.targetValue}
                  onChange={(e) => set('targetValue', e.target.value)}
                />
              </Field>
              <Field label="Unit">
                <Input
                  value={form.unit}
                  onChange={(e) => set('unit', e.target.value)}
                  placeholder="MPG, loads, %"
                />
              </Field>
            </>
          ) : null}
          <Field label="Start">
            <DatePicker
              value={form.startDate}
              onIsoChange={(e) => set('startDate', e)}
            />
          </Field>
          <Field label="Due">
            <DatePicker
              value={form.dueDate}
              onIsoChange={(e) => set('dueDate', e)}
            />
          </Field>
        </div>
        {cycles.length > 0 ? (
          <Field label="Cycle">
            <Select
              value={form.cycleId}
              onValueChange={(v) => set('cycleId', v)}
              placeholder="Not tied to a cycle"
              options={cycles.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
        ) : null}
        <Field label="Description">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function StartReviewModal({
  cycles,
  onClose,
}: {
  cycles: { id: string; name: string; periodStart: string; periodEnd: string }[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createReview(body));
  const [form, setForm] = useState({
    employeeId: '',
    reviewerEmployeeId: '',
    cycleId: '',
    periodStart: '',
    periodEnd: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Start a review"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.employeeId || !form.periodStart || !form.periodEnd}
            onClick={() =>
              create.mutate(
                {
                  employeeId: form.employeeId,
                  reviewerEmployeeId: form.reviewerEmployeeId || null,
                  cycleId: form.cycleId || null,
                  periodStart: form.periodStart,
                  periodEnd: form.periodEnd,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Review opened' });
                    onClose();
                  },
                },
              )
            }
          >
            Open review
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {create.error ? (
          <Alert
            tone="danger"
            title="Not created"
            description={create.error instanceof ApiError ? create.error.message : 'Failed.'}
          />
        ) : null}
        <Field label="Employee">
          <Select
            value={form.employeeId}
            onValueChange={(v) => set('employeeId', v)}
            placeholder="Choose an employee"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        <Field label="Reviewer">
          <Select
            value={form.reviewerEmployeeId}
            onValueChange={(v) => set('reviewerEmployeeId', v)}
            placeholder="Not assigned"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        {cycles.length > 0 ? (
          <Field label="Cycle">
            <Select
              value={form.cycleId}
              onValueChange={(v) => {
                const cycle = cycles.find((c) => c.id === v);
                setForm((p) => ({
                  ...p,
                  cycleId: v,
                  periodStart: cycle?.periodStart ?? p.periodStart,
                  periodEnd: cycle?.periodEnd ?? p.periodEnd,
                }));
              }}
              placeholder="Not tied to a cycle"
              options={cycles.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Period start">
            <DatePicker
              value={form.periodStart}
              onIsoChange={(e) => set('periodStart', e)}
            />
          </Field>
          <Field label="Period end">
            <DatePicker
              value={form.periodEnd}
              onIsoChange={(e) => set('periodEnd', e)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function CycleModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const create = useHrMutation((body: unknown) => hrApi.createCycle(body));
  const [form, setForm] = useState({
    name: '',
    kind: 'annual',
    periodStart: '',
    periodEnd: '',
    reviewsDueOn: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New performance cycle"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.name || !form.periodStart || !form.periodEnd}
            onClick={() =>
              create.mutate(
                { ...form, reviewsDueOn: form.reviewsDueOn || null },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Cycle created' });
                    onClose();
                  },
                },
              )
            }
          >
            Create cycle
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="2026 Annual"
          />
        </Field>
        <Field label="Kind">
          <Select
            value={form.kind}
            onValueChange={(v) => set('kind', v)}
            options={['annual', 'semiannual', 'quarterly', 'custom'].map((v) => ({
              value: v,
              label: v,
            }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Period start">
            <DatePicker
              value={form.periodStart}
              onIsoChange={(e) => set('periodStart', e)}
            />
          </Field>
          <Field label="Period end">
            <DatePicker
              value={form.periodEnd}
              onIsoChange={(e) => set('periodEnd', e)}
            />
          </Field>
        </div>
        <Field label="Reviews due">
          <DatePicker
            value={form.reviewsDueOn}
            onIsoChange={(e) => set('reviewsDueOn', e)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** The review workspace. Full width rather than a cramped modal, because it is written into. */
function ReviewWorkspace({
  review,
  onClose,
  onSaved,
}: {
  review: PerformanceReviewRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const save = useHrMutation((body: unknown) => hrApi.updateReview(review.id, body));
  const move = useHrMutation((body: unknown) => hrApi.changeReviewStatus(review.id, body));
  const [form, setForm] = useState({
    rating: review.rating === null ? '' : String(review.rating),
    summary: review.summary ?? '',
    strengths: review.strengths ?? '',
    developmentAreas: review.developmentAreas ?? '',
    managerFeedback: review.managerFeedback ?? '',
  });
  const [reason, setReason] = useState('');
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const locked = review.status === 'completed';

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${review.employeeName} · ${formatIsoDate(review.periodStart)} to ${formatIsoDate(review.periodEnd)}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {!locked ? (
            <Button
              variant="secondary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    rating: form.rating === '' ? null : Number(form.rating),
                    summary: form.summary || null,
                    strengths: form.strengths || null,
                    developmentAreas: form.developmentAreas || null,
                    managerFeedback: form.managerFeedback || null,
                  },
                  { onSuccess: onSaved },
                )
              }
            >
              Save draft
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={move.isPending}
            onClick={() =>
              move.mutate(
                {
                  status: locked ? 'in_progress' : nextStatus(review.status),
                  reason: reason.trim() || null,
                },
                {
                  onSuccess: (r) => {
                    toast({ tone: 'success', title: `Review ${r.status}` });
                    onClose();
                  },
                },
              )
            }
          >
            {locked ? 'Reopen' : labelFor(nextStatus(review.status))}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {save.error || move.error ? (
          <Alert
            tone="danger"
            title="Refused"
            description={
              (save.error ?? move.error) instanceof ApiError
                ? ((save.error ?? move.error) as ApiError).message
                : 'Something went wrong.'
            }
          />
        ) : null}
        {locked ? (
          <Alert
            tone="warning"
            title="This review is completed"
            description="Reopening it is recorded against the employment record, with your reason."
          />
        ) : null}
        <Field label="Overall rating">
          <Select
            value={form.rating}
            onValueChange={(v) => set('rating', v)}
            placeholder="Not rated"
            options={RATING_SCALE.map((r) => ({
              value: String(r.value),
              label: `${r.value} — ${r.label}`,
            }))}
          />
        </Field>
        <Field label="Summary">
          <Textarea
            rows={3}
            value={form.summary}
            onChange={(e) => set('summary', e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field label="Strengths">
          <Textarea
            rows={2}
            value={form.strengths}
            onChange={(e) => set('strengths', e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field label="Development areas">
          <Textarea
            rows={2}
            value={form.developmentAreas}
            onChange={(e) => set('developmentAreas', e.target.value)}
            disabled={locked}
          />
        </Field>
        <Field label="Manager feedback">
          <Textarea
            rows={2}
            value={form.managerFeedback}
            onChange={(e) => set('managerFeedback', e.target.value)}
            disabled={locked}
          />
        </Field>
        {locked ? (
          <Field label="Reason for reopening (required)">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function nextStatus(current: string): string {
  return (
    {
      draft: 'submitted',
      in_progress: 'submitted',
      submitted: 'acknowledged',
      acknowledged: 'completed',
    }[current] ?? 'submitted'
  );
}

function labelFor(status: string): string {
  return (
    { submitted: 'Submit', acknowledged: 'Acknowledge', completed: 'Complete' }[status] ?? status
  );
}

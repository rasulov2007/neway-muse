import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ClipboardCheck, Plus } from 'lucide-react';
import {
  DEPARTMENT_LABELS,
  ONBOARDING_CASE_LABEL,
  ONBOARDING_CASE_NEXT_ACTION,
  ONBOARDING_CATEGORIES,
  ONBOARDING_ITEM_STATUSES,
  onboardingCaseState,
  onboardingProgress,
  type OnboardingChecklistRecord,
} from '@neway/shared';
import {
  Alert,
  BackButton,
  Badge,
  Button,
  Card,
  DataTable,
  DatePicker,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  createColumns,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import {
  EmployeeContext,
  FactRow,
  HrKpiStrip,
  HrPanel,
  HrStatus,
  ProgressBar,
  type KpiSegment,
} from './components/HrKit';
import { Field } from './RecruitingPage';
import { OnboardingQualificationPanel } from './OnboardingQualificationPanel';
import { hrSearchSchema } from './hr-search';
import {
  hrApi,
  useHrMutation,
  useOnboarding,
  useOnboardingItems,
  useOnboardingList,
  useOnboardingSummary,
} from './useHr';

const col = createColumns<OnboardingChecklistRecord>();

/** Onboarding plans across the workforce. Progress is counted from the items, never stored. */
/**
 * Where the case has got to, in the words people use about it.
 *
 * Derived from the plan and the qualification file on every render, so verifying a document moves
 * the badge without anybody remembering to.
 */
/** How loudly to say it: only the states somebody has to act on are coloured. */
function nextActionTone(state: ReturnType<typeof onboardingCaseState>) {
  if (state === 'rejected') return 'danger' as const;
  if (state === 'missing_documents') return 'warning' as const;
  if (state === 'available' || state === 'ready') return 'success' as const;
  return 'info' as const;
}

function CaseBadge({ row }: { row: OnboardingChecklistRecord }) {
  const state = onboardingCaseState(row);
  return (
    <Badge tone={CASE_TONE[state]} size="sm" title={ONBOARDING_CASE_NEXT_ACTION[state]}>
      {ONBOARDING_CASE_LABEL[state]}
    </Badge>
  );
}

const CASE_TONE: Record<
  ReturnType<typeof onboardingCaseState>,
  'neutral' | 'info' | 'warning' | 'danger' | 'success'
> = {
  new: 'neutral',
  in_progress: 'info',
  missing_documents: 'warning',
  waiting_for_safety: 'info',
  rejected: 'danger',
  ready: 'success',
  available: 'success',
  on_hold: 'neutral',
};

export function OnboardingPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => hrSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const summary = useOnboardingSummary();
  const params = useMemo(
    () => ({
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      status: search.status,
      department: search.department,
      includeFinished: search.includeFinished ? 'true' : undefined,
    }),
    [search],
  );
  const list = useOnboardingList(params);

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
      key: 'all',
      label: 'Onboarding',
      value: s?.active ?? null,
      onSelect: () => update({ status: undefined }),
    },
    { key: 'soon', label: 'Starting soon', value: s?.startingSoon ?? null },
    { key: 'overdue', label: 'Overdue', value: s?.overdue ?? null, tone: 'danger' },
    {
      key: 'blocked',
      label: 'Blocked',
      value: s?.blocked ?? null,
      tone: 'warning',
      onSelect: () => update({ status: 'blocked' }),
    },
    {
      key: 'completed',
      label: 'Completed',
      value: s?.completed ?? null,
      tone: 'success',
      onSelect: () => update({ status: 'completed', includeFinished: '1' }),
    },
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: 'Employee',
          meta: { primary: true, width: 200 },
          cell: ({ row }) => (
            <Link
              to="/hr/onboarding/$checklistId"
              params={{ checklistId: row.original.id }}
              className="font-medium text-primary-text hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.employeeName}
            </Link>
          ),
        }),
        col.accessor('position', { header: 'Role', meta: { width: 150 } }),
        col.display({
          id: 'department',
          header: 'Department',
          meta: { width: 160 },
          cell: ({ row }) => DEPARTMENT_LABELS[row.original.department],
        }),
        col.accessor('startDate', {
          header: 'Start date',
          meta: { width: 110 },
          cell: ({ getValue }) => formatIsoDate(getValue()),
        }),
        col.display({
          id: 'progress',
          header: 'Progress',
          meta: { width: 160 },
          cell: ({ row }) => (
            <ProgressBar
              value={onboardingProgress(row.original.completedItems, row.original.totalItems)}
              label={`${row.original.completedItems}/${row.original.totalItems}`}
            />
          ),
        }),
        col.display({
          id: 'case',
          header: 'Status',
          meta: { width: 170 },
          cell: ({ row }) => <CaseBadge row={row.original} />,
        }),
        col.display({
          id: 'owner',
          header: 'Coordinator',
          meta: { width: 150 },
          cell: ({ row }) =>
            row.original.ownerName ?? <span className="text-faint">Unassigned</span>,
        }),
        col.display({
          id: 'overdue',
          header: 'Overdue items',
          meta: { width: 120, align: 'right' },
          cell: ({ row }) =>
            row.original.overdueItems > 0 ? (
              <span className="font-medium text-danger-text">{row.original.overdueItems}</span>
            ) : (
              <span className="text-faint">—</span>
            ),
        }),
      ]),
    [],
  );

  const page = list.data;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Onboarding"
        description="Everything that has to happen before a new hire can do the job."
      />

      <HrKpiStrip
        segments={segments}
        activeKey={search.status ?? 'all'}
        loading={summary.isPending}
      />

      {list.error ? (
        <Alert
          tone="danger"
          title="Onboarding could not be loaded"
          description={list.error instanceof Error ? list.error.message : 'Unknown error'}
        />
      ) : null}

      <DataTable
        columns={columns}
        data={page?.data ?? []}
        rowKey={(c) => c.id}
        caption="Onboarding plans"
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
        onRowDoubleClick={(c) =>
          void navigate({ to: '/hr/onboarding/$checklistId', params: { checklistId: c.id } })
        }
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (v) => update({ q: v || undefined }),
              placeholder: 'Search employee or ID…',
            }}
            filters={[
              {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: ['not_started', 'in_progress', 'blocked', 'completed', 'cancelled'].map(
                  (v) => ({ value: v, label: v.replace(/_/g, ' ') }),
                ),
              },
            ]}
            values={{ status: search.status }}
            onChange={(k, v) => update({ [k]: v })}
            onClear={() =>
              void navigate({ to: '.', search: {} as Record<string, never>, replace: true })
            }
          >
            {/* Search, filters and the primary action on one row. */}
            <span className="ml-auto flex items-center gap-2">
              <Link
                to="/hr/onboarding/templates"
                className="inline-flex items-center text-sm text-primary-text hover:underline"
              >
                Templates
              </Link>
              {/*
               * A driver is added on the roster, not here: doing it there creates the person, opens
               * the qualification file and the plan in one write, and this board reads the plan.
               * A second driver form would be a second way to make half a driver.
               */}
              <Button variant="secondary" icon={<Plus />} asChild>
                <Link to="/drivers/new">Add driver</Link>
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setCreateOpen(true)}>
                Start onboarding
              </Button>
            </span>
          </FilterBar>
        }
        empty={
          <EmptyState
            icon={<ClipboardCheck />}
            title="No active onboarding plans"
            description="A plan appears here the moment a driver is added on the roster or a candidate is hired. Start onboarding is for an employee who already exists."
            action={
              <Button icon={<Plus />} onClick={() => setCreateOpen(true)}>
                Start onboarding
              </Button>
            }
          />
        }
      />

      {createOpen ? <StartOnboardingModal onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

function StartOnboardingModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createOnboarding(body));
  const [form, setForm] = useState({
    employeeId: '',
    ownerEmployeeId: '',
    startDate: new Date().toISOString().slice(0, 10),
  });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Start onboarding"
      description="The plan is built from the person's role — a driver gets qualification items, an office hire does not."
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
                  ownerEmployeeId: form.ownerEmployeeId || null,
                  startDate: form.startDate,
                  templateId: null,
                  dueDate: null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Onboarding plan created' });
                    onClose();
                  },
                },
              )
            }
          >
            Create plan
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
            onValueChange={(v) => setForm((p) => ({ ...p, employeeId: v }))}
            placeholder={directory.isPending ? 'Loading…' : 'Choose an employee'}
            options={(directory.data ?? []).map((e) => ({
              value: e.id,
              label: e.name,
              description: `${e.employeeNumber} · ${e.position}`,
            }))}
          />
        </Field>
        <Field label="Owner">
          <Select
            value={form.ownerEmployeeId}
            onValueChange={(v) => setForm((p) => ({ ...p, ownerEmployeeId: v }))}
            placeholder="Unassigned"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        <Field label="Start date">
          <DatePicker
            value={form.startDate}
            onIsoChange={(e) => setForm((p) => ({ ...p, startDate: e }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------- the detail

export function OnboardingDetailRoute() {
  const { checklistId } = useParams({ from: '/hr/onboarding/$checklistId' });
  return <OnboardingDetailPage checklistId={checklistId} />;
}

export function OnboardingDetailPage({ checklistId }: { checklistId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const query = useOnboarding(checklistId);
  const items = useOnboardingItems(checklistId);
  const [addOpen, setAddOpen] = useState(false);
  const update = useHrMutation(({ id, body }: { id: string; body: unknown }) =>
    hrApi.updateOnboardingItem(id, body),
  );

  if (query.isPending) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const plan = query.data;
  if (!plan) {
    return (
      <EmptyState
        title="That onboarding plan is not on file"
        action={<Button onClick={() => void navigate({ to: '/hr/onboarding' })}>Back</Button>}
      />
    );
  }

  const progress = onboardingProgress(plan.completedItems, plan.totalItems);
  const grouped = (items.data ?? []).reduce<Record<string, typeof items.data>>((acc, item) => {
    (acc[item.category] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/hr/onboarding" />}
        title={`${plan.employeeName}'s onboarding`}
        description={`${plan.position} · starts ${formatIsoDate(plan.startDate)}`}
        meta={
          <>
            <CaseBadge row={plan} />
            <span className="text-xs text-muted">
              {progress ?? 0}% · {plan.completedItems} of {plan.totalItems} done
            </span>
            {plan.documentsMissing > 0 ? (
              <Badge tone="warning" size="sm">
                {plan.documentsMissing} document{plan.documentsMissing === 1 ? '' : 's'} outstanding
              </Badge>
            ) : null}
            {plan.documentsPending > 0 ? (
              <Badge tone="info" size="sm">
                {plan.documentsPending} with Safety
              </Badge>
            ) : null}
          </>
        }
        actions={
          <Button variant="secondary" icon={<Plus />} onClick={() => setAddOpen(true)}>
            Add item
          </Button>
        }
      />

      {/* What to do next, in one sentence, rather than left for the reader to work out. */}
      <Alert
        tone={nextActionTone(onboardingCaseState(plan))}
        title={ONBOARDING_CASE_LABEL[onboardingCaseState(plan)]}
        description={ONBOARDING_CASE_NEXT_ACTION[onboardingCaseState(plan)]}
      />

      <EmployeeContext
        employeeId={plan.employeeId}
        name={plan.employeeName}
        employeeNumber={plan.employeeNumber}
        position={plan.position}
        department={DEPARTMENT_LABELS[plan.department]}
        trailing={
          <span className="flex items-center gap-3">
            <HrStatus value={plan.status} />
            <ProgressBar value={progress} label={`${plan.completedItems}/${plan.totalItems}`} />
          </span>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex flex-col gap-4">
          {Object.entries(grouped).map(([category, list]) => (
            <Card key={category} className="p-0">
              <h3 className="border-b border-line-soft px-4 py-2.5 text-md font-bold text-ink capitalize">
                {category}
              </h3>
              <ul className="divide-y divide-line-soft">
                {(list ?? []).map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                        {item.title}
                        {item.blocking ? (
                          <Badge
                            tone="warning"
                            size="sm"
                            variant="outline"
                            title="Holds the driver at Hired until done"
                          >
                            blocking
                          </Badge>
                        ) : null}
                        {item.requirementCode ? (
                          <Badge
                            tone="info"
                            size="sm"
                            variant="outline"
                            title="Completes when the qualification file holds the verified document"
                          >
                            from the qualification file
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted">
                        {item.dueDate ? `Due ${formatIsoDate(item.dueDate)}` : 'No due date'}
                        {item.ownerName
                          ? ` · ${item.ownerName}`
                          : item.ownerRole
                            ? ` · owner: ${item.ownerRole}`
                            : ''}
                        {item.completedAt
                          ? ` · completed ${new Date(item.completedAt).toLocaleDateString()}`
                          : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <HrStatus value={item.status} />
                      {item.requirementCode ? null : (
                        <Select
                          value={item.status}
                          onValueChange={(next) =>
                            update.mutate(
                              { id: item.id, body: { status: next } },
                              {
                                onSuccess: () =>
                                  toast({ tone: 'success', title: `${item.title}: ${next}` }),
                              },
                            )
                          }
                          options={ONBOARDING_ITEM_STATUSES.map((s) => ({
                            value: s,
                            label: s.replace(/_/g, ' '),
                          }))}
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {items.data && items.data.length === 0 ? (
            <EmptyState title="No items" description="Add the first item to this plan." />
          ) : null}

          {plan.driverId ? (
            <OnboardingQualificationPanel driverId={plan.driverId} driverName={plan.employeeName} />
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <HrPanel title="Plan">
            <FactRow label="Status" value={<HrStatus value={plan.status} />} />
            <FactRow label="Start date" value={formatIsoDate(plan.startDate)} />
            <FactRow label="Due" value={plan.dueDate ? formatIsoDate(plan.dueDate) : null} />
            <FactRow label="Items" value={`${plan.completedItems} of ${plan.totalItems}`} />
            <FactRow
              label="Blocked"
              value={plan.blockedItems > 0 ? String(plan.blockedItems) : null}
            />
            <FactRow
              label="Overdue"
              value={plan.overdueItems > 0 ? String(plan.overdueItems) : null}
            />
          </HrPanel>
          <p className="text-xs text-faint">
            Progress is counted from the items every time this page loads. It is never stored, so it
            cannot disagree with the checklist above it.
          </p>
        </div>
      </div>

      {addOpen ? <AddItemModal checklistId={plan.id} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function AddItemModal({ checklistId, onClose }: { checklistId: string; onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const add = useHrMutation((body: unknown) => hrApi.addOnboardingItem(checklistId, body));
  const [form, setForm] = useState({
    title: '',
    category: 'paperwork',
    ownerEmployeeId: '',
    dueDate: '',
    notes: '',
  });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add onboarding item"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={add.isPending}
            disabled={!form.title}
            onClick={() =>
              add.mutate(
                {
                  title: form.title,
                  category: form.category,
                  ownerEmployeeId: form.ownerEmployeeId || null,
                  dueDate: form.dueDate || null,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Item added' });
                    onClose();
                  },
                },
              )
            }
          >
            Add item
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Title">
          <Input
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          />
        </Field>
        <Field label="Category">
          <Select
            value={form.category}
            onValueChange={(v) => setForm((p) => ({ ...p, category: v }))}
            options={ONBOARDING_CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
        </Field>
        <Field label="Owner">
          <Select
            value={form.ownerEmployeeId}
            onValueChange={(v) => setForm((p) => ({ ...p, ownerEmployeeId: v }))}
            placeholder="Unassigned"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        <Field label="Due date">
          <DatePicker
            value={form.dueDate}
            onIsoChange={(e) => setForm((p) => ({ ...p, dueDate: e }))}
          />
        </Field>
        <Field label="Notes">
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

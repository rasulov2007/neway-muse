import { Link, useNavigate } from '@tanstack/react-router';
import { Briefcase, CircleCheck, Plus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  APPLICANT_SOURCES,
  APPLICANT_STAGES,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  EMPLOYMENT_TYPES,
  HIRING_STAGE_LABELS,
  JOB_OPENING_TRANSITIONS,
  LEAD_SOURCE_LABELS,
  type ApplicantRecord,
  type HiringState,
  type JobOpeningRecord,
  type JobOpeningStatus,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DatePicker,
  Drawer,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  createColumns,
  type FilterDefinition,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { HrStatus } from './components/HrKit';
import type { HrSearch } from './hr-search';
import { Panel, PanelEmpty, StatCard } from './RecruitingKit';
import { fieldErrors } from './recruiting-kit';
import { hrApi, useCandidates, useHrMutation, useJobOpenings } from './useHr';

/**
 * Recruiting › Openings (owner's redesign, 2026-10-01; no mockup — styled like the others).
 *
 * An opening is a seat to fill. Candidates of either track can be put on one: a driver candidate
 * (a converted lead, moved by their hiring case) or an office-staff candidate (moved by the office
 * stages). The office-staff list below reads only the office track — the server leaves out every
 * candidate who has a driver hiring case, so a driver can never appear among office roles.
 */

const jobCol = createColumns<JobOpeningRecord>();
const candCol = createColumns<ApplicantRecord>();

const STATUS_VIEWS = [
  { value: 'current', label: 'Open & on hold' },
  { value: 'filled', label: 'Filled' },
  { value: 'closed', label: 'Closed & cancelled' },
  { value: 'all', label: 'All' },
] as const;

function inView(job: JobOpeningRecord, view: string): boolean {
  if (view === 'all') return true;
  if (view === 'filled') return job.status === 'filled';
  if (view === 'closed') return job.status === 'closed' || job.status === 'cancelled';
  return job.status === 'open' || job.status === 'on_hold' || job.status === 'draft';
}

const STATUS_ACTION: Record<JobOpeningStatus, string> = {
  draft: 'Back to draft',
  open: 'Open',
  on_hold: 'Put on hold',
  filled: 'Mark filled',
  closed: 'Close',
  cancelled: 'Cancel opening',
};

/** Where a candidate stands: the hiring case for a driver, the office stage for everyone else. */
function standing(c: ApplicantRecord): string {
  return c.hiringState ? (HIRING_STAGE_LABELS[c.hiringState as HiringState] ?? c.hiringState) : c.stage.replace(/_/g, ' ');
}

export function OpeningsTab({ search, update }: { search: HrSearch; update: (patch: Record<string, unknown>) => void }) {
  const jobs = useJobOpenings();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const [creating, setCreating] = useState(false);
  const view = STATUS_VIEWS.some((v) => v.value === search.view) ? (search.view as string) : 'current';
  const rows = (jobs.data ?? []).filter((j) => inView(j, view));
  const live = (jobs.data ?? []).filter((j) => j.status === 'open' || j.status === 'on_hold');
  const loaded = jobs.data !== undefined;
  const selected = (jobs.data ?? []).find((j) => j.id === search.opening) ?? null;

  const columns = useMemo(
    () => [
      jobCol.accessor('title', {
        header: 'Opening',
        meta: { primary: true, width: 260 },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-ink" title={row.original.title}>
              {row.original.title}
            </span>
            <span className="font-mono text-xs text-muted">{row.original.jobNumber}</span>
          </span>
        ),
      }),
      jobCol.accessor('status', { header: 'Status', meta: { width: 110 }, cell: (i) => <HrStatus value={i.getValue()} /> }),
      jobCol.accessor('department', { header: 'Department', meta: { width: 150 }, cell: (i) => DEPARTMENT_LABELS[i.getValue()] }),
      jobCol.accessor('location', {
        header: 'Location',
        meta: { width: 140 },
        cell: (i) => i.getValue() ?? <span className="text-faint">Not set</span>,
      }),
      jobCol.accessor('positionsCount', {
        header: 'Filled',
        meta: { align: 'right', width: 90 },
        cell: ({ row }) => `${row.original.hiredCount} / ${row.original.positionsCount}`,
      }),
      jobCol.accessor('activeCandidates', { header: 'In the running', meta: { align: 'right', width: 120 } }),
      jobCol.accessor('targetHireDate', {
        header: 'Target date',
        meta: { width: 120 },
        cell: (i) => (i.getValue() ? formatIsoDate(i.getValue()) : <span className="text-faint">None</span>),
      }),
      jobCol.accessor('hiringManagerName', {
        header: 'Hiring manager',
        meta: { width: 150 },
        cell: (i) => i.getValue() ?? <span className="text-faint">Not assigned</span>,
      }),
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="openings-tab">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-ink">Openings</h2>
            <p className="text-sm text-muted">Seats to fill, and the candidates being considered for each.</p>
          </div>
          {/* One create button: with no openings yet, the empty state carries it instead. */}
          {canManage && (jobs.data ?? []).length > 0 ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              Add opening
            </Button>
          ) : null}
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Opening figures">
          <StatCard icon={<Briefcase />} label="Open openings" value={loaded ? live.length : null} hint="Open or on hold" />
          <StatCard
            icon={<Users />}
            tone="info"
            label="Seats to fill"
            value={loaded ? live.reduce((n, j) => n + Math.max(0, j.positionsCount - j.hiredCount), 0) : null}
            hint="Positions not yet hired"
          />
          <StatCard
            icon={<UserPlus />}
            tone="violet"
            label="In the running"
            value={loaded ? live.reduce((n, j) => n + j.activeCandidates, 0) : null}
            hint="Assigned candidates still in progress"
          />
          <StatCard
            icon={<CircleCheck />}
            label="Hired"
            value={loaded ? live.reduce((n, j) => n + j.hiredCount, 0) : null}
            hint="On openings still open or on hold"
          />
        </section>

        {jobs.error ? (
          <Alert tone="danger" title="Openings could not be loaded" description={jobs.error instanceof Error ? jobs.error.message : undefined} />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(j) => j.id}
            caption="Openings"
            loading={jobs.isPending}
            onRowClick={(j) => update({ opening: j.id })}
            toolbar={
              <div className="flex flex-wrap gap-1" role="group" aria-label="Which openings">
                {STATUS_VIEWS.map((v) => (
                  <Button
                    key={v.value}
                    size="sm"
                    variant={view === v.value ? 'primary' : 'ghost'}
                    aria-pressed={view === v.value}
                    onClick={() => update({ view: v.value === 'current' ? undefined : v.value })}
                  >
                    {v.label}
                  </Button>
                ))}
              </div>
            }
            empty={
              <EmptyState
                icon={<Briefcase />}
                title={(jobs.data ?? []).length === 0 ? 'No openings yet' : 'No openings in this view'}
                description="An opening groups candidates by the seat they are being considered for — drivers and office staff alike."
                action={
                  canManage && (jobs.data ?? []).length === 0 ? (
                    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                      Add opening
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </div>

      <OfficeCandidates search={search} update={update} jobs={jobs.data ?? []} canManage={canManage} />

      <OpeningDrawer job={selected} canManage={canManage} onClose={() => update({ opening: undefined })} />
      {creating ? <CreateOpeningModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

// ----------------------------------------------------------------------------- opening drawer

function OpeningDrawer({ job, canManage, onClose }: { job: JobOpeningRecord | null; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const assigned = useCandidates(
    job ? { jobOpeningId: job.id, includeClosed: 'true', pageSize: 10_000 } : { jobOpeningId: '__none', pageSize: 1 },
  );
  const pool = useCandidates({ pageSize: 10_000, sort: 'name', sortDir: 'asc' });
  const [pick, setPick] = useState('');
  const setStatus = useHrMutation((status: string) => hrApi.setJobStatus(job?.id ?? '', status));
  const move = useHrMutation((input: { id: string; jobOpeningId: string | null }) =>
    hrApi.updateCandidate(input.id, { jobOpeningId: input.jobOpeningId }),
  );
  const acceptsPeople = job?.status === 'open' || job?.status === 'on_hold';
  // Still in the running: an office candidate not closed (the list leaves those out), or a driver
  // whose case has not ended or already finished.
  const choices = (pool.data?.data ?? []).filter(
    (c) =>
      c.jobOpeningId !== job?.id &&
      !['disqualified', 'withdrawn', 'no_show', 'declined_offer', 'active_driver', 'hired'].includes(c.hiringState ?? ''),
  );
  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(
      () => toast({ tone: 'success', title: ok }),
      (e: unknown) => toast({ tone: 'danger', title: e instanceof ApiError ? e.message : 'Not saved' }),
    );

  return (
    <Drawer
      open={job !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={job?.title ?? 'Opening'}
      description={job ? `${job.jobNumber} · ${DEPARTMENT_LABELS[job.department]}` : undefined}
      headerExtra={job ? <HrStatus value={job.status} /> : null}
      size="lg"
    >
      {job ? (
        <div className="flex flex-col gap-5" data-testid="opening-drawer">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <Fact label="Positions">{job.positionsCount}</Fact>
            <Fact label="Hired">{job.hiredCount}</Fact>
            <Fact label="In the running">{job.activeCandidates}</Fact>
            <Fact label="Location">{job.location ?? 'Not set'}</Fact>
            <Fact label="Employment">{job.employmentType.replace(/_/g, ' ')}</Fact>
            <Fact label="Hiring manager">{job.hiringManagerName ?? 'Not assigned'}</Fact>
            <Fact label="Opened">{formatIsoDate(job.openDate)}</Fact>
            <Fact label="Target hire date">{job.targetHireDate ? formatIsoDate(job.targetHireDate) : 'None'}</Fact>
          </dl>
          {job.notes ? <p className="text-sm whitespace-pre-line text-secondary">{job.notes}</p> : null}

          {canManage && JOB_OPENING_TRANSITIONS[job.status].length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t border-nw-border pt-3">
              {JOB_OPENING_TRANSITIONS[job.status].map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === 'cancelled' ? 'ghost' : 'outline'}
                  loading={setStatus.isPending && setStatus.variables === s}
                  onClick={() => void run(() => setStatus.mutateAsync(s), `${job.jobNumber}: ${s.replace(/_/g, ' ')}`)}
                >
                  {STATUS_ACTION[s]}
                </Button>
              ))}
            </div>
          ) : null}

          <section className="flex flex-col gap-2">
            <h3 className="text-md font-bold text-ink">Candidates on this opening</h3>
            {assigned.isPending ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : (assigned.data?.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">Nobody yet. Assign a candidate below.</p>
            ) : (
              <ul className="divide-y divide-nw-border rounded-[10px] border border-nw-border">
                {(assigned.data?.data ?? []).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Link
                      to="/hr/recruiting/$candidateId"
                      params={{ candidateId: c.id }}
                      className="min-w-0 flex-1 truncate font-semibold text-primary-text hover:underline"
                    >
                      {c.name}
                    </Link>
                    <Badge tone={c.hiringCaseId ? 'info' : 'neutral'} dot>
                      {c.hiringCaseId ? 'Driver' : 'Office'}
                    </Badge>
                    <span className="text-xs text-muted">{standing(c)}</span>
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void run(() => move.mutateAsync({ id: c.id, jobOpeningId: null }), `${c.name} removed from ${job.jobNumber}`)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              acceptsPeople ? (
                <div className="flex flex-wrap items-end gap-2">
                  <FormField
                    label="Assign a candidate"
                    className="min-w-60 flex-1"
                    description={pool.isPending ? 'Loading…' : choices.length === 0 ? 'Every active candidate is already on this opening.' : 'Active candidates of both tracks. A candidate on another opening moves here.'}
                  >
                    <Select
                      aria-label="Candidate to assign"
                      value={pick}
                      onValueChange={setPick}
                      options={[
                        { value: '', label: 'Choose a candidate' },
                        ...choices.map((c) => ({
                          value: c.id,
                          label: `${c.name} · ${c.hiringCaseId ? 'Driver' : 'Office'}${c.jobTitle ? ` · now on ${c.jobTitle}` : ''}`,
                        })),
                      ]}
                    />
                  </FormField>
                  <Button
                    variant="primary"
                    disabled={!pick}
                    title={!pick ? 'Choose a candidate first' : undefined}
                    loading={move.isPending}
                    onClick={() =>
                      void run(() => move.mutateAsync({ id: pick, jobOpeningId: job.id }), `Assigned to ${job.jobNumber}`).then(() => setPick(''))
                    }
                  >
                    Assign
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted">This opening is {job.status.replace(/_/g, ' ')}; reopen it to assign candidates.</p>
              )
            ) : null}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink first-letter:uppercase">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------- office staff

function OfficeCandidates({
  search,
  update,
  jobs,
  canManage,
}: {
  search: HrSearch;
  update: (patch: Record<string, unknown>) => void;
  jobs: JobOpeningRecord[];
  canManage: boolean;
}) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const params = useMemo(
    () => ({
      track: 'office',
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      stage: search.stage,
      department: search.department,
      jobOpeningId: search.job,
      source: search.source,
      includeClosed: search.includeClosed ? 'true' : undefined,
    }),
    [search],
  );
  const candidates = useCandidates(params);
  const filters: FilterDefinition[] = [
    { key: 'stage', label: 'Stage', type: 'select', options: APPLICANT_STAGES.map((v) => ({ value: v, label: v.replace(/_/g, ' ') })) },
    { key: 'department', label: 'Department', type: 'select', options: EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] })) },
    { key: 'source', label: 'Source', type: 'select', options: APPLICANT_SOURCES.map((v) => ({ value: v, label: LEAD_SOURCE_LABELS[v] ?? v })) },
    ...(jobs.length > 0
      ? [{ key: 'job', label: 'Opening', type: 'select' as const, options: jobs.map((j) => ({ value: j.id, label: `${j.jobNumber} ${j.title}` })) }]
      : []),
  ];
  const columns = useMemo(
    () => [
      candCol.display({
        id: 'candidate',
        header: 'Candidate',
        meta: { primary: true, width: 220 },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-ink">{row.original.name}</span>
            <span className="font-mono text-xs text-muted">{row.original.applicantNumber}</span>
          </span>
        ),
      }),
      candCol.accessor('position', { header: 'Position', meta: { width: 160 } }),
      candCol.display({ id: 'department', header: 'Department', meta: { width: 150 }, cell: ({ row }) => DEPARTMENT_LABELS[row.original.department] }),
      candCol.display({ id: 'stage', header: 'Stage', meta: { width: 120 }, cell: ({ row }) => <HrStatus value={row.original.stage} /> }),
      candCol.display({
        id: 'opening',
        header: 'Opening',
        meta: { width: 170 },
        cell: ({ row }) => row.original.jobTitle ?? <span className="text-faint">None</span>,
      }),
      candCol.display({
        id: 'recruiter',
        header: 'Recruiter',
        meta: { width: 150 },
        cell: ({ row }) => row.original.recruiterName ?? <span className="text-faint">Unassigned</span>,
      }),
      candCol.accessor('appliedOn', { header: 'Applied', meta: { width: 110 }, cell: ({ getValue }) => formatIsoDate(getValue()) }),
    ],
    [],
  );
  const page = candidates.data;
  return (
    <Panel
      title="Office-staff candidates"
      description="Dispatchers, accounting and other office roles. Drivers are recruited through Leads and the Pipeline and never appear here."
      actions={
        canManage ? (
          <Button variant="outline" icon={<UserPlus />} onClick={() => setAdding(true)}>
            Add office candidate
          </Button>
        ) : undefined
      }
      bodyClassName="px-0 pb-0"
      testId="office-candidates"
    >
      {candidates.error ? (
        <div className="px-4 pb-4">
          <Alert tone="danger" title="Candidates could not be loaded" description={candidates.error instanceof Error ? candidates.error.message : undefined} />
        </div>
      ) : (
        <DataTable
          className="rounded-none border-x-0 border-b-0"
          columns={columns}
          data={page?.data ?? []}
          rowKey={(c) => c.id}
          caption="Office-staff candidates"
          loading={candidates.isPending}
          serverSide
          total={page?.total ?? 0}
          showColumnChooser={false}
          state={{
            sorting: [],
            pagination: { page: search.page ?? 1, pageSize: search.pageSize ?? 25 },
            rowSelection: {},
            columnVisibility: {},
            globalFilter: '',
          }}
          onStateChange={(next) => {
            if (next.pagination) update({ page: next.pagination.page, pageSize: next.pagination.pageSize });
          }}
          onRowClick={(c) => void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: c.id } })}
          toolbar={
            <FilterBar
              search={{ value: search.q ?? '', onChange: (v) => update({ q: v || undefined }), placeholder: 'Search name, email, phone, candidate ID…' }}
              filters={filters}
              values={{ stage: search.stage, department: search.department, source: search.source, job: search.job }}
              onChange={(k, v) => update({ [k]: v })}
              onClear={() => update({ q: undefined, stage: undefined, department: undefined, source: undefined, job: undefined })}
            />
          }
          empty={
            <PanelEmpty
              icon={<UserPlus />}
              title="No office-staff candidates"
              description="Add one when someone applies for an office role."
              action={
                canManage ? (
                  <Button variant="outline" icon={<UserPlus />} onClick={() => setAdding(true)}>
                    Add office candidate
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}
      {adding ? <AddOfficeCandidateModal jobs={jobs} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddOfficeCandidateModal({ jobs, onClose }: { jobs: JobOpeningRecord[]; onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createCandidate(body));
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    position: '',
    department: 'dispatch',
    jobOpeningId: '',
    source: '',
    assignedRecruiterEmployeeId: '',
    appliedOn: companyToday(),
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(create.error);
  const local: Record<string, string | null> = {
    firstName: form.firstName.trim() ? null : 'First name is required',
    lastName: form.lastName.trim() ? null : 'Last name is required',
    email: /^\S+@\S+\.\S+$/.test(form.email) ? null : 'A valid email is required',
    phone: form.phone.replace(/\D/g, '').length >= 7 ? null : 'A phone number with at least 7 digits',
    position: form.position.trim() ? null : 'A position is required',
    appliedOn: form.appliedOn ? null : 'Choose the date',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  const openJobs = jobs.filter((j) => j.status === 'open' || j.status === 'on_hold');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add office candidate"
      description="For office roles only. Drivers start as a lead (Add lead) and move through the driver pipeline."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              create.mutate(
                {
                  ...form,
                  jobOpeningId: form.jobOpeningId || null,
                  source: form.source || null,
                  assignedRecruiterEmployeeId: form.assignedRecruiterEmployeeId || null,
                },
                {
                  onSuccess: (c) => {
                    toast({ tone: 'success', title: `${(c as ApplicantRecord).name} added as ${(c as ApplicantRecord).applicantNumber}` });
                    onClose();
                  },
                },
              );
            }}
          >
            Add candidate
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {create.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not added" description={create.error instanceof ApiError ? create.error.message : 'Something went wrong.'} />
          </div>
        ) : null}
        <FormField label="First name" required error={err('firstName')}>
          <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </FormField>
        <FormField label="Last name" required error={err('lastName')}>
          <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </FormField>
        <FormField label="Email" required error={err('email')}>
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </FormField>
        <FormField label="Phone" required error={err('phone')}>
          <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </FormField>
        <FormField label="Position" required error={err('position')} description="e.g. Dispatcher, Billing specialist">
          <Input value={form.position} onChange={(e) => set('position', e.target.value)} />
        </FormField>
        <FormField label="Department" error={err('department')}>
          <Select
            aria-label="Department"
            value={form.department}
            onValueChange={(v) => set('department', v)}
            options={EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] }))}
          />
        </FormField>
        <FormField label="Opening" error={err('jobOpeningId')}>
          <Select
            aria-label="Opening"
            value={form.jobOpeningId}
            onValueChange={(v) => set('jobOpeningId', v)}
            options={[{ value: '', label: 'Not tied to an opening' }, ...openJobs.map((j) => ({ value: j.id, label: `${j.jobNumber} ${j.title}` }))]}
          />
        </FormField>
        <FormField label="Source" error={err('source')}>
          <Select
            aria-label="Source"
            value={form.source}
            onValueChange={(v) => set('source', v)}
            options={[{ value: '', label: 'Not recorded' }, ...APPLICANT_SOURCES.map((v) => ({ value: v, label: LEAD_SOURCE_LABELS[v] ?? v }))]}
          />
        </FormField>
        <FormField label="Recruiter" error={err('assignedRecruiterEmployeeId')}>
          <Select
            aria-label="Recruiter"
            value={form.assignedRecruiterEmployeeId}
            onValueChange={(v) => set('assignedRecruiterEmployeeId', v)}
            options={[{ value: '', label: 'Unassigned' }, ...(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))]}
          />
        </FormField>
        <FormField label="Applied on" required error={err('appliedOn')}>
          <DatePicker aria-label="Applied on" value={form.appliedOn} onIsoChange={(e) => set('appliedOn', e)} />
        </FormField>
      </div>
    </Modal>
  );
}

function CreateOpeningModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const create = useHrMutation((body: unknown) => hrApi.createJob(body));
  const [form, setForm] = useState({
    title: '',
    department: 'dispatch',
    location: '',
    employmentType: 'full_time',
    hiringManagerEmployeeId: '',
    openDate: companyToday(),
    targetHireDate: '',
    positionsCount: '1',
    notes: '',
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(create.error);
  const positions = Number(form.positionsCount);
  const local: Record<string, string | null> = {
    title: form.title.trim() ? null : 'A job title is required',
    positionsCount: Number.isInteger(positions) && positions >= 1 && positions <= 500 ? null : 'A whole number from 1 to 500',
    openDate: form.openDate ? null : 'Choose the open date',
    targetHireDate: form.targetHireDate && form.targetHireDate < form.openDate ? 'The target is before the open date' : null,
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add opening"
      description="A seat to fill. Driver and office candidates can both be assigned to it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              create.mutate(
                {
                  ...form,
                  title: form.title.trim(),
                  location: form.location || null,
                  hiringManagerEmployeeId: form.hiringManagerEmployeeId || null,
                  targetHireDate: form.targetHireDate || null,
                  positionsCount: positions,
                  notes: form.notes || null,
                },
                {
                  onSuccess: (j) => {
                    toast({ tone: 'success', title: `${(j as JobOpeningRecord).jobNumber} opened` });
                    onClose();
                  },
                },
              );
            }}
          >
            Add opening
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-testid="opening-form">
        {create.error && Object.keys(server).length === 0 ? (
          <Alert tone="danger" title="Not created" description={create.error instanceof ApiError ? create.error.message : 'Something went wrong.'} />
        ) : null}
        <FormField label="Job title" required error={err('title')} description="e.g. Company driver — OTR, Night dispatcher">
          <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Department" error={err('department')}>
            <Select
              aria-label="Department"
              value={form.department}
              onValueChange={(v) => set('department', v)}
              options={EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] }))}
            />
          </FormField>
          <FormField label="Employment type" error={err('employmentType')}>
            <Select
              aria-label="Employment type"
              value={form.employmentType}
              onValueChange={(v) => set('employmentType', v)}
              options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
            />
          </FormField>
          <FormField label="Location" error={err('location')}>
            <Input value={form.location} onChange={(e) => set('location', e.target.value)} />
          </FormField>
          <FormField label="Positions" required error={err('positionsCount')}>
            <Input type="number" min="1" max="500" value={form.positionsCount} onChange={(e) => set('positionsCount', e.target.value)} />
          </FormField>
          <FormField label="Open date" required error={err('openDate')}>
            <DatePicker aria-label="Open date" value={form.openDate} onIsoChange={(e) => set('openDate', e)} />
          </FormField>
          <FormField label="Target hire date" error={err('targetHireDate')}>
            <DatePicker aria-label="Target hire date" value={form.targetHireDate} onIsoChange={(e) => set('targetHireDate', e)} />
          </FormField>
        </div>
        <FormField label="Hiring manager" error={err('hiringManagerEmployeeId')}>
          <Select
            aria-label="Hiring manager"
            value={form.hiringManagerEmployeeId}
            onValueChange={(v) => set('hiringManagerEmployeeId', v)}
            options={[{ value: '', label: 'Not assigned' }, ...(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))]}
          />
        </FormField>
        <FormField label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

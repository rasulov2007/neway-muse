import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { CalendarPlus, FileText, UserCheck } from 'lucide-react';
import {
  ACTIVE_APPLICANT_STAGES,
  APPLICANT_STAGES,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  EMPLOYMENT_TYPES,
  INTERVIEW_KINDS,
  INTERVIEW_RECOMMENDATIONS,
  OFFER_STATUSES,
  PAY_TYPES,
} from '@neway/shared';
import {
  Alert,
  BackButton,
  Button,
  Card,
  DatePicker,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  Textarea,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { FactRow, HrPanel, HrStatus } from './components/HrKit';
import { Field } from './RecruitingPage';
import { hrApi, useCandidate, useHrMutation, useInterviews, useOffers } from './useHr';
import { useHiringCaseForApplicant } from './useHiring';
import { RecruitCandidatePage } from './recruit/RecruitCandidatePage';

export function CandidateDetailRoute() {
  const { candidateId } = useParams({ from: '/hr/recruiting/$candidateId' });
  // A lead that is not a candidate yet opens on its lead id (owner's redesign, 2026-10-08).
  if (candidateId.startsWith('lead_')) return <RecruitCandidatePage candidateKey={candidateId} />;
  return <CandidateDetailPage candidateId={candidateId} />;
}

/**
 * The candidate workspace.
 *
 * Hiring is the only action here that creates a person, so it is a deliberate dialog with its own
 * form rather than a stage in the dropdown — and once it has happened the candidate record becomes
 * read-only and links to the employee it produced.
 *
 * A driver candidate — one with a hiring case — opens DriverCandidateProfile instead.
 * Their record shows the funnel state, the DOT application, and the link into the qualification
 * file; the generic stage, interview and offer actions are for office roles.
 */
export function CandidateDetailPage({ candidateId }: { candidateId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const query = useCandidate(candidateId);
  const interviews = useInterviews(candidateId);
  const offers = useOffers(candidateId);
  const hiringCase = useHiringCaseForApplicant(candidateId);
  const [tab, setTab] = useState('overview');
  const [dialog, setDialog] = useState<'interview' | 'offer' | 'hire' | 'stage' | null>(null);

  const moveStage = useHrMutation((body: unknown) => hrApi.moveStage(candidateId, body));

  if (query.isPending || hiringCase.isPending) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const candidate = query.data;
  if (!candidate) {
    return (
      <EmptyState
        title="That candidate is not on file"
        description="They may have been removed, or the link may be out of date."
        action={<Button onClick={() => void navigate({ to: '/hr/recruiting' })}>Back</Button>}
      />
    );
  }

  const driverCase = hiringCase.data ?? null;
  const inPipeline = ACTIVE_APPLICANT_STAGES.includes(candidate.stage) && driverCase === null;

  // A driver candidate opens the recruiting candidate page: application, notes, documents, and
  // offer, onboarding, costs and activity under More (owner's redesign, 2026-10-08).
  if (driverCase) return <RecruitCandidatePage candidateKey={candidateId} applicant={candidate} hiringCase={driverCase} />;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/hr/recruiting" />}
        title={candidate.name}
        description={`${candidate.applicantNumber} · ${candidate.position} · ${DEPARTMENT_LABELS[candidate.department]}`}
        actions={
          inPipeline ? (
            <>
              <Button variant="secondary" onClick={() => setDialog('stage')}>
                Move stage
              </Button>
              <Button
                variant="secondary"
                icon={<CalendarPlus />}
                onClick={() => setDialog('interview')}
              >
                Schedule interview
              </Button>
              <Button variant="secondary" icon={<FileText />} onClick={() => setDialog('offer')}>
                Create offer
              </Button>
              <Button variant="primary" icon={<UserCheck />} onClick={() => setDialog('hire')}>
                Hire
              </Button>
            </>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <HrStatus value={candidate.stage} />
        {candidate.hiredEmployeeId ? (
          <Link
            to="/hr/employees/$employeeId"
            params={{ employeeId: candidate.hiredEmployeeId }}
            className="text-sm text-primary-text hover:underline"
          >
            Open their employee record
          </Link>
        ) : null}
        {candidate.closedReason ? (
          <span className="text-sm text-muted">{candidate.closedReason}</span>
        ) : null}
      </div>

      {candidate.hiredEmployeeId ? (
        <Alert
          tone="success"
          title={`Hired on ${formatIsoDate(candidate.hiredOn ?? '')}`}
          description="This candidate became an employee. The person exists once — this record links to it rather than holding a second copy."
        />
      ) : null}

      <Tabs
        items={
          [
                { value: 'overview', label: 'Overview' },
                { value: 'interviews', label: `Interviews (${interviews.data?.length ?? 0})` },
                { value: 'offers', label: `Offers (${offers.data?.length ?? 0})` },
              ]
        }
        value={tab}
        onValueChange={setTab}
        aria-label="Candidate"
      >
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <HrPanel title="Application">
              <FactRow label="Candidate ID" value={candidate.applicantNumber} />
              <FactRow label="Position" value={candidate.position} />
              <FactRow label="Department" value={DEPARTMENT_LABELS[candidate.department]} />
              <FactRow label="Opening" value={candidate.jobTitle} />
              <FactRow label="Applied" value={formatIsoDate(candidate.appliedOn)} />
              <FactRow label="Source" value={candidate.source?.replace(/_/g, ' ')} />
              <FactRow label="Driver type" value={candidate.driverType?.replace(/_/g, ' ')} />
              <FactRow label="Recruiter" value={candidate.recruiterName} />
            </HrPanel>
            <HrPanel title="Contact">
              <FactRow label="Email" value={candidate.email} />
              <FactRow label="Phone" value={candidate.phone} />
              <FactRow label="Location" value={candidate.location} />
              {candidate.notes ? (
                <p className="mt-3 border-t border-line-soft pt-3 text-sm whitespace-pre-wrap text-secondary">
                  {candidate.notes}
                </p>
              ) : null}
            </HrPanel>
          </div>
        </TabsContent>

        <TabsContent value="interviews" className="pt-4">
          {interviews.data && interviews.data.length > 0 ? (
            <Card className="divide-y divide-line-soft p-0">
              {interviews.data.map((iv) => (
                <div key={iv.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">
                      {iv.kind.replace(/_/g, ' ')} · {new Date(iv.scheduledAt).toLocaleString()}
                    </span>
                    <span className="block text-xs text-muted">
                      {iv.interviewerName ?? 'No interviewer set'}
                      {iv.location ? ` · ${iv.location}` : ''}
                      {iv.score !== null ? ` · scored ${iv.score}/5` : ''}
                      {iv.recommendation ? ` · ${iv.recommendation}` : ''}
                    </span>
                    {iv.notes ? (
                      <span className="mt-1 block text-xs text-secondary">{iv.notes}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <HrStatus value={iv.status} />
                    {iv.status === 'scheduled' ? <OutcomeButton interviewId={iv.id} /> : null}
                  </span>
                </div>
              ))}
            </Card>
          ) : (
            <EmptyState
              title="No interviews scheduled"
              description="Scheduling one moves this candidate into the interview stage."
            />
          )}
        </TabsContent>

        <TabsContent value="offers" className="pt-4">
          {offers.data && offers.data.length > 0 ? (
            <Card className="divide-y divide-line-soft p-0">
              {offers.data.map((offer) => (
                <div
                  key={offer.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">
                      {offer.offerNumber} · {offer.position}
                    </span>
                    <span className="block text-xs text-muted">
                      Starts {formatIsoDate(offer.startDate)}
                      {offer.expiresOn ? ` · expires ${formatIsoDate(offer.expiresOn)}` : ''}
                      {offer.payRate !== null
                        ? ` · ${offer.payRate.toLocaleString(undefined, { style: 'currency', currency: 'USD' })} ${offer.payType ?? ''}`
                        : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <HrStatus value={offer.status} />
                    <OfferActions offerId={offer.id} status={offer.status} />
                  </span>
                </div>
              ))}
            </Card>
          ) : (
            <EmptyState
              title="No offers"
              description="An offer records what was put to the candidate."
            />
          )}
        </TabsContent>
      </Tabs>

      {dialog === 'stage' ? (
        <MoveStageModal
          current={candidate.stage}
          pending={moveStage.isPending}
          error={moveStage.error}
          onSubmit={(body) =>
            moveStage.mutate(body, {
              onSuccess: (c) => {
                toast({ tone: 'success', title: `Moved to ${c.stage}` });
                setDialog(null);
              },
            })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'interview' ? (
        <ScheduleInterviewModal candidateId={candidateId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'offer' ? (
        <CreateOfferModal candidate={candidate} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'hire' ? (
        <HireModal candidate={candidate} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}



function OutcomeButton({ interviewId }: { interviewId: string }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const record = useHrMutation((body: unknown) => hrApi.recordInterviewOutcome(interviewId, body));
  const [form, setForm] = useState({
    status: 'completed',
    score: '',
    recommendation: '',
    notes: '',
  });

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Record outcome
      </Button>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => !o && setOpen(false)}
          title="Record interview outcome"
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                loading={record.isPending}
                onClick={() =>
                  record.mutate(
                    {
                      status: form.status,
                      score: form.score ? Number(form.score) : null,
                      recommendation: form.recommendation || null,
                      notes: form.notes || null,
                    },
                    {
                      onSuccess: () => {
                        toast({ tone: 'success', title: 'Outcome recorded' });
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
            <Field label="Outcome">
              <Select
                value={form.status}
                onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}
                options={['completed', 'cancelled', 'no_show'].map((v) => ({
                  value: v,
                  label: v.replace(/_/g, ' '),
                }))}
              />
            </Field>
            <Field label="Score (1–5, optional)">
              <Input
                type="number"
                min="1"
                max="5"
                value={form.score}
                onChange={(e) => setForm((p) => ({ ...p, score: e.target.value }))}
              />
            </Field>
            <Field label="Recommendation">
              <Select
                value={form.recommendation}
                onValueChange={(v) => setForm((p) => ({ ...p, recommendation: v }))}
                placeholder="Not given"
                options={INTERVIEW_RECOMMENDATIONS.map((v) => ({ value: v, label: v }))}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                rows={3}
                value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function OfferActions({ offerId, status }: { offerId: string; status: string }) {
  const { toast } = useToast();
  const move = useHrMutation((next: string) => hrApi.setOfferStatus(offerId, next));
  const next = (OFFER_STATUSES as readonly string[]).filter((s) => {
    if (status === 'draft') return s === 'sent' || s === 'cancelled';
    if (status === 'sent') return s === 'accepted' || s === 'declined' || s === 'cancelled';
    return false;
  });
  if (next.length === 0) return null;
  return (
    <span className="flex gap-1">
      {next.map((s) => (
        <Button
          key={s}
          variant="ghost"
          loading={move.isPending}
          onClick={() =>
            move.mutate(s, { onSuccess: () => toast({ tone: 'success', title: `Offer ${s}` }) })
          }
        >
          {s}
        </Button>
      ))}
    </span>
  );
}

function MoveStageModal({
  current,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  current: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: { stage: string; reason: string | null }) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState(current);
  const [reason, setReason] = useState('');
  const closing = stage === 'rejected' || stage === 'withdrawn';

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Move stage"
      description="Hiring is not here: it creates an employee, so it has its own action."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={pending}
            disabled={stage === current || (closing && !reason.trim())}
            onClick={() => onSubmit({ stage, reason: reason.trim() || null })}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error ? (
          <Alert
            tone="danger"
            title="Refused"
            description={error instanceof ApiError ? error.message : 'Something went wrong.'}
          />
        ) : null}
        <Field label="Stage">
          <Select
            value={stage}
            onValueChange={setStage}
            options={APPLICANT_STAGES.filter((s) => s !== 'hired').map((s) => ({
              value: s,
              label: s.replace(/_/g, ' '),
            }))}
          />
        </Field>
        <Field label={closing ? 'Reason (required)' : 'Reason (optional)'}>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ScheduleInterviewModal({
  candidateId,
  onClose,
}: {
  candidateId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const schedule = useHrMutation((body: unknown) => hrApi.scheduleInterview(candidateId, body));
  const [form, setForm] = useState({
    kind: 'in_person',
    scheduledAt: '',
    interviewerEmployeeId: '',
    location: '',
    notes: '',
  });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Schedule interview"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={schedule.isPending}
            disabled={!form.scheduledAt}
            onClick={() =>
              schedule.mutate(
                {
                  kind: form.kind,
                  scheduledAt: new Date(form.scheduledAt).toISOString(),
                  interviewerEmployeeId: form.interviewerEmployeeId || null,
                  location: form.location || null,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Interview scheduled' });
                    onClose();
                  },
                },
              )
            }
          >
            Schedule
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {schedule.error ? (
          <Alert
            tone="danger"
            title="Not scheduled"
            description={schedule.error instanceof ApiError ? schedule.error.message : 'Failed.'}
          />
        ) : null}
        <Field label="Kind">
          <Select
            value={form.kind}
            onValueChange={(v) => setForm((p) => ({ ...p, kind: v }))}
            options={INTERVIEW_KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
          />
        </Field>
        <Field label="Date and time">
          <Input
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm((p) => ({ ...p, scheduledAt: e.target.value }))}
          />
        </Field>
        <Field label="Interviewer">
          <Select
            value={form.interviewerEmployeeId}
            onValueChange={(v) => setForm((p) => ({ ...p, interviewerEmployeeId: v }))}
            placeholder="Not assigned"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        <Field label="Location or link">
          <Input
            value={form.location}
            onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

function CreateOfferModal({
  candidate,
  onClose,
}: {
  candidate: { id: string; position: string; department: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useHrMutation((body: unknown) => hrApi.createOffer(candidate.id, body));
  const [form, setForm] = useState({
    position: candidate.position,
    department: candidate.department,
    employmentType: 'full_time',
    payType: '',
    payRate: '',
    startDate: '',
    expiresOn: '',
  });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create offer"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!form.startDate}
            onClick={() =>
              create.mutate(
                {
                  ...form,
                  payType: form.payType || null,
                  payRate: form.payRate ? Number(form.payRate) : null,
                  expiresOn: form.expiresOn || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Offer drafted' });
                    onClose();
                  },
                },
              )
            }
          >
            Create offer
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {create.error ? (
          <div className="sm:col-span-2">
            <Alert
              tone="danger"
              title="Not created"
              description={create.error instanceof ApiError ? create.error.message : 'Failed.'}
            />
          </div>
        ) : null}
        <Field label="Position">
          <Input value={form.position} onChange={(e) => set('position', e.target.value)} />
        </Field>
        <Field label="Employment type">
          <Select
            value={form.employmentType}
            onValueChange={(v) => set('employmentType', v)}
            options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
          />
        </Field>
        <Field label="Pay type">
          <Select
            value={form.payType}
            onValueChange={(v) => set('payType', v)}
            placeholder="Not stated"
            options={PAY_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </Field>
        <Field label="Rate">
          <Input
            type="number"
            value={form.payRate}
            onChange={(e) => set('payRate', e.target.value)}
          />
        </Field>
        <Field label="Start date">
          <DatePicker
            value={form.startDate}
            onIsoChange={(e) => set('startDate', e)}
          />
        </Field>
        <Field label="Expires on">
          <DatePicker
            value={form.expiresOn}
            onIsoChange={(e) => set('expiresOn', e)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * The hire.
 *
 * The one action in this product that creates a person. It is deliberately explicit about what it
 * is about to do, and the server refuses it if this candidate has been hired before or if anybody
 * already holds their email as a work address.
 */
function HireModal({
  candidate,
  onClose,
}: {
  candidate: { id: string; name: string; position: string; department: string; email: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const directory = useEmployeeDirectory();
  const hire = useHrMutation((body: unknown) => hrApi.hire(candidate.id, body));
  const [form, setForm] = useState({
    hireDate: new Date().toISOString().slice(0, 10),
    position: candidate.position,
    department: candidate.department,
    employmentType: 'full_time',
    managerEmployeeId: '',
    location: '',
    payType: '',
    payRate: '',
    startOnboarding: true,
  });
  const set = (k: string, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Hire ${candidate.name}`}
      size="lg"
      description="This creates their employee record. The candidate is linked to it, not copied into it — the person will exist exactly once."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={hire.isPending}
            onClick={() =>
              hire.mutate(
                {
                  hireDate: form.hireDate,
                  position: form.position,
                  department: form.department,
                  employmentType: form.employmentType,
                  managerEmployeeId: form.managerEmployeeId || null,
                  location: form.location || null,
                  payType: form.payType || null,
                  payRate: form.payRate ? Number(form.payRate) : null,
                  startOnboarding: form.startOnboarding,
                  onboardingTemplateId: null,
                },
                {
                  onSuccess: (result) => {
                    toast({
                      tone: 'success',
                      title: `${candidate.name} is now ${result.employeeNumber}`,
                      description: result.onboardingChecklistId
                        ? 'Their onboarding plan has been created.'
                        : undefined,
                    });
                    onClose();
                    void navigate({
                      to: '/hr/employees/$employeeId',
                      params: { employeeId: result.employeeId },
                    });
                  },
                },
              )
            }
          >
            Hire and create employee
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {hire.error ? (
          <div className="sm:col-span-2">
            <Alert
              tone="danger"
              title="Not hired"
              description={
                hire.error instanceof ApiError ? hire.error.message : 'Something went wrong.'
              }
            />
          </div>
        ) : null}
        <Field label="Hire date">
          <DatePicker
            value={form.hireDate}
            onIsoChange={(e) => set('hireDate', e)}
          />
        </Field>
        <Field label="Position">
          <Input value={form.position} onChange={(e) => set('position', e.target.value)} />
        </Field>
        <Field label="Department">
          <Select
            value={form.department}
            onValueChange={(v) => set('department', v)}
            options={EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] }))}
          />
        </Field>
        <Field label="Employment type">
          <Select
            value={form.employmentType}
            onValueChange={(v) => set('employmentType', v)}
            options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
          />
        </Field>
        <Field label="Manager">
          <Select
            value={form.managerEmployeeId}
            onValueChange={(v) => set('managerEmployeeId', v)}
            placeholder="No manager"
            options={(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Pay type">
          <Select
            value={form.payType}
            onValueChange={(v) => set('payType', v)}
            placeholder="Not recorded"
            options={PAY_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </Field>
        <Field label="Rate">
          <Input
            type="number"
            value={form.payRate}
            onChange={(e) => set('payRate', e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={form.startOnboarding}
            onChange={(e) => set('startOnboarding', e.target.checked)}
          />
          <span className="text-ink">
            Create their onboarding plan now
            <span className="ml-1 text-xs text-muted">
              (role-aware: a driver gets qualification items, an office hire does not)
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

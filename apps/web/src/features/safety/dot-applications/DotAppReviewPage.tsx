import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Check, FileText, MessageSquareReply, Save, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  DOT_APP_EMPLOYER_SIGNATURES,
  DOT_APP_STEP_TITLES,
  DOT_APP_UPLOAD_LABELS,
  dotAppUploadSlots,
  dotAppVisibleSteps,
  signatureLabel,
  type DotAppSafetyDetail,
  type DotAppSummary,
} from '@neway/shared';
import { Alert, Button, Checkbox, FormField, Modal, PageHeader, Tabs, TabsContent, Textarea, Timeline, useToast } from '@/design-system';
import { PermissionGate } from '@/features/admin/components/AdminKit';
import { useHasPermission, usePermissionCheck } from '@/features/admin/useAdmin';
import { AnswersSummary, BankRow, SsnRow } from '@/features/dot-application/AnswersSummary';
import { dotAppSafetyApi, dotAppUrls, useSafetyDotApp, useSafetyDotApps, useSafetyMutation } from '@/features/dot-application/api';
import { DotAppStatusBadge, EmailStatusBadge, FamilyBadge, driverNumber } from '@/features/dot-application/status';
import { DocRow } from '@/features/hr/recruit/journey/JourneyKit';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';
import { longDate, longDateTime } from '@/features/hr/recruit/recruit-format';
import { EmployerFormsTab } from './EmployerFormsTab';
import { Checklist, Panel, SignatureThumb } from './kit';
import { OnboardingHireTab } from './OnboardingHireTab';

export const SAFETY_REVIEW_PERMISSION = 'compliance.manage';

function Gate({ children }: { children: ReactNode }) {
  const check = usePermissionCheck(SAFETY_REVIEW_PERMISSION);
  return (
    <PermissionGate check={check} permission={SAFETY_REVIEW_PERMISSION} what="driver applications">
      {children}
    </PermissionGate>
  );
}

// ================================================================================== the queue

export function DotAppQueuePage() {
  return (
    <Gate>
      <DotAppQueue />
    </Gate>
  );
}

/** Safety → Applications review: every DOT application v2 the company's drivers submitted. */
export function DotAppQueue() {
  const q = useSafetyDotApps();
  return (
    <div className="flex flex-col gap-5" data-testid="dot-app-queue">
      <PageHeader title="Applications review" description="DOT driver applications the drivers submitted. Open one to read it, complete the carrier's forms, approve it and hire the driver." />
      <section className="overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel">
        {q.isPending ? (
          <p className="px-5 py-6 text-sm text-nw-text-3">Loading…</p>
        ) : q.isError ? (
          <p className="px-5 py-6 text-sm text-nw-urgent-text">The list could not be loaded. {errorText(q.error)}</p>
        ) : q.data.length === 0 ? (
          <p className="px-5 py-6 text-sm text-nw-text-3">No submitted applications yet.</p>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table" data-testid="dot-app-queue-table">
              <thead>
                <tr className="border-b border-nw-border text-left text-xs font-semibold tracking-wide text-nw-text-3 uppercase">
                  <th className="px-5 py-3">Driver</th>
                  <th className="px-3 py-3">Reserved ID</th>
                  <th className="px-3 py-3">Position</th>
                  <th className="px-3 py-3">Submitted</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((a) => (
                  <QueueRow key={a.id} app={a} />
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-nw-border md:hidden">
              {q.data.map((a) => (
                <li key={a.id}>
                  <Link to="/safety/applications/$applicationId" params={{ applicationId: a.id }} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-nw-subtle">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-nw-text">{a.candidateName}</span>
                      <DotAppStatusBadge status={a.status} />
                    </span>
                    <span className="text-xs text-nw-text-3">
                      {driverNumber(a.driverId)} · {a.position ?? 'Position not given'} · submitted {longDate(a.submittedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function QueueRow({ app: a }: { app: DotAppSummary }) {
  const navigate = useNavigate();
  const open = () => void navigate({ to: '/safety/applications/$applicationId', params: { applicationId: a.id } });
  return (
    <tr className="cursor-pointer border-b border-nw-border last:border-0 hover:bg-nw-subtle" onClick={open} data-testid="dot-app-queue-row">
      <td className="px-5 py-3">
        <Link to="/safety/applications/$applicationId" params={{ applicationId: a.id }} className="font-semibold text-nw-text hover:underline" onClick={(e) => e.stopPropagation()}>
          {a.candidateName}
        </Link>
      </td>
      <td className="px-3 py-3 font-mono text-nw-text-2">{driverNumber(a.driverId)}</td>
      <td className="px-3 py-3 text-nw-text-2">{a.position ?? '—'}</td>
      <td className="px-3 py-3 text-nw-text-2">{longDateTime(a.submittedAt)}</td>
      <td className="px-5 py-3">
        <DotAppStatusBadge status={a.status} />
      </td>
    </tr>
  );
}

// ================================================================================== one application

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'answers', label: 'Answers' },
  { value: 'uploads', label: 'Uploads' },
  { value: 'signatures', label: 'Signatures' },
  { value: 'employer', label: 'Employer forms' },
  { value: 'onboarding', label: 'Onboarding & hire' },
  { value: 'audit', label: 'Notes & audit' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export function DotAppReviewPage({ applicationId }: { applicationId: string }) {
  return (
    <Gate>
      <DotAppReview applicationId={applicationId} />
    </Gate>
  );
}

export function DotAppReview({ applicationId }: { applicationId: string }) {
  const q = useSafetyDotApp(applicationId);
  const raw = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const tab: Tab = TABS.some((t) => t.value === raw.tab) ? (raw.tab as Tab) : 'overview';
  const [reloads, setReloads] = useState(0);
  const back = (
    <Link to="/safety/applications" className="inline-flex items-center gap-1.5 text-sm font-semibold text-nw-accent-ink hover:underline">
      <ArrowLeft aria-hidden className="size-4" /> Applications
    </Link>
  );
  if (q.isPending) return <p className="text-sm text-nw-text-3">Loading…</p>;
  if (q.isError) return <Alert tone="danger" title="The application could not be loaded" description={errorText(q.error)} />;
  const d = q.data;
  const reload = () => void q.refetch().then(() => setReloads((n) => n + 1));
  const decided = ['approved', 'hired'].includes(d.status);
  return (
    <div className="flex flex-col gap-5" data-testid="dot-app-review">
      <PageHeader
        back={back}
        title={d.candidateName}
        description={`${d.company.name} · ${d.position ?? 'Position not given'} · reserved ${driverNumber(d.driverId)}`}
        meta={
          <div className="flex flex-wrap items-center gap-2" data-testid="dot-app-header-pills">
            {d.submittedAt ? <FamilyBadge family="info" testId="pill-submitted">Driver submitted {longDate(d.submittedAt)}</FamilyBadge> : null}
            {decided && d.approvedAt ? <FamilyBadge family="done" testId="pill-approved">Safety approved {longDate(d.approvedAt)}</FamilyBadge> : null}
            <DotAppStatusBadge status={d.status} />
          </div>
        }
      />
      <Tabs
        items={TABS.map((t) => ({ ...t }))}
        value={tab}
        onValueChange={(v) => void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, tab: v === 'overview' ? undefined : v })) as never, replace: true })}
        aria-label="Application sections"
      >
        <div className="pt-5">
          <TabsContent value="overview">
            <OverviewTab detail={d} />
          </TabsContent>
          <TabsContent value="answers">
            <AnswersTab detail={d} />
          </TabsContent>
          <TabsContent value="uploads">
            <UploadsTab detail={d} />
          </TabsContent>
          <TabsContent value="signatures">
            <SignaturesTab detail={d} />
          </TabsContent>
          <TabsContent value="employer">
            <EmployerFormsTab key={`emp-${reloads}`} detail={d} onReload={reload} />
          </TabsContent>
          <TabsContent value="onboarding">
            <OnboardingHireTab key={`onb-${reloads}`} detail={d} onReload={reload} />
          </TabsContent>
          <TabsContent value="audit">
            <AuditTab detail={d} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------------- overview

/** Answers Safety looks at first (the prototype's "Driver flags from answers"). */
export function driverFlags(d: DotAppSafetyDetail): { label: string; value: string | undefined }[] {
  const a = d.answers;
  return [
    { label: 'Currently disqualified (391.15)', value: a.fmcsr?.disqualified },
    { label: 'License ever suspended / revoked', value: a.fmcsr?.suspended },
    { label: 'Pre-employment positive / refusal (2 years)', value: a.fmcsr?.preEmpPositive },
    { label: 'Pre-employment positive / refusal (3 years, §40.25(j))', value: a.prevda?.q1 },
    { label: 'Convicted of listed offenses (3 years)', value: a.fmcsr?.convicted },
    { label: 'Accidents (5 years)', value: a.accidents?.any },
    { label: 'Violations (3 years)', value: a.violations?.any },
    { label: 'Currently driving for another carrier', value: a.otherwork?.q1 },
  ];
}

const CONSENT_LABEL: Record<string, string> = { psp: 'PSP', mvr: 'MVR (FCRA)', clearinghouse: 'Clearinghouse limited query' };

function OverviewTab({ detail: d }: { detail: DotAppSafetyDetail }) {
  const { toast } = useToast();
  const [note, setNote] = useState(d.internalNote ?? '');
  const [changes, setChanges] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const saveNote = useSafetyMutation(d.id, (n: string) => dotAppSafetyApi.note(d.id, n));
  const approve = useSafetyMutation(d.id, (n: string) => dotAppSafetyApi.approve(d.id, n || undefined));
  const empDone = d.employerChecklist.filter((x) => x.done).length;
  const allEmp = empDone === d.employerChecklist.length;
  const reviewable = ['submitted', 'under_review'].includes(d.status);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]" data-testid="dot-app-overview">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Linked consent records" description="Signed in the Consent Form; not signed again in the application.">
          {d.consentLinks.length === 0 ? (
            <p className="text-sm text-nw-text-3">No consent records are linked.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-nw-border">
              {d.consentLinks.map((c) => (
                <li key={c.link} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-nw-text">
                    {CONSENT_LABEL[c.link] ?? c.link} — {c.title} <span className="text-nw-text-3">· version {c.version}</span>
                  </span>
                  <FamilyBadge family="done">Signed {longDate(c.signedAt)}</FamilyBadge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Driver flags from answers">
          <ul className="flex flex-col divide-y divide-nw-border" data-testid="driver-flags">
            {driverFlags(d).map((f) => (
              <li key={f.label} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="text-nw-text">{f.label}</span>
                {f.value === 'Yes' ? <FamilyBadge family="warning">Yes</FamilyBadge> : <FamilyBadge family="neutral">{f.value || 'Not answered'}</FamilyBadge>}
              </li>
            ))}
          </ul>
        </Panel>
        {d.missing.length > 0 ? (
          <Panel title={`Still missing (${d.missing.length})`} description="Request changes from the driver to complete these.">
            <ul className="list-disc pl-5 text-sm text-nw-text-2">
              {d.missing.slice(0, 30).map((m) => (
                <li key={`${m.step}-${m.key}`}>
                  {DOT_APP_STEP_TITLES[m.step]}: {m.label}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
      <Panel title="Decision" description={`Employer forms ${empDone}/${d.employerChecklist.length} complete`} testId="decision-panel" className="h-fit">
        <div className="flex flex-col gap-3">
          {d.status === 'rejected' ? <Alert tone="danger" title="Rejected" description={d.rejectedReason ?? undefined} /> : null}
          {d.status === 'approved' || d.status === 'hired' ? <Alert tone="success" title={`Safety approved ${longDateTime(d.approvedAt)}`} description={d.status === 'hired' ? `Hired ${longDateTime(d.hiredAt)}.` : 'Onboarding & hire is open.'} /> : null}
          {d.status === 'changes_requested' ? <Alert tone="warning" title="Changes requested" description="Waiting for the driver to correct and submit again." /> : null}
          <FormField label="Review note (internal)" description="Visible to Safety only">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="review-note" />
          </FormField>
          <Button
            variant="outline"
            size="sm"
            icon={<Save />}
            className="w-fit"
            disabled={note === (d.internalNote ?? '')}
            loading={saveNote.isPending}
            onClick={() => saveNote.mutate(note, { onSuccess: () => toast({ tone: 'success', title: 'Note saved' }), onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }) })}
          >
            Save note
          </Button>
          {reviewable ? (
            <div className="flex flex-col gap-2 border-t border-nw-border pt-3">
              <Button
                variant="primary"
                icon={<Check />}
                disabled={!allEmp}
                loading={approve.isPending}
                data-testid="dot-app-approve"
                onClick={() => approve.mutate(note, { onSuccess: () => toast({ tone: 'success', title: 'Application approved' }), onError: (e) => toast({ tone: 'danger', title: 'Not approved', description: errorText(e) }) })}
              >
                Approve application
              </Button>
              {!allEmp ? (
                <p className="text-xs text-nw-text-3" data-testid="approve-hint">
                  Complete the employer forms first.
                </p>
              ) : null}
              <Button variant="outline" icon={<MessageSquareReply />} onClick={() => setChanges(true)} data-testid="dot-app-request-changes">
                Request changes from driver
              </Button>
              <Button variant="danger" icon={<X />} onClick={() => setRejecting(true)} data-testid="dot-app-reject">
                Reject
              </Button>
            </div>
          ) : null}
          {d.status === 'approved' ? (
            <Button variant="danger" size="sm" className="w-fit" icon={<X />} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          ) : null}
          <div className="border-t border-nw-border pt-3">
            <Checklist items={d.employerChecklist} />
          </div>
        </div>
      </Panel>
      {changes ? <RequestChangesModal detail={d} onClose={() => setChanges(false)} /> : null}
      {rejecting ? <RejectModal detail={d} onClose={() => setRejecting(false)} /> : null}
    </div>
  );
}

function RequestChangesModal({ detail: d, onClose }: { detail: DotAppSafetyDetail; onClose: () => void }) {
  const { toast } = useToast();
  const steps = dotAppVisibleSteps(d.answers).filter((s) => s !== 'review');
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [emailResult, setEmailResult] = useState<{ status: string; error: string | null } | null>(null);
  const send = useSafetyMutation(d.id, (body: { sections: string[]; message: string }) => dotAppSafetyApi.requestChanges(d.id, body.sections, body.message));
  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !send.isPending ? onClose() : undefined)}
      title={`Request changes from ${d.candidateName}`}
      description="The driver gets an email with a fresh link and your message. Signatures in the chosen sections must be signed again."
      footer={
        emailResult ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={send.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={send.isPending}
              disabled={picked.length === 0 || message.trim().length < 5}
              data-testid="changes-send"
              onClick={() =>
                send.mutate(
                  { sections: picked, message: message.trim() },
                  {
                    onSuccess: (r) => {
                      setEmailResult(r.email);
                      toast({ tone: 'success', title: 'Changes requested' });
                    },
                  },
                )
              }
            >
              Send request
            </Button>
          </>
        )
      }
    >
      {emailResult ? (
        <div className="flex flex-col gap-2" data-testid="changes-result">
          {emailResult.status === 'sent' ? <Alert tone="success" title="Email sent to the driver" /> : null}
          {emailResult.status === 'failed' ? <Alert tone="danger" title="Email failed" description={`${emailResult.error ?? ''} Tell Recruiting to resend the link to the driver.`} /> : null}
          {emailResult.status === 'skipped' ? <Alert tone="warning" title="Email was not sent" description={emailResult.error ?? 'Email is not set up on the server. Tell Recruiting to resend the link to the driver.'} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {send.error ? <Alert tone="danger" title="Not sent" description={errorText(send.error)} /> : null}
          <fieldset className="flex flex-col gap-2" data-testid="changes-sections">
            <legend className="mb-1 text-sm font-semibold text-nw-text">Sections to reopen</legend>
            {steps.map((s) => (
              <Checkbox key={s} checked={picked.includes(s)} onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, s] : p.filter((x) => x !== s)))} label={DOT_APP_STEP_TITLES[s]} />
            ))}
          </fieldset>
          <FormField label="Message to the driver" required>
            <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Please add your employer between 03/2024 and 08/2024." data-testid="changes-message" />
          </FormField>
        </div>
      )}
    </Modal>
  );
}

function RejectModal({ detail: d, onClose }: { detail: DotAppSafetyDetail; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const reject = useSafetyMutation(d.id, (r: string) => dotAppSafetyApi.reject(d.id, r));
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(o) => (!o && !reject.isPending ? onClose() : undefined)}
      title={`Reject ${d.candidateName}'s application?`}
      description="The driver's link stops working. The application and its records are kept."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            disabled={reason.trim().length < 3}
            data-testid="reject-confirm"
            onClick={() => reject.mutate(reason.trim(), { onSuccess: () => (toast({ tone: 'success', title: 'Application rejected' }), onClose()) })}
          >
            Reject application
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {reject.error ? <Alert tone="danger" title="Not rejected" description={errorText(reject.error)} /> : null}
        <FormField label="Reason" required>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------- answers, uploads, signatures

function AnswersTab({ detail: d }: { detail: DotAppSafetyDetail }) {
  const canSee = useHasPermission('compliance_sensitive.view');
  return (
    <AnswersSummary
      answers={d.answers}
      visibleSteps={dotAppVisibleSteps(d.answers)}
      ssn={<SsnRow last4={d.ssnLast4} canReveal={canSee} reveal={() => dotAppSafetyApi.ssn(d.id)} />}
      bank={d.bankLast4 || d.answers.ach ? <BankRow last4={d.bankLast4} canReveal={canSee} reveal={() => dotAppSafetyApi.bank(d.id)} /> : null}
    />
  );
}

function UploadsTab({ detail: d }: { detail: DotAppSafetyDetail }) {
  const slots = dotAppUploadSlots(d.answers);
  const given = new Set(d.uploads.map((u) => u.slot));
  const missing = slots.filter((s) => !given.has(s.slot));
  return (
    <Panel title="Uploads" description="Files open through a short-lived signed link; every view is recorded.">
      <ul className="rounded-xl border border-nw-border px-3" data-testid="dot-app-uploads">
        <DocRow
          label="Application (PDF)"
          detail="The whole application with every signature · SSN masked"
          view={{ url: dotAppUrls.pdf(d.id), title: 'DOT driver application', contentType: 'application/pdf', fileName: `DOT-application-${d.candidateName}.pdf` }}
          download={{ url: dotAppUrls.pdf(d.id), fileName: `DOT-application-${d.candidateName}.pdf` }}
        />
        {d.uploads.map((u) => (
          <DocRow
            key={u.id}
            label={DOT_APP_UPLOAD_LABELS[u.slot] ?? u.slot}
            detail={`${u.fileName} · ${(u.sizeBytes / 1024 / 1024).toFixed(2)} MB · ${longDateTime(u.uploadedAt)}${u.source === 'consent' ? ' · from the Consent Form' : ''}`}
            status={<FamilyBadge family="done">Received</FamilyBadge>}
            view={{ url: dotAppUrls.file(d.id, u.id), title: DOT_APP_UPLOAD_LABELS[u.slot] ?? u.fileName, contentType: u.contentType, fileName: u.fileName }}
            download={{ url: dotAppUrls.file(d.id, u.id), fileName: u.fileName }}
          />
        ))}
        {missing.map((s) => (
          <li key={s.slot} className="flex items-center gap-3 border-b border-nw-border py-2.5 last:border-0">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nw-subtle text-nw-text-3">
              <FileText aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-sm font-semibold text-nw-text">{DOT_APP_UPLOAD_LABELS[s.slot]}</span>
            {s.required ? <FamilyBadge family="warning">Not provided</FamilyBadge> : <FamilyBadge family="neutral">Not provided (optional)</FamilyBadge>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SignaturesTab({ detail: d }: { detail: DotAppSafetyDetail }) {
  const sorted = [...d.signatures].sort((a, b) => a.signedAt.localeCompare(b.signedAt));
  // The driver's signatures (the application and its documents), then the ones given on this
  // screen: the carrier's and the driver's in-person training signature.
  const driver = sorted.filter((s) => !(DOT_APP_EMPLOYER_SIGNATURES as readonly string[]).includes(s.key));
  const employer = sorted.filter((s) => (DOT_APP_EMPLOYER_SIGNATURES as readonly string[]).includes(s.key));
  return (
    <div className="flex flex-col gap-4">
      <SignatureTable detail={d} rows={driver} title="Driver signatures" description="Each document signed separately by the driver, with its version and evidence (IP, device and e-sign consent recorded)." testId="dot-app-signatures" />
      <SignatureTable detail={d} rows={employer} title="Employer & onboarding signatures" description="Signed on the Safety screens: the motor carrier's sections and the driver's in-person training signature." testId="dot-app-employer-signatures" />
    </div>
  );
}

function SignatureTable({ detail: d, rows, title, description, testId }: { detail: DotAppSafetyDetail; rows: DotAppSafetyDetail['signatures']; title: string; description: string; testId: string }) {
  return (
    <Panel title={title} description={description}>
      {rows.length === 0 ? (
        <p className="text-sm text-nw-text-3">No signatures yet.</p>
      ) : (
        <div className="scroll-quiet overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid={testId}>
            <thead>
              <tr className="border-b border-nw-border text-left text-xs font-semibold tracking-wide text-nw-text-3 uppercase">
                <th className="py-2 pr-3">Document</th>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2 pr-3">Signer</th>
                <th className="py-2 pr-3">Signed</th>
                <th className="py-2 pr-3">Evidence</th>
                <th className="py-2">Image</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.key} className="border-b border-nw-border last:border-0">
                  <td className="py-2 pr-3 text-nw-text">{signatureLabel(s.key, d.answers)}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-nw-text-2">{s.docVersion}</td>
                  <td className="py-2 pr-3 text-nw-text-2">
                    {s.typedName}
                    <span className="block text-xs text-nw-text-3">{s.signerRole === 'employer' ? `Carrier${s.signerTitle ? ` · ${s.signerTitle}` : ''}` : (s.signerTitle ?? 'Driver')}</span>
                  </td>
                  <td className="py-2 pr-3 text-nw-text-2">{longDateTime(s.signedAt)}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-nw-text-2">ID {s.evidenceId}</td>
                  <td className="py-2">
                    <SignatureThumb applicationId={d.id} sigKey={s.key} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------- notes & audit

const EMAIL_KIND: Record<string, string> = { application_link: 'Application link', application_changes: 'Changes requested', application_code: 'Sign-in code' };

function AuditTab({ detail: d }: { detail: DotAppSafetyDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]" data-testid="dot-app-audit">
      <Panel title="Activity">
        {d.activity.length === 0 ? (
          <p className="text-sm text-nw-text-3">Nothing recorded yet.</p>
        ) : (
          <Timeline
            items={d.activity.map((a, i) => ({ id: `${a.at}-${i}`, at: a.at, title: a.detail || a.action, actor: { name: a.actor } }))}
            formatTime={(t) => longDateTime(t.toISOString())}
          />
        )}
      </Panel>
      <div className="flex flex-col gap-4">
        {d.internalNote ? (
          <Panel title="Review note (internal)">
            <p className="text-sm whitespace-pre-wrap text-nw-text-2">{d.internalNote}</p>
          </Panel>
        ) : null}
        <Panel title="Change requests">
          {d.changeRequests.length === 0 ? (
            <p className="text-sm text-nw-text-3">None.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {d.changeRequests.map((r) => (
                <li key={r.id} className="rounded-lg border border-nw-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-nw-text">{r.sections.map((s) => DOT_APP_STEP_TITLES[s]).join(', ')}</span>
                    {r.resolvedAt ? <FamilyBadge family="done">Resubmitted</FamilyBadge> : <FamilyBadge family="warning">Open</FamilyBadge>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-nw-text-2">{r.message}</p>
                  <p className="mt-1 text-xs text-nw-text-3">
                    {r.requestedByName} · {longDateTime(r.requestedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Emails">
          {d.emails.length === 0 ? (
            <p className="text-sm text-nw-text-3">No emails sent.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-nw-border" data-testid="dot-app-emails">
              {d.emails.map((m) => (
                <li key={m.id} className="flex flex-col gap-1 py-2 text-sm">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-nw-text">{EMAIL_KIND[m.kind] ?? m.kind}</span>
                    <EmailStatusBadge status={m.status} />
                  </span>
                  <span className="text-xs text-nw-text-3">
                    To {m.to} · {longDateTime(m.at)}
                    {m.error ? ` · ${m.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

import { Link } from '@tanstack/react-router';
import { Copy, Info, Send } from 'lucide-react';
import { useState } from 'react';
import {
  APPLICANT_SOURCES,
  DRIVER_LANGUAGES,
  LEAD_SOURCE_LABELS,
  type RecruitCandidate,
} from '@neway/shared';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  StatusSymbol,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime } from '@/lib/format';
import { fieldErrors } from '../recruiting-kit';
import { Initials, ProgressBadge } from './RecruitKit';
import { shortDate } from './recruit-format';
import { recruitApi, useRecruiters, useRecruitMutation, useRotationNext, type ApplicationLinkCreated } from './useRecruit';

/**
 * The recruiting dialogs (owner's redesign, 2026-10-08). Each one: Cancel, the close button and
 * Escape leave without saving; the primary button shows its work and is disabled while it runs;
 * a toast appears only after the server said yes; what was typed survives a failed save.
 */

// The online sources the Add lead form offers first; every recorded source stays valid.
const ADD_LEAD_SOURCES = ['instagram', 'facebook', 'referral', 'phone_call', 'website', 'job_board', 'walk_in', ...APPLICANT_SOURCES];

function problemMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function CandidateLine({ name, source }: { name: string; source: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-nw-border bg-nw-subtle px-3 py-2.5">
      <Initials name={name} />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold text-nw-text">{name}</p>
        <p className="truncate text-[13px] text-nw-text-3">{source}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------- add lead

export function AddLeadModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { toast } = useToast();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const next = useRotationNext();
  const recruiters = useRecruiters();
  const add = useRecruitMutation(recruitApi.addLead);
  const [form, setForm] = useState({ fullName: '', phone: '', email: '', source: 'instagram', assignment: 'auto', recruiterEmployeeId: '' });
  // The person adding the lead is a recruiter: "A specific recruiter" starts on them (owner, 2026-10-12).
  const me = (recruiters.data ?? []).find((r) => r.isMe)?.employeeId ?? '';
  const [tried, setTried] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(add.error);
  const local: Record<string, string | null> = {
    fullName: form.fullName.trim().length >= 2 ? null : 'Enter the full name',
    phone: form.phone.replace(/\D/g, '').length >= 10 ? null : 'Enter a 10-digit phone number',
    recruiterEmployeeId: form.assignment === 'recruiter' && !form.recruiterEmployeeId ? 'Choose the recruiter' : null,
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  const nextName = next.isPending ? 'Loading…' : next.data ? next.data.name : 'nobody (no eligible recruiter)';

  const submit = () => {
    setTried(true);
    if (Object.values(local).some((v) => v !== null)) return;
    add.mutate(
      {
        fullName: form.fullName,
        phone: form.phone,
        email: form.email || null,
        source: form.source,
        assignment: form.assignment as 'auto' | 'recruiter',
        recruiterEmployeeId: form.assignment === 'recruiter' ? form.recruiterEmployeeId : null,
      },
      {
        onSuccess: (result) => {
          toast({
            tone: 'success',
            title: 'Lead added',
            description: result.lead.recruiterName ? `Assigned to ${result.lead.recruiterName}.` : 'No recruiter was eligible; it is unassigned.',
          });
          onCreated(result.key);
        },
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add lead"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={submit} data-testid="add-lead-submit">
            Add lead
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        data-testid="add-lead-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {add.error && Object.keys(server).length === 0 ? <Alert tone="danger" title="Not added" description={problemMessage(add.error, 'The lead was not saved.')} /> : null}
        <FormField label="Full name" required error={err('fullName')}>
          <Input autoFocus value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="off" />
        </FormField>
        <FormField label="Phone" required error={err('phone')}>
          <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="(555) 234-5678" />
        </FormField>
        <FormField label="Email (optional)" error={err('email')}>
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" />
        </FormField>
        <FormField label="Source">
          <Select
            aria-label="Source"
            value={form.source}
            onValueChange={(v) => set('source', v)}
            options={[...new Set(ADD_LEAD_SOURCES)].map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] ?? s.replace(/_/g, ' ') }))}
          />
        </FormField>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-semibold text-nw-text">Assigned to</legend>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-nw-text">
            <input type="radio" name="assignment" className="size-4 accent-nw-accent" checked={form.assignment === 'auto'} onChange={() => set('assignment', 'auto')} />
            <span>
              Automatic · next <strong className="font-semibold">{nextName}</strong>
            </span>
          </label>
          {canManage ? (
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-nw-text">
              <input type="radio" name="assignment" className="size-4 accent-nw-accent" checked={form.assignment === 'recruiter'} onChange={() => setForm((f) => ({ ...f, assignment: 'recruiter', recruiterEmployeeId: f.recruiterEmployeeId || me }))} />
              A specific recruiter
            </label>
          ) : null}
          {form.assignment === 'recruiter' ? (
            <FormField label="Recruiter" error={err('recruiterEmployeeId')}>
              <Select
                aria-label="Recruiter"
                value={form.recruiterEmployeeId}
                onValueChange={(v) => set('recruiterEmployeeId', v)}
                placeholder="Choose the recruiter"
                options={(recruiters.data ?? []).map((r) => ({ value: r.employeeId, label: r.name }))}
              />
            </FormField>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-nw-text-3">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
              The preview is for information; the server takes the turn when the lead is saved.
            </p>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------ copy application link

/**
 * Copy application link. Making a link is real (the server issues it and keeps only its digest);
 * copying it is only copying — the dialog never says the link was sent. "Mark as sent" records,
 * by the recruiter's own word, that they sent it.
 */
export function CopyLinkModal({ candidate, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const make = useRecruitMutation(() => recruitApi.applicationLink(candidate.key));
  const mark = useRecruitMutation((channel: string | null) => recruitApi.markSent(candidate.key, channel));
  const [created, setCreated] = useState<ApplicationLinkCreated | null>(null);
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  const [markedAt, setMarkedAt] = useState<string | null>(null);
  const link = candidate.application.link;
  const live = link?.state === 'live';
  const url = created ? (created.externalUrl ?? created.url) : null;
  const first = candidate.name.split(/\s+/)[0] ?? candidate.name;
  const message = url ? `Hi ${first}! Here is your application link to drive with us. It takes a few minutes to complete: ${url}` : '';
  const prequalifyFirst = make.error instanceof ApiError && (make.error.problem as { code?: string } | null)?.code === 'prequalify_first';

  const copy = async (what: 'link' | 'message', text: string) => {
    try {
      await copyText(text);
      setCopied(what);
      toast({ tone: 'success', title: what === 'link' ? 'Link copied' : 'Message copied', description: 'Copied to your clipboard. Nothing was sent.' });
    } catch {
      toast({ tone: 'warning', title: 'Copy is not available here', description: 'Select the text and copy it by hand.' });
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Copy application link"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="copy-link-dialog">
        <CandidateLine name={candidate.name} source={candidate.sourceLabel} />
        {prequalifyFirst ? (
          <Alert tone="warning" title="Prequalify the lead first">
            The application link opens a candidate record, and that needs the prequalification answers. Record them from{' '}
            <strong>More › Prequalify</strong> on this page, then copy the link.
          </Alert>
        ) : make.error ? (
          <Alert tone="danger" title="No link was made" description={problemMessage(make.error, 'Try again.')} />
        ) : null}

        {url ? (
          <>
            <FormField label="Candidate-specific link" description={`Works until ${formatDateTime(created?.expiresAt ?? '')}. Only this candidate should get it.`}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={url} aria-label="Candidate-specific link" onFocus={(e) => e.currentTarget.select()} data-testid="application-link-url" />
                <Button variant="primary" icon={<Copy />} onClick={() => void copy('link', url)} data-testid="copy-link-button">
                  {copied === 'link' ? 'Link copied' : 'Copy link'}
                </Button>
              </div>
            </FormField>
            <div className="rounded-xl border border-nw-border bg-nw-subtle p-3">
              <p className="text-[13px] font-semibold text-nw-text">Message to send yourself (optional)</p>
              <p className="mt-1 text-sm text-nw-text-2">{message}</p>
              <Button variant="outline" size="sm" className="mt-2" icon={<Copy />} onClick={() => void copy('message', message)}>
                {copied === 'message' ? 'Message copied' : 'Copy message'}
              </Button>
            </div>
            <p className="text-xs text-nw-text-3">
              The address is shown only now; the server keeps a fingerprint, not the link. To send it again later, make a new link — the old one stops working.
            </p>
          </>
        ) : live && link ? (
          <div className="rounded-xl border border-nw-border px-3 py-3 text-sm" data-testid="link-live">
            <p className="font-semibold text-nw-text">A link was made on {shortDate(link.createdAt)} and works until {shortDate(link.expiresAt)}.</p>
            <p className="mt-1 text-nw-text-3">
              {link.firstOpenedAt ? `Opened ${formatDateTime(link.firstOpenedAt)}.` : 'Not opened yet.'} {link.lastSavedAt ? `Last saved ${formatDateTime(link.lastSavedAt)}.` : ''}
            </p>
            <p className="mt-2 text-nw-text-3">The address is not kept. A new link turns the previous one off; what the driver saved stays.</p>
            <Button variant="outline" className="mt-3" loading={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => setCreated(r) })}>
              Make a new link
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-nw-text-2">This makes a private link to the driver application for {candidate.name}. It works for 14 days.</p>
            <Button variant="primary" loading={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => setCreated(r) })} data-testid="make-link">
              Make the link
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-nw-border pt-3">
          <span className="text-[13px] text-nw-text-3">Status</span>
          <ProgressBadge progress={candidate.progress} size="sm" />
          {url || live ? (
            markedAt || candidate.application.markedSentAt ? (
              <span className="text-xs text-nw-text-3">Marked as sent {formatDateTime(markedAt ?? candidate.application.markedSentAt ?? '')}</span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<Send />}
                loading={mark.isPending}
                onClick={() => mark.mutate(null, { onSuccess: (r) => { setMarkedAt(r.at); toast({ tone: 'success', title: 'Recorded as sent by you' }); } })}
                data-testid="mark-sent"
              >
                I sent it — mark as sent
              </Button>
            )
          ) : null}
        </div>
        {mark.error ? <Alert tone="danger" title="Not recorded" description={problemMessage(mark.error, 'Try again.')} /> : null}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- send to Safety

export function SendToSafetyModal({ candidate, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const send = useRecruitMutation((note: string | null) => recruitApi.sendToSafety(candidate.key, { note }));
  const [note, setNote] = useState('');
  const r = candidate.sendToSafety;
  const missing = send.error instanceof ApiError ? ((send.error.problem as { missing?: string[] } | null)?.missing ?? null) : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Send to Safety"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!r.ready || r.alreadyRequested}
            loading={send.isPending}
            data-testid="send-to-safety-submit"
            onClick={() =>
              send.mutate(note.trim() || null, {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Sent to Safety', description: `${candidate.name} is waiting for Safety's review.` });
                  onClose();
                },
              })
            }
          >
            Send to Safety
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="send-to-safety-dialog">
        <CandidateLine name={candidate.name} source={candidate.sourceLabel} />
        {r.alreadyRequested ? (
          <Alert tone="info" title="Already with Safety">
            Sent {formatDateTime(candidate.safety.requestedAt ?? '')} by {candidate.safety.requestedBy}.
          </Alert>
        ) : null}
        <ul className="flex flex-col gap-2.5">
          {r.checks.map((c) => (
            <li key={c.code} className="flex items-start gap-2.5 text-sm">
              <StatusSymbol family={c.ok ? 'done' : 'warning'} size={16} className={cn('mt-px', c.ok ? 'text-nw-done-icon' : 'text-nw-warning-icon')} />
              <span className="flex-1">
                <span className="font-medium text-nw-text">{c.label}</span>
                <span className={cn('block text-xs', c.ok ? 'text-nw-text-3' : 'text-nw-warning-text')}>{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-nw-text-3">
          Safety runs its own checks (MVR, PSP, Clearinghouse, drug test) and decides. Uploading a document is not an approval.
        </p>
        {!r.alreadyRequested ? (
          <FormField label="Note (optional)">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the Safety team…" />
          </FormField>
        ) : null}
        {send.error ? (
          <Alert tone="danger" title="Not sent">
            {missing ? (
              <ul className="list-disc pl-4">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : (
              problemMessage(send.error, 'Try again.')
            )}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------- view Safety review

export function SafetyReviewModal({ candidate, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const s = candidate.safety;
  const v = s.verification;
  const canSeeSafety = useAccount()?.permissions.includes('compliance.view') ?? false;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Safety review"
      description="Read-only here: Safety approves or disqualifies in the Safety workflow."
      footer={
        <>
          {canSeeSafety && candidate.driverId ? (
            <Button variant="outline" asChild>
              <Link to="/safety">Open Safety</Link>
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="safety-review-dialog">
        <CandidateLine name={candidate.name} source={candidate.sourceLabel} />
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Fact label="Sent to Safety" value={s.requestedAt ? `${formatDateTime(s.requestedAt)} · ${s.requestedBy ?? ''}` : 'Not requested'} />
          <Fact label="Review" value={v ? v.safetyReviewStatus.replace(/_/g, ' ') : 'Not open'} />
          <Fact label="Reviewer" value={v?.safetyReviewBy ?? '—'} />
          <Fact label="Decision" value={v?.decision ? `${v.decision.replace(/_/g, ' ')} · ${v.decisionBy ?? ''} · ${formatDateTime(v.decisionAt ?? '')}` : 'Pending'} />
        </dl>
        {s.requestNote ? <p className="rounded-lg bg-nw-subtle px-3 py-2 text-sm text-nw-text-2">“{s.requestNote}”</p> : null}
        {v ? (
          <ul className="flex flex-col divide-y divide-nw-border rounded-xl border border-nw-border">
            {v.steps.map((step) => (
              <li key={step.label} className="flex items-start gap-2.5 px-3 py-2.5 text-sm">
                <StatusSymbol
                  family={step.status === 'complete' ? 'done' : step.status === 'blocked' ? 'warning' : 'neutral'}
                  size={15}
                  className={step.status === 'complete' ? 'text-nw-done-icon' : step.status === 'blocked' ? 'text-nw-warning-icon' : 'text-nw-text-3'}
                />
                <span className="flex-1">
                  <span className="font-medium text-nw-text">{step.label}</span>
                  <span className="block text-xs text-nw-text-3">{step.blocker ?? step.status.replace(/_/g, ' ')}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-nw-text-3">The qualification file opens when the application is accepted.</p>
        )}
        {v?.decisionNote ? <p className="text-sm text-nw-text-2">Safety’s note: {v.decisionNote}</p> : null}
      </div>
    </Modal>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-nw-text-3">{label}</dt>
      <dd className="mt-0.5 font-medium text-nw-text">{value}</dd>
    </div>
  );
}

// ------------------------------------------------------------------------------------- hire

export function HireModal({ candidate, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const directory = useEmployeeDirectory();
  const hire = useRecruitMutation((body: Parameters<typeof recruitApi.hire>[1]) => recruitApi.hire(candidate.caseId ?? '', body));
  const [form, setForm] = useState({ hireDate: companyToday(), dispatcherId: '', managerEmployeeId: '', preferredLanguage: 'en', startOnboarding: true });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(hire.error);
  const local: Record<string, string | null> = {
    hireDate: form.hireDate ? null : 'Choose the start date',
    dispatcherId: form.dispatcherId ? null : 'Choose the dispatcher',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  const ready = candidate.hire.ready && candidate.permissions.canManage;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Hire ${candidate.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={hire.isPending}
            data-testid="confirm-hire"
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              hire.mutate(
                {
                  hireDate: form.hireDate,
                  dispatcherId: form.dispatcherId,
                  managerEmployeeId: form.managerEmployeeId || null,
                  preferredLanguage: form.preferredLanguage as (typeof DRIVER_LANGUAGES)[number],
                  startOnboarding: form.startOnboarding,
                },
                {
                  onSuccess: (result) => {
                    toast({ tone: 'success', title: 'Driver profile created', description: `${candidate.name} has been hired as ${result.driverNumber}.` });
                    onClose();
                  },
                },
              );
            }}
          >
            Confirm hire
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="hire-dialog">
        <CandidateLine name={candidate.name} source={candidate.sourceLabel} />
        {candidate.hire.ready ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-nw-done-border bg-nw-done-bg px-3 py-2.5">
            <StatusSymbol family="done" size={18} className="mt-px text-nw-done-icon" />
            <div>
              <p className="text-sm font-semibold text-nw-done-text">Safety approved</p>
              <p className="text-xs text-nw-done-text">Every mandatory check is reviewed and accepted; orientation and the road test are done.</p>
            </div>
          </div>
        ) : (
          <Alert tone="warning" title="Not ready to hire">
            <ul className="list-disc pl-4">
              {candidate.hire.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Alert>
        )}
        {hire.error && Object.keys(server).length === 0 ? <Alert tone="danger" title="Not hired" description={problemMessage(hire.error, 'Try again.')} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Start date" required error={err('hireDate')}>
            <DatePicker aria-label="Start date" value={form.hireDate} onIsoChange={(v) => set('hireDate', v)} disabled={!ready} />
          </FormField>
          <FormField label="Dispatcher" required error={err('dispatcherId')}>
            <DispatcherSelect value={form.dispatcherId || null} onValueChange={(v) => set('dispatcherId', v ?? '')} />
          </FormField>
          <FormField label="Manager">
            <Select
              aria-label="Manager"
              value={form.managerEmployeeId}
              onValueChange={(v) => set('managerEmployeeId', v)}
              options={[{ value: '', label: 'No manager' }, ...(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))]}
            />
          </FormField>
          <FormField label="Preferred language">
            <Select
              aria-label="Preferred language"
              value={form.preferredLanguage}
              onValueChange={(v) => set('preferredLanguage', v)}
              options={DRIVER_LANGUAGES.map((l) => ({ value: l, label: l }))}
            />
          </FormField>
        </div>
        <Checkbox label="Create their onboarding plan now" checked={form.startOnboarding} onCheckedChange={(v) => set('startOnboarding', v === true)} />
        <p className="flex items-start gap-1.5 text-xs text-nw-text-3">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          The driver profile keeps the id the qualification file has had since the application ({candidate.driverId ?? '—'}), with the application and
          documents already on it. Nothing is entered again.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Reopen a disqualified lead (owner, 2026-10-09): a note saying why is required. The lead returns
 * to the step it had reached; the note lands on the Notes tab and the change in the audit log.
 */
export function ReopenLeadModal({ candidateKey, name, deadReason, onClose }: { candidateKey: string; name: string; deadReason: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useRecruitMutation((text: string) => recruitApi.reopen(candidateKey, text));
  const tooShort = note.trim().length < 3;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={`Reopen ${name}`}
      description={`Disqualified${deadReason ? ` - ${deadReason}` : ''}. Reopening brings them back to the step they had reached; the note is kept with your name.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={tooShort}
            onClick={() =>
              save.mutate(note.trim(), {
                onSuccess: () => {
                  toast({ tone: 'success', title: `${name} reopened` });
                  onClose();
                },
                onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not reopen the lead. Try again.'),
              })
            }
            data-testid="reopen-lead-save"
          >
            Reopen lead
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not reopened">
            {error}
          </Alert>
        ) : null}
        <FormField label="Note" required description="Why the lead is back - it is saved on the Notes tab.">
          <Textarea rows={3} aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} data-testid="reopen-lead-note" />
        </FormField>
      </div>
    </Modal>
  );
}

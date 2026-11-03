import { useBlocker } from '@tanstack/react-router';
import { ArrowRight, CircleCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  DOT_SECTIONS,
  DOT_SECTION_LABELS,
  dotApplicationProblems,
  dotSectionStates,
  type ApplicantRecord,
  type DotApplication,
  type DotFieldProblem,
  type DotSection,
  type HiringCase,
} from '@neway/shared';
import { Alert, Button, Card, ConfirmDialog, Skeleton, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { SubmittedApplication } from './DotApplicationPanel';
import {
  Addresses,
  Employment,
  Identity,
  Incidents,
  Licenses,
  Review,
  SectionRules,
  type ContactDetails,
} from './DotApplicationSections';
import { STATE_LABEL, initialDraft, toForm, type Draft } from './dot-application-form';
import { DotLinkBar, DriverReviewBanner } from './DotLinkPanel';
import { dotLinkActive } from './dot-link-progress';
import { hiringApi, useDotApplication, useDotLink, useHiringMutation } from './useHiring';

/**
 * The DOT application (49 CFR 391.21) as six sections (owner's design, 2026-09-30).
 *
 * Every field of the long form is here, grouped the way the rule reads. A draft may be saved at
 * any point, however incomplete — the server keeps it and gives it back after a reload. Nothing
 * is called "Saved" until the server has answered. Submission happens only from Review & certify
 * and runs the same checks as before; it files the PDF, opens the verification case and drafts
 * the employer consents once, however many times it is pressed.
 *
 * The application can also be sent to the driver (owner, 2026-10-07): while the link is live the
 * draft is fetched again every few seconds, so what the driver saves on the phone shows up here.
 * Unsaved edits on this side are never overwritten silently; the recruiter is asked to reload.
 */

export function DotApplicationWizard({ hiringCase, candidate, canEdit }: { hiringCase: HiringCase; candidate: ApplicantRecord; canEdit: boolean }) {
  const link = useDotLink(hiringCase.id);
  const application = useDotApplication(hiringCase.id, { poll: dotLinkActive(link.data) });
  if (application.isPending) return <Skeleton className="h-96 w-full" />;
  if (application.error) return <Alert tone="danger" title="The application could not be loaded">{application.error instanceof Error ? application.error.message : null}</Alert>;
  const status = application.data?.status ?? 'draft';
  const bar = <DotLinkBar hiringCase={hiringCase} link={link.data} loading={link.isPending} canEdit={canEdit} submitted={status !== 'draft'} />;
  if (application.data?.status === 'submitted') {
    return (
      <div className="flex flex-col gap-3">
        {bar}
        <SubmittedApplication application={application.data} hiringCase={hiringCase} />
      </div>
    );
  }
  const contact: ContactDetails = {
    email: candidate.email && !candidate.email.endsWith('.lead') ? candidate.email : null,
    phone: candidate.phone || null,
    location: candidate.location ?? null,
  };
  if (status === 'driver_submitted' && application.data) {
    // The frozen submission, read-only, under the review banner.
    return (
      <div className="flex flex-col gap-3">
        <DriverReviewBanner hiringCase={hiringCase} application={application.data} canEdit={canEdit} />
        <Wizard key="review" hiringCase={hiringCase} candidate={candidate} contact={contact} existing={application.data} canEdit={false} lockedReason="Read-only: this is the application as the driver certified it." linkBar={bar} />
      </div>
    );
  }
  const returned = application.data?.returnNote && application.data.returnedAt ? application.data : null;
  return (
    <div className="flex flex-col gap-3">
      {returned ? (
        <Alert tone="info" title={`Returned to the driver ${formatDateTime(returned.returnedAt as string)}${returned.returnedBy ? ` by ${returned.returnedBy}` : ''}`} data-testid="dot-returned">
          {returned.returnNote} The driver corrects it and certifies again; the earlier certification stays in the history.
        </Alert>
      ) : null}
      <Wizard key="draft" hiringCase={hiringCase} candidate={candidate} contact={contact} existing={application.data} canEdit={canEdit} linkBar={bar} />
    </div>
  );
}

function Wizard({
  hiringCase,
  candidate,
  contact,
  existing,
  canEdit,
  lockedReason,
  linkBar,
}: {
  hiringCase: HiringCase;
  candidate: ApplicantRecord;
  contact: ContactDetails;
  existing: DotApplication | null;
  canEdit: boolean;
  /** Why the form is read-only, when it is not about permissions. */
  lockedReason?: string;
  linkBar: ReactNode;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(candidate, existing?.form ?? null));
  const [section, setSection] = useState<DotSection>('identity');
  const [saved, setSaved] = useState<{ json: string; at: string | null; ssnLast4: string | null }>(() => ({
    // The baseline is what the form opened with — the saved draft, or the details prefilled from
    // the candidate. Only what the recruiter changes counts as unsaved; opening the profile and
    // leaving must not ask "Leave without saving?" (it used to, and blocked the back button).
    json: JSON.stringify(toForm(initialDraft(candidate, existing?.form ?? null))),
    at: existing?.updatedAt ?? null,
    ssnLast4: existing?.ssnLast4 ?? null,
  }));
  const [shown, setShown] = useState<Set<DotSection>>(() => new Set());
  const [serverIssues, setServerIssues] = useState<DotFieldProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A newer draft from the server (the driver, through the link) while this side has unsaved edits. */
  const [remote, setRemote] = useState<DotApplication | null>(null);
  /** The server's save time this form last looked at, so a newer one (the driver's) is noticed once. */
  const [seenAt, setSeenAt] = useState<string | null>(existing?.updatedAt ?? null);

  const form = useMemo(() => toForm(draft), [draft]);
  const json = JSON.stringify(form);
  const dirty = json !== saved.json || draft.ssn.trim().length > 0;
  const now = useMemo(() => new Date(), []);
  const states = useMemo(() => dotSectionStates(form, now), [form, now]);
  const problems = useMemo(() => dotApplicationProblems(form, now), [form, now]);
  const fieldError = (path: string, sectionOf: DotSection) =>
    shown.has(sectionOf) ? problems.find((p) => p.path === path)?.detail : undefined;

  const load = (next: DotApplication) => {
    const fresh = initialDraft(candidate, next.form);
    setDraft(fresh);
    setSaved({ json: JSON.stringify(toForm(fresh)), at: next.updatedAt, ssnLast4: next.ssnLast4 });
    setRemote(null);
  };

  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: () => dirty, withResolver: true });

  const save = useHiringMutation(async () => {
    const ssn = draft.ssn.trim();
    return hiringApi.saveDotApplication(hiringCase.id, {
      ...form,
      // Typed now, or kept sealed by leaving it out; cleared only when never given.
      ssn: ssn ? ssn : saved.ssnLast4 ? undefined : null,
    } as Parameters<typeof hiringApi.saveDotApplication>[1]);
  });
  const submit = useHiringMutation(async () => hiringApi.submitDotApplication(hiringCase.id));

  // Someone else saved (the driver on the phone): take it in, or ask first if there are edits here.
  // Our own save comes back while it is still pending, and is already the baseline once it lands.
  const incoming = existing?.updatedAt ?? null;
  if (incoming !== seenAt) {
    setSeenAt(incoming);
    if (existing && incoming !== saved.at && !save.isPending) {
      if (dirty) setRemote(existing);
      else load(existing);
    }
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const index = DOT_SECTIONS.indexOf(section);

  const doSave = async (): Promise<boolean> => {
    setError(null);
    try {
      const result = await save.mutateAsync(undefined);
      setSaved({ json: JSON.stringify(toForm({ ...draft })), at: result.updatedAt, ssnLast4: result.ssnLast4 });
      setDraft((d) => ({ ...d, ssn: '' }));
      setRemote(null);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The draft was not saved.');
      return false;
    }
  };

  const onSaveDraft = async () => {
    if (await doSave()) toast({ tone: 'success', title: 'Draft saved' });
  };
  const onSaveContinue = async () => {
    setShown((s) => new Set(s).add(section));
    if (!(await doSave())) return;
    toast({ tone: 'success', title: 'Draft saved' });
    const next = DOT_SECTIONS[index + 1];
    if (next) setSection(next);
  };
  const onSubmit = async () => {
    setShown(new Set(DOT_SECTIONS));
    setServerIssues(null);
    if (!(await doSave())) return;
    try {
      const result = await submit.mutateAsync(undefined);
      toast({ tone: 'success', title: 'Application submitted and filed', description: `Filed under ${result.driverId}; ${result.consentIds.length} employer verification${result.consentIds.length === 1 ? '' : 's'} drafted.` });
    } catch (e) {
      const extra = e instanceof ApiError ? (e.problem as unknown as { issues?: DotFieldProblem[] } | null) : null;
      if (Array.isArray(extra?.issues)) setServerIssues(extra.issues);
      else setError(e instanceof ApiError ? e.message : 'The application was not submitted.');
    }
  };

  const disabled = !canEdit;

  return (
    <div className="flex flex-col gap-4" data-testid="dot-wizard">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold text-ink">DOT application</h2>
          <p className="text-sm text-muted">Complete each section, then review and submit. A draft can be saved at any point.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {linkBar}
          {lockedReason ? <span className="text-xs text-muted">{lockedReason}</span> : !canEdit ? <span className="text-xs text-muted">View only — editing takes recruiting.manage.</span> : null}
        </div>
      </div>
      {remote ? (
        <Alert
          tone="info"
          title="The driver saved changes — reload"
          actions={
            <Button variant="outline" size="sm" onClick={() => load(remote)}>
              Reload the driver's version
            </Button>
          }
        >
          The driver saved the application {formatDateTime(remote.updatedAt)} through the link. Reloading replaces your unsaved edits here; saving yours first would overwrite the driver's.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card padding="none" className="h-fit p-4">
          <h3 className="mb-3 text-sm font-bold text-ink">Application sections</h3>
          <ol className="flex flex-col" aria-label="Application sections">
            {DOT_SECTIONS.map((s, i) => {
              const st = states[s];
              const on = s === section;
              return (
                <li key={s} className="relative pb-2 last:pb-0">
                  {i < DOT_SECTIONS.length - 1 ? <span aria-hidden className="absolute top-8 left-[18px] h-[calc(100%-1.75rem)] w-px bg-line" /> : null}
                  <button
                    type="button"
                    onClick={() => setSection(s)}
                    aria-current={on ? 'step' : undefined}
                    data-testid={`section-${s}`}
                    className={cn('relative z-10 flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus', on ? 'bg-primary-soft' : 'hover:bg-surface-hover')}
                  >
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                        st === 'complete' ? 'bg-success text-inverse' : on ? 'bg-primary text-inverse' : 'bg-neutral-soft text-secondary',
                      )}
                    >
                      {st === 'complete' ? <CircleCheck className="size-4" /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={cn('block text-sm font-semibold', on ? 'text-primary-text' : 'text-ink')}>{DOT_SECTION_LABELS[s]}</span>
                      <span className="block text-2xs text-muted" data-testid={`section-state-${s}`}>{STATE_LABEL[st]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 border-t border-line pt-3 text-2xs text-muted">Save your progress at any time.</p>
        </Card>

        <Card padding="none" className="min-w-0">
          <header className="flex items-baseline justify-between border-b border-line px-5 py-4">
            <h3 className="text-lg font-bold text-ink">{DOT_SECTION_LABELS[section]}</h3>
            <span className="text-xs text-muted">Section {index + 1} of {DOT_SECTIONS.length}</span>
          </header>
          <div className="flex flex-col gap-4 px-5 py-4">
            {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
            <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
              {section === 'identity' ? <Identity draft={draft} set={set} contact={contact} ssnLast4={saved.ssnLast4} err={(p) => fieldError(p, 'identity')} /> : null}
              {section === 'addresses' ? <Addresses draft={draft} set={set} err={(p) => fieldError(p, 'addresses')} /> : null}
              {section === 'licenses' ? <Licenses draft={draft} set={set} err={(p) => fieldError(p, 'licenses')} /> : null}
              {section === 'employment' ? <Employment draft={draft} set={set} err={(p) => fieldError(p, 'employment')} /> : null}
              {section === 'incidents' ? <Incidents draft={draft} set={set} err={(p) => fieldError(p, 'incidents')} /> : null}
              {section === 'certification' ? (
                <Review draft={draft} set={set} states={states} problems={serverIssues ?? problems} onGo={(s) => { setShown((x) => new Set(x).add(s)); setSection(s); }} err={(p) => fieldError(p, 'certification')} />
              ) : null}
            </fieldset>
            {shown.has(section) && section !== 'certification' ? <SectionRules problems={problems.filter((p) => p.section === section && p.path === null)} /> : null}
            {section !== 'certification' ? (
              <button type="button" onClick={() => setSection(DOT_SECTIONS[index + 1]!)} className="flex items-center justify-between rounded-lg border border-primary-border bg-primary-soft px-4 py-3 text-left">
                <span>
                  <span className="block text-sm font-semibold text-primary-text">Next: {DOT_SECTION_LABELS[DOT_SECTIONS[index + 1]!]}</span>
                  <span className="block text-xs text-muted">Moving on keeps what you typed; Save & continue also saves it.</span>
                </span>
                <ArrowRight aria-hidden className="size-4 text-primary-text" />
              </button>
            ) : null}
          </div>
          <footer className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-3 rounded-b-[10px] border-t border-line bg-surface px-5 py-3" data-testid="wizard-footer">
            <span className="text-xs text-muted" data-testid="save-state">
              {lockedReason
                ? `Certified by the driver${existing?.certifiedAt ? ` ${formatDateTime(existing.certifiedAt)}` : ''} · read-only`
                : save.isPending ? 'Saving…' : dirty ? 'Draft · unsaved changes' : saved.at ? `Draft · saved ${formatDateTime(saved.at)}` : 'Draft · not saved yet'}
            </span>
            <span className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => void onSaveDraft()} loading={save.isPending && !submit.isPending} disabled={disabled || !dirty}>
                Save draft
              </Button>
              {section === 'certification' ? (
                <Button variant="primary" onClick={() => void onSubmit()} loading={submit.isPending} disabled={disabled}>
                  Submit and file in the DQF
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void onSaveContinue()} loading={save.isPending} disabled={disabled}>
                  Save & continue <ArrowRight aria-hidden className="size-4" />
                </Button>
              )}
            </span>
          </footer>
        </Card>
      </div>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        title="Leave without saving?"
        description="The application has changes that are not saved. Save the draft first to keep them."
        confirmLabel="Leave"
        cancelLabel="Stay"
        tone="danger"
        onConfirm={() => {
          if (blocker.status === 'blocked') blocker.proceed();
        }}
      />
    </div>
  );
}

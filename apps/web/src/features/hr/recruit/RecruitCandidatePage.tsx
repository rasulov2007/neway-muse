import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Link2,
  Mail,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  RotateCcw,
  StickyNote,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApplicantRecord, HiringCase, RecruitCandidate, RenameCandidateInput } from '@neway/shared';
import {
  Alert,
  Button,
  DatePicker,
  DropdownMenu,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  StatusSymbol,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { DropCaseDialog, canDropCase } from '../CandidateHiringParts';
import { CostsPanel } from '../CostsPanel';
import { DotApplicationWizard } from '../DotApplicationWizard';
import { DriverReviewBanner, StagedDriverFiles } from '../DotLinkPanel';
import { ActivityFeed } from '../DriverCandidateProfile';
import { DriverFunnelPanel } from '../DriverFunnelPanel';
import { DisqualifyModal, PrequalifyModal } from '../LeadsTab';
import { caseDocumentFileUrl, useDotApplication, useLead } from '../useHiring';
import { AssigneeMenu, DocumentsTab, NoteMenu, ReminderModal, StatusMenu, type StatusAction } from './RecruitCandidateParts';
import { Initials, PersonChip, QuietState, RecruitCard, SourceIcon } from './RecruitKit';
import { downloadAuthed, followUpLabel, longDate, longDateTime, shortDate } from './recruit-format';
import { ApplicationConsents, PersonalApplication, SendApplicationModal, SessionLine } from './DriverApplicationParts';
import { CopyLinkModal, HireModal, ReopenLeadModal, SafetyReviewModal, SendToSafetyModal } from './RecruitModals';
import { recruitApi, useRecruitCandidate, useRecruitMutation, useRecruitNotes } from './useRecruit';
import { JourneyContent, JourneyNav } from './journey/JourneyPanel';

/**
 * Views that open in the content panel instead of a journey step: Notes (its own button beside the
 * steps) and the records under More. `null` is the journey itself.
 */
const VIEWS = ['notes', 'documents', 'dot', 'onboarding', 'costs', 'activity'] as const;
type View = (typeof VIEWS)[number];
const MORE_VIEWS = ['documents', 'dot', 'onboarding', 'costs', 'activity'] as const;
const VIEW_LABELS: Record<View, string> = {
  notes: 'Notes',
  documents: 'Qualification file',
  dot: 'Full DOT application',
  onboarding: 'Offer & onboarding',
  costs: 'Costs',
  activity: 'Activity',
};
type Dialog = 'reopen' | 'send' | 'link' | 'reminder' | 'safety' | 'safety-review' | 'hire' | 'prequalify' | 'disqualify' | 'drop' | null;

/** Status actions from the list badge (StatusAction names) and the dialog each opens here. */
const ACTION_DIALOG: Record<string, Dialog> = {
  prequalify: 'prequalify',
  link: 'send',
  'close-lead': 'disqualify',
  'close-case': 'drop',
};

/** Journey actions open their step's card (owner brief, 2026-10-11). */
const ACTION_STEP: Record<string, string> = { consent: '2', safety: '3', review: '6', onboarding: '6', hire: '8' };

/** ?tab= names a view; the old `overview` / `application` tabs are the journey itself now. */
function viewOf(raw: string | undefined): View | null {
  return raw && (VIEWS as readonly string[]).includes(raw) ? (raw as View) : null;
}

/**
 * The candidate (owner, 2026-10-11): one navigation — the nine journey steps, styled as the page's
 * tabs — one content panel for the open step, and the candidate's details once, beside it. Notes
 * open from their own button; the qualification file, full DOT application, offer & onboarding,
 * costs and activity stay one click away under More. Nothing the old page did is gone.
 */
export function RecruitCandidatePage({
  candidateKey,
  applicant,
  hiringCase,
}: {
  candidateKey: string;
  applicant?: ApplicantRecord;
  hiringCase?: HiringCase;
}) {
  const query = useRecruitCandidate(candidateKey);
  const raw = useSearch({ strict: false }) as { tab?: string; action?: string; step?: string };
  const navigate = useNavigate();
  const view = viewOf(raw.tab);
  const setView = (next: View | null) => void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, tab: next ?? undefined })) as never, replace: true });
  // A status picked from the list's badge arrives as ?action=… and opens its dialog here once.
  const [dialog, setDialog] = useState<Dialog>(() => ACTION_DIALOG[raw.action ?? ''] ?? null);
  useEffect(() => {
    if (raw.action) void navigate({ to: '.', search: { tab: raw.tab, step: ACTION_STEP[raw.action] } as never, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { toast } = useToast();
  const contacted = useRecruitMutation((leadId: string) => recruitApi.markContacted(leadId));
  const noAnswer = useRecruitMutation((leadId: string) => recruitApi.markNoAnswer(leadId));
  // A lead that became a candidate (e.g. it applied through its personal link) opens under the
  // candidate's own key, so the Documents tab and More have the hiring case behind them.
  const movedTo = candidateKey.startsWith('lead_') && query.data?.applicantId ? query.data.applicantId : null;
  useEffect(() => {
    if (movedTo) void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: movedTo }, search: { tab: raw.tab, step: raw.step } as never, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movedTo]);

  if (query.isPending) {
    return (
      <Shell name={null}>
        <QuietState title="Loading…" description="Getting the candidate." testId="candidate-loading" />
      </Shell>
    );
  }
  if (query.error || !query.data) {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    return (
      <Shell name={null}>
        <QuietState
          tone="error"
          title={status === 403 ? 'This candidate is assigned to another recruiter' : status === 404 ? 'That candidate is not on file' : 'The candidate could not be loaded'}
          description={query.error instanceof ApiError ? query.error.message : 'Check the connection and try again.'}
          action={status === 0 || status >= 500 ? <Button variant="outline" onClick={() => void query.refetch()}>Try again</Button> : undefined}
          testId="candidate-error"
        />
      </Shell>
    );
  }
  const c = query.data;
  const canManage = c.permissions.canManage;
  const caseClosable = Boolean(hiringCase && canDropCase(hiringCase));
  const onStatus = (a: StatusAction) => {
    if (a === 'contacted') markContacted(c);
    else if (a === 'no-answer' && c.leadId)
      noAnswer.mutate(c.leadId, {
        onSuccess: () => toast({ tone: 'success', title: 'Called · no answer' }),
        onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      });
    else if (a === 'prequalify') setDialog('prequalify');
    else if (a === 'link') setDialog('send');
    else if (a === 'close-lead') setDialog('disqualify');
    else if (a === 'close-case') setDialog('drop');
    else void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, step: ACTION_STEP[a] })) as never, replace: true });
  };
  function markContacted(cand: RecruitCandidate) {
    if (!cand.leadId) return;
    contacted.mutate(cand.leadId, {
      onSuccess: () => toast({ tone: 'success', title: 'Marked as contacted' }),
      onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <Shell name={c.name}>
      <header className="flex flex-col gap-5" data-testid="candidate-header">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Initials name={c.name} size="lg" />
          <div className="min-w-0 flex-1">
            <CandidateName candidate={c} canManage={canManage} />
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[15px] text-nw-text-2">
              <span>{c.sourceLabel}</span>
              <span aria-hidden className="text-nw-text-3">·</span>
              <span>Added {longDateTime(c.createdAt)}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <AssigneeMenu candidate={c} />
            <StatusMenu candidate={c} canDropCase={caseClosable} onAction={onStatus} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {c.progress === 'closed' && canManage && ((c.leadId && !c.caseId && c.lead?.status === 'dead') || c.caseState === 'disqualified') ? (
            <Button variant="primary" icon={<RotateCcw />} onClick={() => setDialog('reopen')} data-testid="primary-action">
              Reopen
            </Button>
          ) : null}
          <DropdownMenu
            trigger={
              <Button variant="outline" icon={<MoreHorizontal />} aria-label="More">
                More
              </Button>
            }
          >
            {c.caseId
              ? MORE_VIEWS.map((t) => (
                  <MenuItem key={t} onSelect={() => setView(t)}>
                    {VIEW_LABELS[t]}
                  </MenuItem>
                ))
              : null}
            {c.caseId && canManage ? <MenuItem onSelect={() => setDialog('link')}>Full DOT application link…</MenuItem> : null}
            {canManage && ((c.leadId && !c.caseId && c.lead?.status === 'dead') || c.caseState === 'disqualified') ? (
              <MenuItem onSelect={() => setDialog('reopen')}>Reopen…</MenuItem>
            ) : null}
            {c.leadId && !c.caseId && canManage && c.lead?.status !== 'dead' ? (
              <>
                <MenuItem onSelect={() => setDialog('prequalify')}>{c.lead?.prequalified ? 'Prequalification answers…' : 'Prequalify…'}</MenuItem>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => setDialog('disqualify')}>
                  Disqualify lead…
                </MenuItem>
              </>
            ) : null}
            {hiringCase && canManage && canDropCase(hiringCase) ? (
              <>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => setDialog('drop')}>
                  Drop from hiring…
                </MenuItem>
              </>
            ) : null}
            {!c.caseId && !canManage ? <MenuItem disabled>No more actions</MenuItem> : null}
          </DropdownMenu>
          {c.followUp ? <FollowUpChip candidate={c} canManage={canManage} /> : null}
        </div>
      </header>

      {/* One navigation: the nine steps as tabs, with Notes beside them. */}
      <JourneyNav
        candidate={c}
        active={view === null}
        trailing={
          <Button variant={view === 'notes' ? 'secondary' : 'ghost'} size="sm" icon={<StickyNote />} onClick={() => setView(view === 'notes' ? null : 'notes')} aria-pressed={view === 'notes'} data-testid="notes-button">
            Notes
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ContactCard candidate={c} />
        <div className="flex min-w-0 flex-col gap-4" data-testid="content-panel">
          {view ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setView(null)} className="flex items-center gap-1.5 text-sm font-medium text-nw-accent-ink hover:underline" data-testid="back-to-journey">
                  <ArrowLeft aria-hidden className="size-4" />
                  Back to the journey
                </button>
                <h2 className="text-lg font-bold text-nw-text">{VIEW_LABELS[view]}</h2>
              </div>
              {view === 'notes' ? (
                <NotesTab candidate={c} />
              ) : view === 'documents' ? (
                hiringCase ? (
                  <DocumentsTab candidate={c} hiringCase={hiringCase} summary={<HistoryAndConsents candidate={c} />} />
                ) : (
                  <RecruitCard>
                    <QuietState title="No documents yet" description="Documents arrive with the application: once the candidate submits it, their CDL and medical card land here for review." />
                  </RecruitCard>
                )
              ) : hiringCase && applicant ? (
                view === 'dot' ? (
                  <DotApplicationWizard hiringCase={hiringCase} candidate={applicant} canEdit={canManage} />
                ) : view === 'onboarding' ? (
                  <DriverFunnelPanel hiringCase={hiringCase} />
                ) : view === 'costs' ? (
                  <CostsPanel hiringCase={hiringCase} />
                ) : (
                  <ActivityFeed caseId={hiringCase.id} />
                )
              ) : (
                <RecruitCard>
                  <QuietState title="Not a candidate yet" description="This opens once the lead has an application." />
                </RecruitCard>
              )}
            </>
          ) : (
            <JourneyContent
              candidate={c}
              extra={{
                // An application that came the earlier way (full DOT form, an external form) shows in its step.
                6:
                  (c.application.state !== 'none' && c.application.state !== 'draft') || c.application.external ? (
                    <ApplicationTab candidate={c} hiringCase={hiringCase} onCopy={() => setDialog('send')} onFull={() => setView('dot')} />
                  ) : null,
                7: hiringCase ? (
                  <Button variant="outline" icon={<FolderOpen />} onClick={() => setView('documents')} className="w-fit" data-testid="open-qualification-file">
                    Open the qualification file
                  </Button>
                ) : null,
              }}
            />
          )}
        </div>
      </div>

      {dialog === 'send' ? <SendApplicationModal candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'link' ? <CopyLinkModal candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'reminder' ? <ReminderModal candidate={c} onClose={() => setDialog(null)} onNewLink={() => setDialog('send')} /> : null}
      {dialog === 'safety' ? <SendToSafetyModal candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'safety-review' ? <SafetyReviewModal candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'hire' ? <HireModal candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'prequalify' || dialog === 'disqualify' ? <LeadDialog leadId={c.leadId ?? ''} kind={dialog} onClose={() => setDialog(null)} /> : null}
      {dialog === 'reopen' ? (
        <ReopenLeadModal candidateKey={c.key} name={c.name} deadReason={c.lead?.deadReason ?? null} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'drop' && hiringCase ? <DropCaseDialog hiringCase={hiringCase} onClose={() => setDialog(null)} /> : null}
    </Shell>
  );
}

function LeadDialog({ leadId, kind, onClose }: { leadId: string; kind: 'prequalify' | 'disqualify'; onClose: () => void }) {
  const lead = useLead(leadId);
  if (!lead.data) return null;
  return kind === 'prequalify' ? <PrequalifyModal lead={lead.data} onClose={onClose} /> : <DisqualifyModal lead={lead.data} onClose={onClose} />;
}

/** The page frame: breadcrumb, Back to leads (to the same list, filters and place). */
function Shell({ name, children }: { name: string | null; children: ReactNode }) {
  const router = useRouter();
  const back = () => {
    // The list keeps its filters and scroll in the history entry; fall back to the list itself.
    const index = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0;
    if (index > 0) router.history.back();
    else void router.navigate({ to: '/hr/recruiting' });
  };
  return (
    <div className="flex w-full flex-col gap-5 pb-10" data-testid="candidate-page">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-nw-text-3">
        <span>Workspace</span>
        <ChevronRight aria-hidden className="size-3" />
        <Link to="/hr/recruiting" className="hover:text-nw-text hover:underline">
          Recruiting
        </Link>
        {name ? (
          <>
            <ChevronRight aria-hidden className="size-3" />
            <span className="truncate text-nw-text">{name}</span>
          </>
        ) : null}
      </nav>
      <button type="button" onClick={back} className="flex w-fit items-center gap-1.5 text-sm font-medium text-nw-text-2 hover:text-nw-text" data-testid="back-to-leads">
        <ArrowLeft aria-hidden className="size-4" />
        Back to leads
      </button>
      {children}
    </div>
  );
}

/**
 * The candidate's name with a pencil to correct it in place (owner, 2026-10-21): First / Last as
 * the lead and the candidate record keep them. Enter saves, Escape cancels; a stale save is refused
 * by the server and said here. A hired driver's profile is renamed in Drivers, not from here.
 */
function CandidateName({ candidate: c, canManage }: { candidate: RecruitCandidate; canManage: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(c.firstName);
  const [last, setLast] = useState(c.lastName);
  const [error, setError] = useState<string | null>(null);
  const save = useRecruitMutation((body: RenameCandidateInput) => recruitApi.rename(c.key, body));
  const hired = Boolean(c.hire.hiredAt) || c.progress === 'hired';

  const open = () => {
    setFirst(c.firstName);
    setLast(c.lastName);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    if (save.isPending) return;
    setEditing(false);
    setError(null);
  };
  const submit = () => {
    const firstName = first.trim();
    const lastName = last.trim();
    if (!firstName) {
      setError('Enter the first name.');
      return;
    }
    if (firstName === c.firstName && lastName === c.lastName) {
      setEditing(false);
      return;
    }
    setError(null);
    save.mutate(
      { firstName, lastName, version: c.version },
      {
        onSuccess: (result) => {
          setEditing(false);
          toast({ tone: 'success', title: 'Name changed', description: result.driverNotice ?? undefined });
        },
        onError: (e) =>
          setError(
            e instanceof ApiError
              ? e.status === 409
                ? 'This candidate changed since you opened it. Reload the page and try again.'
                : e.message
              : 'The name was not saved. Try again.',
          ),
      },
    );
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="text-[28px] leading-tight font-bold tracking-tight break-words text-nw-text" data-testid="candidate-name">
          {c.name}
        </h1>
        {canManage ? (
          <IconButton label="Edit name" size="sm" onClick={open} data-testid="edit-name">
            <Pencil />
          </IconButton>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="edit-name-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="First name"
          placeholder="First name"
          value={first}
          maxLength={40}
          autoFocus
          invalid={Boolean(error) && !first.trim()}
          onChange={(e) => setFirst(e.target.value)}
          className="w-44"
          data-testid="edit-first-name"
        />
        <Input
          aria-label="Last name"
          placeholder="Last name"
          value={last}
          maxLength={40}
          onChange={(e) => setLast(e.target.value)}
          className="w-52"
          data-testid="edit-last-name"
        />
        <Button type="submit" variant="primary" size="sm" loading={save.isPending} data-testid="save-name">
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={save.isPending} data-testid="cancel-name">
          Cancel
        </Button>
      </div>
      {hired ? <p className="text-xs text-nw-text-3">Renames the candidate in Recruiting only. The driver profile is renamed in Drivers.</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-nw-urgent-text" data-testid="edit-name-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function FollowUpChip({ candidate, canManage }: { candidate: RecruitCandidate; canManage: boolean }) {
  const { toast } = useToast();
  const done = useRecruitMutation(() => recruitApi.followUpDone(candidate.key));
  const f = candidate.followUp;
  if (!f) return null;
  const due = f.state === 'overdue' || f.state === 'today';
  return (
    <span
      className={cn(
        'inline-flex h-10 items-center gap-2 rounded-[10px] border px-3 text-sm',
        due ? 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text' : 'border-nw-border bg-nw-subtle text-nw-text-2',
      )}
      data-testid="follow-up-chip"
    >
      <CalendarDays aria-hidden className="size-4" />
      Follow-up {followUpLabel(f.on, f.state, undefined)}
      {canManage ? (
        <button
          type="button"
          disabled={done.isPending}
          onClick={() => done.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Follow-up done' }) })}
          className="ml-1 rounded-md px-1.5 py-0.5 text-xs font-semibold underline-offset-2 hover:underline"
        >
          Done
        </button>
      ) : null}
    </span>
  );
}

function ContactCard({ candidate: c }: { candidate: RecruitCandidate }) {
  return (
    <aside className="flex h-fit flex-col rounded-xl border border-nw-border bg-nw-panel" data-testid="contact-card">
      <section className="px-4 py-4">
        <h2 className="mb-3 text-[15px] font-semibold text-nw-text">Candidate information</h2>
        <ul className="flex flex-col gap-2.5 text-sm text-nw-text-2">
          <li className="flex items-center gap-3 break-all">
            <Mail aria-hidden className="size-4 shrink-0 text-nw-text-3" />
            {c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : <span className="text-nw-text-3">No email</span>}
          </li>
          <li className="flex items-center gap-3">
            <Phone aria-hidden className="size-4 shrink-0 text-nw-text-3" />
            {c.phone ? <a href={`tel:${c.phone.replace(/[^d+]/g, '')}`} className="hover:underline">{c.phone}</a> : <span className="text-nw-text-3">No phone</span>}
          </li>
          <li className="flex items-center gap-3">
            <MapPin aria-hidden className="size-4 shrink-0 text-nw-text-3" />
            {c.location ?? <span className="text-nw-text-3">Location not given</span>}
          </li>
        </ul>
      </section>
      <section className="border-t border-nw-border px-4 py-4">
        <h3 className="mb-2 text-sm font-medium text-nw-text-2">Source</h3>
        <p className="flex items-center gap-2.5 text-sm text-nw-text" data-testid="contact-source">
          <SourceIcon source={c.source} />
          {c.sourceLabel}
        </p>
      </section>
      <section className="border-t border-nw-border px-4 py-4">
        <h3 className="mb-2 text-sm font-medium text-nw-text-2">Lead created</h3>
        <p className="flex items-center gap-2.5 text-sm text-nw-text">
          <CalendarDays aria-hidden className="size-4 shrink-0 text-nw-text-3" />
          {longDate(c.createdAt)}
        </p>
      </section>
      <section className="border-t border-nw-border px-4 py-4">
        <h3 className="mb-2 text-sm font-medium text-nw-text-2">Recruiter</h3>
        <PersonChip name={c.recruiter?.name ?? null} size="md" />
      </section>
      <section className="border-t border-nw-border px-4 py-4">
        <h3 className="mb-2 text-sm font-medium text-nw-text-2">Follow-up</h3>
        <p className="text-sm text-nw-text" data-testid="contact-follow-up">
          {c.followUp ? followUpLabel(c.followUp.on, c.followUp.state, undefined) : <span className="text-nw-text-3">None set</span>}
        </p>
      </section>
    </aside>
  );
}


// -------------------------------------------------------------------------------- application

function ApplicationTab({
  candidate: c,
  hiringCase,
  onCopy,
  onFull,
}: {
  candidate: RecruitCandidate;
  hiringCase?: HiringCase;
  onCopy: () => void;
  onFull: () => void;
}) {
  const a = c.application;
  const dot = useDotApplication(hiringCase?.id ?? null, { poll: false });
  const personal = c.driverApplication.submission ? <PersonalApplication candidate={c} /> : null;
  if (a.state === 'none' || a.state === 'draft') {
    if (personal) return personal;
    if (a.external) return <ExternalApplication candidate={c} hiringCase={hiringCase} onFull={onFull} />;
    return (
      <RecruitCard testId="application-not-submitted">
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-nw-subtle text-nw-text-3">
            <FileText aria-hidden className="size-7" />
          </span>
          <p className="text-lg font-semibold text-nw-text">Application not submitted</p>
          <p className="max-w-md text-sm text-nw-text-3">
            {a.state === 'draft'
              ? `${c.name.split(' ')[0]} has started the application${a.link?.lastSavedAt ? ` (last saved ${formatDateTime(a.link.lastSavedAt)})` : ''} but has not submitted it yet.`
              : `${c.name.split(' ')[0]} hasn't started the application yet.`}
          </p>
          <SessionLine session={c.driverApplication.session} />
          {a.link ? (
            <p className="text-xs text-nw-text-3" data-testid="dot-link-status">
              Link made {shortDate(a.link.createdAt)} · {a.link.state === 'live' ? `works until ${shortDate(a.link.expiresAt)}` : a.link.state}
              {a.link.firstOpenedAt ? ` · opened ${formatDateTime(a.link.firstOpenedAt)}` : ' · not opened yet'}
              {a.markedSentAt ? ` · you marked it sent ${formatDateTime(a.markedSentAt)}` : ''}
            </p>
          ) : null}
          {/* The invite waits for Safety (owner brief, 2026-10-11); the journey above says what is next. */}
          {c.permissions.canManage && (c.journeyState.safety === 'approved' || !c.journeyState.consentFirst || c.driverApplication.session) ? (
            <Button variant="primary" size="lg" icon={<Link2 />} onClick={onCopy} data-testid="send-application">
              Send application
            </Button>
          ) : c.journeyState.consentFirst ? (
            <p className="text-sm text-nw-text-3">The application link is sent after the consent is signed and Safety approves.</p>
          ) : null}
          {a.returnNote ? <Alert tone="info" title="Returned to the driver">{a.returnNote}</Alert> : null}
        </div>
      </RecruitCard>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="application-submitted">
      {personal}
      {a.state === 'driver_submitted' && hiringCase && dot.data ? (
        <DriverReviewBanner hiringCase={hiringCase} application={dot.data} canEdit={c.permissions.canManage} />
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-sm text-nw-text-2">
        <StatusSymbol family="done" size={14} className="text-nw-done-icon" />
        {a.state === 'submitted' ? 'Filed' : 'Submitted by the driver'} {formatDateTime(a.certifiedAt ?? a.submittedAt ?? '')}
        {a.certifiedName ? ` · certified by ${a.certifiedName}` : ''}
        {a.reviewedBy ? ` · accepted by ${a.reviewedBy}` : ''}
      </p>
      {a.summary ? <ApplicationSummary candidate={c} onFull={onFull} /> : null}
    </div>
  );
}

function ApplicationSummary({ candidate: c, onFull }: { candidate: RecruitCandidate; onFull: () => void }) {
  const s = c.application.summary;
  if (!s) return null;
  return (
    <>
      <RecruitCard title="Personal information" action={c.caseId ? <Button variant="ghost" size="sm" onClick={onFull}>View full application</Button> : null} testId="app-personal">
        <Grid>
          <Item label="Full name">{s.personal.legalName}</Item>
          <Item label="Date of birth">{longDate(s.personal.dateOfBirth)}</Item>
          <Item label="Address">{s.personal.currentAddress ?? '—'}</Item>
          <Item label="Phone">{c.phone ?? '—'}</Item>
          <Item label="Email">{c.email ?? '—'}</Item>
          <Item label="SSN">{s.personal.ssnMasked ?? '—'}</Item>
        </Grid>
      </RecruitCard>
      <RecruitCard title="CDL & experience" testId="app-cdl">
        <Grid>
          <Item label="CDL class">{s.cdl.licenseClass ? `Class ${s.cdl.licenseClass}` : '—'}</Item>
          <Item label="CDL number">{s.cdl.numberMasked ?? '—'}</Item>
          <Item label="State">{s.cdl.state ?? '—'}</Item>
          <Item label="Expiration date">{longDate(s.cdl.expiresOn)}</Item>
          <Item label="Endorsements">{s.cdl.endorsements.length ? s.cdl.endorsements.join(', ') : 'None'}</Item>
          <Item label="Employers listed">{`${s.experience.employers} (${s.experience.cmvEmployers} driving)`}</Item>
          <Item label="Most recent">{s.experience.mostRecent ? `${s.experience.mostRecent.employer} · ${s.experience.mostRecent.position}` : '—'}</Item>
        </Grid>
      </RecruitCard>
      <Collapsible title={`Driving history · ${s.drivingHistory.accidents.length} accident${s.drivingHistory.accidents.length === 1 ? '' : 's'}, ${s.drivingHistory.convictions.length} conviction${s.drivingHistory.convictions.length === 1 ? '' : 's'}`}>
        {s.drivingHistory.accidents.length + s.drivingHistory.convictions.length === 0 ? (
          <p className="text-sm text-nw-text-2">No accidents or convictions in the last three years.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-nw-text-2">
            {s.drivingHistory.accidents.map((x, i) => (
              <li key={`a${i}`}>Accident · {shortDate(x.date)} · {x.location} · {x.nature}</li>
            ))}
            {s.drivingHistory.convictions.map((x, i) => (
              <li key={`c${i}`}>Conviction · {shortDate(x.date)} · {x.location} · {x.offense}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-nw-text-2">Licence denied, suspended or revoked: {s.drivingHistory.licenseDeniedOrRevoked ? 'Yes' : 'No'}</p>
      </Collapsible>
      <Collapsible title="Documents & consents">
        <ul className="flex flex-col gap-1.5 text-sm text-nw-text-2">
          <li>Certified by {s.certifiedName ?? '—'} on {s.certifiedOn ? shortDate(s.certifiedOn) : '—'}</li>
          <li>{s.consents.count} previous-employer verification consent{s.consents.count === 1 ? '' : 's'} drafted</li>
          {c.application.documentId && c.caseId ? (
            <li>
              <button
                type="button"
                className="font-semibold text-nw-accent-ink hover:underline"
                onClick={() => void downloadAuthed(caseDocumentFileUrl(c.caseId as string, c.application.documentId as string), `application-${c.applicantNumber ?? c.key}.pdf`)}
              >
                Download the filed application (PDF)
              </button>
            </li>
          ) : null}
        </ul>
        {c.caseId ? <StagedDriverFiles caseId={c.caseId} /> : null}
      </Collapsible>
    </>
  );
}

function ExternalApplication({ candidate: c, hiringCase, onFull }: { candidate: RecruitCandidate; hiringCase?: HiringCase; onFull: () => void }) {
  const x = c.application.external;
  if (!x) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="external-application">
      <Alert tone="info" title={`Application received ${formatDateTime(x.receivedAt)} · ${x.reference}`}>
        Sent from the online driver application. Review it, then complete the DOT application from these answers — nothing is filed until a recruiter
        does.
      </Alert>
      <RecruitCard title="Answers" action={hiringCase ? <Button variant="ghost" size="sm" onClick={onFull}>Open the DOT application</Button> : null}>
        <Grid>
          {x.answers.map((a) => (
            <Item key={a.label} label={a.label}>
              {a.value}
            </Item>
          ))}
        </Grid>
      </RecruitCard>
      {c.caseId ? <StagedDriverFiles caseId={c.caseId} /> : null}
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2 xl:grid-cols-3">{children}</dl>;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-nw-text-3">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-nw-text">{children}</dd>
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-nw-border bg-nw-panel">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="text-sm font-semibold text-nw-text">{title}</span>
        <ChevronDown aria-hidden className={cn('size-4 text-nw-text-3 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
      {open ? <div className="border-t border-nw-border px-4 py-3">{children}</div> : null}
    </section>
  );
}

/** Driving history and consents, collapsible, under the documents (mockup 142). */
function HistoryAndConsents({ candidate: c }: { candidate: RecruitCandidate }) {
  const s = c.application.summary;
  return (
    <>
      <Collapsible title="Driving history">
        {!s ? (
          <p className="text-sm text-nw-text-3">Shows once the application is submitted.</p>
        ) : s.drivingHistory.accidents.length + s.drivingHistory.convictions.length === 0 ? (
          <p className="text-sm text-nw-text-2">No accidents or convictions in the last three years. Licence denied, suspended or revoked: {s.drivingHistory.licenseDeniedOrRevoked ? 'Yes' : 'No'}.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-nw-text-2">
            {s.drivingHistory.accidents.map((x, i) => (
              <li key={`a${i}`}>Accident · {shortDate(x.date)} · {x.location} · {x.nature}</li>
            ))}
            {s.drivingHistory.convictions.map((x, i) => (
              <li key={`c${i}`}>Conviction · {shortDate(x.date)} · {x.location} · {x.offense}</li>
            ))}
          </ul>
        )}
      </Collapsible>
      <Collapsible title="Consents" defaultOpen={Boolean(c.driverApplication.submission)}>
        {c.driverApplication.submission ? (
          <div className="mb-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-nw-text-3 uppercase">Report authorizations (driver application)</p>
            <ApplicationConsents candidate={c} />
          </div>
        ) : null}
        {!s ? (
          <p className="text-sm text-nw-text-3">{c.driverApplication.submission ? 'DOT application consents show once the full DOT application is submitted.' : 'Shows once the application is submitted.'}</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-nw-text-2">
            <li>Application certified by {s.certifiedName ?? '—'} on {longDate(s.certifiedOn)}</li>
            <li>{s.consents.count} previous-employer verification consent{s.consents.count === 1 ? '' : 's'} drafted</li>
          </ul>
        )}
      </Collapsible>
    </>
  );
}

// -------------------------------------------------------------------------------------- notes

function NotesTab({ candidate: c }: { candidate: RecruitCandidate }) {
  const { toast } = useToast();
  const notes = useRecruitNotes(c.key);
  const save = useRecruitMutation((body: { note: string; followUpOn: string | null }) => recruitApi.addNote(c.key, body));
  const [text, setText] = useState('');
  const [followUpOn, setFollowUpOn] = useState('');
  const [tried, setTried] = useState(false);
  const empty = text.trim().length === 0;
  return (
    <div className="flex flex-col gap-4" data-testid="notes-tab">
      {notes.isPending ? (
        <RecruitCard>
          <QuietState title="Loading…" />
        </RecruitCard>
      ) : notes.error ? (
        <RecruitCard>
          <QuietState tone="error" title="The notes could not be loaded" action={<Button variant="outline" onClick={() => void notes.refetch()}>Try again</Button>} />
        </RecruitCard>
      ) : (notes.data ?? []).length === 0 ? (
        <RecruitCard>
          <QuietState title="No notes yet" description="Write what happened on the call, and set a follow-up date if you need to come back." />
        </RecruitCard>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="notes-timeline">
          {(notes.data ?? []).map((n) => (
            <li key={n.id} className="flex gap-3.5 rounded-xl border border-nw-border bg-nw-panel px-4 py-3.5" data-testid="note-row">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-nw-subtle text-sm font-semibold text-nw-text-2 ring-1 ring-nw-border">
                {(n.byName.trim()[0] ?? '?').toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2.5 text-sm">
                  <span className="font-semibold text-nw-text">{n.byName.split(' ')[0]}</span>
                  <span className="text-xs text-nw-text-3">{formatDateTime(n.at)}</span>
                  {n.kind === 'follow_up' ? <span className="text-xs text-nw-text-3">· {n.summary}</span> : null}
                  {n.kind === 'follow_up_done' ? <span className="text-xs text-nw-text-3">· {n.summary}</span> : null}
                </p>
                {n.text ? <p className="mt-1 text-[15px] whitespace-pre-wrap break-words text-nw-text">{n.text}</p> : null}
                {n.followUpOn ? (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-nw-text-2">
                    <CalendarDays aria-hidden className="size-3.5" /> Follow-up set for {shortDate(n.followUpOn)}
                  </p>
                ) : null}
              </div>
              <span className="self-start">
                <NoteMenu note={n} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {c.permissions.canManage ? (
        <form
          className="flex flex-col gap-3 rounded-xl border border-nw-border bg-nw-panel p-4"
          data-testid="note-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (empty) return;
            save.mutate(
              { note: text.trim(), followUpOn: followUpOn || null },
              {
                onSuccess: () => {
                  setText('');
                  setFollowUpOn('');
                  setTried(false);
                  toast({ tone: 'success', title: 'Note saved' });
                },
              },
            );
          }}
        >
          <label htmlFor="note-text" className="text-[15px] font-semibold text-nw-text">
            Write a note
          </label>
          <Textarea id="note-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note about this candidate…" invalid={tried && empty} />
          {tried && empty ? <p className="text-xs text-nw-urgent-text">Write the note first.</p> : null}
          {save.error ? (
            <Alert tone="danger" title="The note was not saved">
              {save.error instanceof ApiError ? save.error.message : 'Check the connection and try again.'} Your text is still here.
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex flex-wrap items-center gap-2.5 text-sm text-nw-text-2">
              <CalendarDays aria-hidden className="size-4" />
              Follow-up date (optional)
              <span className="w-48">
                <DatePicker aria-label="Follow-up date" value={followUpOn || null} onIsoChange={(v) => setFollowUpOn(v)} placeholder="Select date" />
              </span>
            </label>
            <Button type="submit" variant="primary" className="h-11 min-w-[150px] rounded-[10px] text-[15px]" loading={save.isPending} data-testid="save-note">
              Save note
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

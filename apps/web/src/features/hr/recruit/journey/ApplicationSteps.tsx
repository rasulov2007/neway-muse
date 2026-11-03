import { ArrowRight, FileSearch } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DOT_APP_EDITABLE, type CandidateJourney, type DriverApplicationLinkIssued, type RecruitCandidate } from '@neway/shared';
import { Button, StatusSymbol, cn, useToast } from '@/design-system';
import { copyText } from '@/lib/clipboard';
import { PersonalApplication } from '../DriverApplicationParts';
import { longDateTime } from '../recruit-format';
import { driverApplicationUrls, recruitApi } from '../useRecruit';
import { journeyApi, journeyUrls } from '../useJourney';
import { DocRow, Pill, StepCard } from './JourneyKit';
import { errorText, useJourneyMutation } from './journey-utils';
import { SimpleLinkCard } from './SimpleLinkCard';
import { DotAppReceivedCard, DotAppStepCard } from './DotAppSendCard';
import { useDotAppRecruiter } from '@/features/dot-application/api';
import { useAccount } from '@/features/auth/auth-context';

/**
 * Step 5 — Send application. Only after Safety approves (the server refuses earlier). The driver
 * does not type their name, phone or email again, nor upload the CDL front, nor sign MVR/PSP again:
 * those come from the signed consent the TMS holds.
 */
export function SendApplicationStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const dot = useDotAppRecruiter(c.key);
  const company = useAccount()?.companyName ?? 'the company';
  if (dot.isPending) {
    return (
      <StepCard step={5} title="Send application" testId="step-send-application">
        <p className="text-sm text-nw-text-3">Loading…</p>
      </StepCard>
    );
  }
  // The DOT application v2 once every document of the company is approved; until then the
  // application that has been in use, exactly as it was, with a note on what v2 waits for.
  if (dot.data?.available) return <DotAppStepCard candidate={c} journey={j} view={dot.data} safetyApproved={<SafetyApprovedNote journey={j} />} />;
  return (
    <>
      <LegacySendApplicationStep candidate={c} journey={j} />
      {dot.data ? (
        <p className="-mt-2 px-1 text-xs text-nw-text-3" data-testid="dot-app-awaiting-note">
          New DOT application: awaiting {company} approved documents ({dot.data.awaitingDocs.length}) — Admin → Document templates
        </p>
      ) : null}
    </>
  );
}

function SafetyApprovedNote({ journey: j }: { journey: CandidateJourney }) {
  if (j.safety.review?.status !== 'approved') return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-nw-done-border bg-nw-done-bg px-4 py-3">
      <StatusSymbol family="done" size={18} className="mt-px text-nw-done-icon" />
      <div>
        <p className="text-sm font-semibold text-nw-done-text">Safety approved</p>
        <p className="text-xs text-nw-done-text">
          Approved by {j.safety.review.decidedByName ?? 'Safety'} on {longDateTime(j.safety.review.decidedAt ?? j.safety.review.openedAt)}.
        </p>
      </div>
    </div>
  );
}

function LegacySendApplicationStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const [issued, setIssued] = useState<DriverApplicationLinkIssued | null>(null);
  const make = useJourneyMutation(() => recruitApi.issueApplication(c.key));
  const copied = useJourneyMutation(() => recruitApi.applicationCopied(c.key));
  const mark = useJourneyMutation(() => recruitApi.applicationMarkSent(c.key, null));
  const session = c.driverApplication.session ?? issued?.session ?? null;
  const live = session?.state === 'live';
  const copy = async (text: string) => {
    const ok = await copyText(text).then(() => true).catch(() => false);
    if (!ok) return toast({ tone: 'danger', title: 'Could not copy', description: 'Select the link and copy it by hand.' });
    copied.mutate(undefined);
    toast({ tone: 'success', title: 'Link copied', description: 'Send it to the driver, then mark it as sent.' });
  };
  return (
    <StepCard step={5} title="Send application" subtitle="Send the driver the application link once Safety approved." testId="step-send-application">
      {j.safety.review?.status === 'approved' ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-nw-done-border bg-nw-done-bg px-4 py-3">
          <StatusSymbol family="done" size={18} className="mt-px text-nw-done-icon" />
          <div>
            <p className="text-sm font-semibold text-nw-done-text">Safety approved</p>
            <p className="text-xs text-nw-done-text">
              Approved by {j.safety.review.decidedByName ?? 'Safety'} on {longDateTime(j.safety.review.decidedAt ?? j.safety.review.openedAt)}.
            </p>
          </div>
        </div>
      ) : null}
      <SimpleLinkCard
        title="Application link"
        url={issued && live ? issued.url : null}
        live={live}
        sentAt={live ? (session?.markedSentAt ?? null) : null}
        canManage={j.permissions.canManage}
        blockedReason={j.application.canSend ? null : (j.application.blockedReason ?? 'Waiting for Safety')}
        creating={make.isPending}
        marking={mark.isPending}
        onCreate={() => make.mutate(undefined, { onSuccess: (r) => setIssued(r), onError: (e) => toast({ tone: 'danger', title: 'No link made', description: errorText(e) }) })}
        onCopy={(u) => void copy(u)}
        onMarkSent={() => mark.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Marked as sent' }), onError: (e) => toast({ tone: 'danger', title: 'Not marked', description: errorText(e) }) })}
        testId="application-link"
      />
    </StepCard>
  );
}

/**
 * Step 6 for either application: a submitted DOT application v2 is in Safety's queue (its card
 * says so and links there); otherwise the legacy application as before, or the waiting note.
 */
export function ApplicationReceivedAny({ candidate: c, journey: j, fallback }: { candidate: RecruitCandidate; journey: CandidateJourney; fallback: ReactNode }) {
  const dot = useDotAppRecruiter(c.key);
  const app = dot.data?.application ?? null;
  if (app && app.submittedAt && !DOT_APP_EDITABLE.includes(app.status)) return <DotAppReceivedCard app={app} />;
  if (c.driverApplication.submission) return <ApplicationReceivedStep candidate={c} journey={j} />;
  return <>{fallback}</>;
}

/**
 * Step 6 — Application received. Details and Documents; the CDL front is the consent's, marked so.
 * Review application records that someone read it; Start onboarding follows the review.
 */
export function ApplicationReceivedStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<'details' | 'documents'>('documents');
  const review = useJourneyMutation(() => journeyApi.applicationReviewed(c.key));
  const start = useJourneyMutation(() => journeyApi.startOnboarding(c.key));
  const s = c.driverApplication.submission;
  if (!s) return null;
  const reviewed = Boolean(j.application.reviewedAt);
  const front = j.consent.submission?.files[0] ?? null;
  return (
    <StepCard
      step={6}
      title="Application received"
      subtitle={`Received ${longDateTime(s.receivedAt)} · reference ${s.reference}`}
      testId="step-application-received"
      footnote="The application and its files are saved in the TMS. Review it, then start onboarding."
      actions={
        j.permissions.canManage ? (
          <>
            <Button
              variant={reviewed ? 'outline' : 'primary'}
              icon={<FileSearch />}
              disabled={reviewed}
              loading={review.isPending}
              onClick={() => review.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Application reviewed' }), onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }) })}
              data-testid="review-application"
            >
              {reviewed ? `Reviewed by ${j.application.reviewedBy ?? 'recruiting'}` : 'Review application'}
            </Button>
            <Button
              variant="primary"
              iconRight={<ArrowRight />}
              disabled={!reviewed}
              title={reviewed ? undefined : 'Review the application first'}
              loading={start.isPending}
              onClick={() => start.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Onboarding started' }), onError: (e) => toast({ tone: 'danger', title: 'Not started', description: errorText(e) }) })}
              data-testid="start-onboarding"
            >
              Start onboarding
            </Button>
          </>
        ) : null
      }
    >
      <nav className="flex gap-1 rounded-lg border border-nw-border bg-nw-subtle p-1" role="tablist">
        {(['details', 'documents'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('h-9 flex-1 rounded-md text-sm font-semibold', tab === t ? 'bg-nw-panel text-nw-text shadow-segment' : 'text-nw-text-3 hover:text-nw-text-2')}
          >
            {t === 'details' ? 'Details' : 'Documents'}
          </button>
        ))}
      </nav>
      {tab === 'details' ? (
        <PersonalApplication candidate={c} />
      ) : (
        <ul className="rounded-xl border border-nw-border px-3" data-testid="application-documents">
          <DocRow
            label="Application (PDF)"
            detail={`Reference ${s.reference} · SSN masked`}
            status={<Pill family="done">Received</Pill>}
            view={{ url: driverApplicationUrls.applicationPdf(c.key), title: 'Driver application', contentType: 'application/pdf', fileName: `driver-application-${s.reference}.pdf` }}
            download={{ url: driverApplicationUrls.applicationPdf(c.key), fileName: `driver-application-${s.reference}.pdf` }}
          />
          {front ? (
            <DocRow
              label="CDL (front)"
              detail={front.fileName}
              status={<Pill family="done">Inherited from consent</Pill>}
              view={{ url: journeyUrls.consentFile(c.key, front.id), title: 'CDL (front)', contentType: front.contentType, fileName: front.fileName }}
              download={{ url: journeyUrls.consentFile(c.key, front.id), fileName: front.fileName }}
              testId="doc-cdl-front-inherited"
            />
          ) : null}
          {s.files.map((f) => (
            <DocRow
              key={f.id}
              label={f.label}
              detail={`${f.fileName} · ${longDateTime(f.uploadedAt)}`}
              status={<Pill family={f.documentStatus === 'verified' ? 'done' : f.documentStatus === 'rejected' ? 'urgent' : 'warning'}>{f.documentStatus === 'verified' ? 'Verified' : f.documentStatus === 'rejected' ? 'Rejected' : 'Received'}</Pill>}
              view={{ url: driverApplicationUrls.file(c.key, f.id), title: f.label, contentType: f.contentType, fileName: f.fileName }}
              download={{ url: driverApplicationUrls.file(c.key, f.id), fileName: f.fileName }}
            />
          ))}
        </ul>
      )}
    </StepCard>
  );
}

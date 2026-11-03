import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight, ExternalLink, Send } from 'lucide-react';
import { useState } from 'react';
import type { CandidateJourney, RecruitCandidate } from '@neway/shared';
import { Button, StatusSymbol } from '@/design-system';
import { ScreeningReports } from '@/features/safety/hiring/ScreeningReports';
import { longDateTime } from '../recruit-format';
import { journeySafetyBase } from '../useJourney';
import { SendToSafetyDialog } from './ConsentSteps';
import { Pill, StepCard } from './JourneyKit';

/**
 * Step 4 — Safety review, as Recruiting sees it (owner, 2026-10-11): sent, waiting for Safety's
 * decision, then Qualified or Not qualified. Safety does the work on its own page (Safety › Hiring
 * decisions); nothing about the application is asked or offered until Safety qualifies.
 */
export function SafetyStatusStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const review = j.safety.review;
  // Recruiting files the reports first, then sends (owner, 2026-10-13); until then it is not Safety's.
  const sent = review !== null && review.status !== 'preparing';
  const qualified = review?.status === 'approved';
  const declined = review?.status === 'declined';
  const signed = j.safety.authorizations.filter((a) => a.signedAt).map((a) => a.label);
  const onFile = (kind: 'mvr' | 'psp') => j.safety.reports.some((r) => r.kind === kind);
  const missing = (['mvr', 'psp'] as const).filter((k) => !onFile(k)).map((k) => k.toUpperCase());
  return (
    <StepCard
      step={4}
      title="Safety review"
      subtitle={
        sent && review
          ? `Sent ${longDateTime(review.openedAt)} by ${review.openedByName}${review.requestNote ? ` · “${review.requestNote}”` : ''}`
          : 'Upload the MVR and PSP reports, then send to Safety.'
      }
      testId="step-safety"
      footnote="Recruiting runs the MVR and PSP (and the optional Clearinghouse queries), files the reports here and sends the candidate to Safety. Safety only decides on Hiring decisions: Qualified, Not qualified, or Insurance check first. The application opens only after Qualified."
      actions={
        <>
          {!sent && j.permissions.canManage ? (
            <Button
              variant="primary"
              icon={<Send />}
              disabled={missing.length > 0}
              title={missing.length > 0 ? `Upload the ${missing.join(' and ')} first` : undefined}
              onClick={() => setSending(true)}
              data-testid="send-to-safety"
            >
              Send to Safety
            </Button>
          ) : null}
          {qualified && j.permissions.canManage ? (
            <Button
              variant="primary"
              iconRight={<ArrowRight />}
              onClick={() => void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, step: '5' })) as never, replace: true })}
              data-testid="go-send-application"
            >
              Send application
            </Button>
          ) : null}
          {sent && j.permissions.canSafety && c.caseId ? (
            <Button variant="outline" icon={<ExternalLink />} asChild>
              <Link to="/safety/hiring" search={{ case: c.caseId } as never} data-testid="open-safety-desk">
                Open in Hiring decisions
              </Link>
            </Button>
          ) : null}
        </>
      }
    >
      {!sent ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="safety-decision">
          {missing.length > 0 ? (
            <Pill family="warning">To upload: {missing.join(' and ')}</Pill>
          ) : (
            <Pill family="done">MVR and PSP on file · ready to send</Pill>
          )}
          <span className="text-sm text-nw-text-3">Signed: {signed.length ? signed.join(', ') : 'nothing yet'}</span>
        </div>
      ) : qualified && review ? (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-nw-done-border bg-nw-done-bg px-4 py-3" data-testid="safety-decision">
          <StatusSymbol family="done" size={18} className="mt-px text-nw-done-icon" />
          <div>
            <p className="text-sm font-semibold text-nw-done-text">Qualified</p>
            <p className="text-xs text-nw-done-text">
              {review.decidedByName ?? 'Safety'}, {longDateTime(review.decidedAt ?? review.openedAt)}
              {review.decisionNote ? ` — ${review.decisionNote}` : ''}
            </p>
          </div>
        </div>
      ) : declined && review ? (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-nw-urgent-border bg-nw-urgent-bg px-4 py-3" data-testid="safety-decision">
          <StatusSymbol family="urgent" size={18} className="mt-px text-nw-urgent-icon" />
          <div>
            <p className="text-sm font-semibold text-nw-urgent-text">Not qualified</p>
            <p className="text-xs text-nw-urgent-text">
              {review.decidedByName ?? 'Safety'}, {longDateTime(review.decidedAt ?? review.openedAt)}
              {review.decisionNote ? ` — ${review.decisionNote}` : ''}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2" data-testid="safety-decision">
          {review?.insurance?.status === 'pending' ? (
            <Pill family="info">Safety is checking with insurance</Pill>
          ) : review?.insurance?.status === 'declined' ? (
            <Pill family="urgent">Insurance declined</Pill>
          ) : review?.insurance?.status === 'approved' ? (
            <Pill family="done">Insurance approved</Pill>
          ) : (
            <Pill family="warning">Waiting for Safety’s decision</Pill>
          )}
          <span className="text-sm text-nw-text-3">Signed: {signed.length ? signed.join(', ') : 'nothing yet'}</span>
          {review?.insurance?.note ? <span className="text-sm text-nw-text-3">· {review.insurance.note}</span> : null}
        </div>
      )}
      {/* Recruiting files the screening reports (owner, 2026-10-12); Safety only decides. */}
      <ScreeningReports base={journeySafetyBase(c.key)} safety={j.safety} editable={j.safety.canUpload && !qualified && !declined} testPrefix="recruit" />
      {sending ? <SendToSafetyDialog candidate={c} onClose={() => setSending(false)} /> : null}
    </StepCard>
  );
}

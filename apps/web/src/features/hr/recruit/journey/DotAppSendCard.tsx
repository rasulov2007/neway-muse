import { Link } from '@tanstack/react-router';
import { ArrowRight, Ban, Copy, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { DOT_APP_EDITABLE, type CandidateJourney, type DotAppIssued, type DotAppRecruiterView, type DotAppSummary, type RecruitCandidate } from '@neway/shared';
import { Alert, Button, Checkbox, ConfirmDialog, FormField, Input, Modal, Select, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { dotAppRecruiterApi } from '@/features/dot-application/api';
import { DOT_APP_JOURNEY, DotAppStatusBadge, EmailStatusBadge, LinkStateBadge, driverNumber } from '@/features/dot-application/status';
import { copyText } from '@/lib/clipboard';
import { nowMs } from '@/lib/clock';
import { longDate, longDateTime } from '../recruit-format';
import { Fact, StepCard } from './JourneyKit';
import { errorText, useJourneyMutation } from './journey-utils';

/**
 * Step 5 with the DOT driver application v2 (owner brief 2026-10-27): one link per candidate for
 * their own company, emailed from NeWay and/or copied into Telegram or WhatsApp. The driver opens
 * it with a 6-digit code sent to their email. No SMS is sent from NeWay.
 */

export const EXPIRY_OPTIONS = [
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
];

export function DotAppStepCard({ candidate: c, journey: j, view, safetyApproved }: { candidate: RecruitCandidate; journey: CandidateJourney; view: DotAppRecruiterView; safetyApproved: React.ReactNode }) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const revoke = useJourneyMutation(() => dotAppRecruiterApi.revoke(c.key));
  const app = view.application;
  const canManage = j.permissions.canManage;
  const editable = !app || DOT_APP_EDITABLE.includes(app.status);
  const linkOpen = app?.link && (app.link.state === 'live' || app.link.state === 'paused');
  return (
    <StepCard
      step={5}
      title="Send application"
      subtitle="The DOT driver application: the driver fills it on their phone, signs each document and submits it to Safety."
      testId="step-send-application"
      actions={
        canManage ? (
          <>
            {!app ? (
              <Button variant="primary" icon={<Send />} disabled={Boolean(view.blockedReason)} onClick={() => setSending(true)} data-testid="dot-app-send">
                Send DOT application
              </Button>
            ) : editable ? (
              <>
                <Button variant="outline" icon={<RotateCcw />} disabled={Boolean(view.blockedReason)} onClick={() => setSending(true)} data-testid="dot-app-resend">
                  Resend
                </Button>
                {linkOpen ? (
                  <Button variant="danger" icon={<Ban />} onClick={() => setRevoking(true)} data-testid="dot-app-revoke">
                    Revoke link
                  </Button>
                ) : null}
              </>
            ) : null}
            {app && !editable && app.status !== 'rejected' ? (
              <Link to="/safety/applications/$applicationId" params={{ applicationId: app.id }} className="inline-flex items-center gap-1.5 text-sm font-semibold text-nw-accent-ink hover:underline">
                Open in Safety review <ArrowRight aria-hidden className="size-4" />
              </Link>
            ) : null}
          </>
        ) : null
      }
      footnote="The link carries only a random one-time token. The driver confirms it is them with a 6-digit code sent to their email, and can continue on any device until the link expires. Sending again makes a new link; the old one stops working."
    >
      {safetyApproved}
      {!app && view.blockedReason ? (
        <Alert tone="info" title="Not yet" description={view.blockedReason} data-testid="dot-app-blocked" />
      ) : null}
      {app ? <ApplicationFacts app={app} /> : null}
      {sending ? <SendDotAppModal candidate={c} reservedId={app?.driverId ?? c.driverId} resend={Boolean(app)} onClose={() => setSending(false)} /> : null}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        tone="danger"
        title="Revoke the application link?"
        description="The driver's link stops working at once. What they already entered is kept; send the application again to give them a new link."
        confirmLabel="Revoke link"
        onConfirm={() =>
          revoke.mutateAsync(undefined).then(
            () => toast({ tone: 'success', title: 'Link revoked' }),
            (e: unknown) => {
              toast({ tone: 'danger', title: 'Not revoked', description: errorText(e) });
              throw e;
            },
          )
        }
      />
    </StepCard>
  );
}

function ApplicationFacts({ app }: { app: DotAppSummary }) {
  const l = app.link;
  const at = DOT_APP_JOURNEY.indexOf(app.status);
  return (
    <div className="flex flex-col gap-3" data-testid="dot-app-facts">
      <div className="flex flex-wrap items-center gap-2">
        <DotAppStatusBadge status={app.status} />
        {l ? <LinkStateBadge state={l.state} /> : null}
        {l ? <EmailStatusBadge status={l.emailStatus} /> : null}
      </div>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" aria-label="Application journey">
        {DOT_APP_JOURNEY.map((s, i) => (
          <li key={s} className={cn('flex items-center gap-1.5', i === at ? 'font-bold text-nw-accent-ink' : i < at ? 'text-nw-done-text' : 'text-nw-text-3')} aria-current={i === at ? 'step' : undefined}>
            {i > 0 ? <span aria-hidden className="text-nw-text-3">→</span> : null}
            {LABELS[s]}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1">
        <Fact label="Reserved driver ID">
          <span className="font-mono">{driverNumber(app.driverId)}</span>
        </Fact>
        <Fact label="Sections complete">
          <span data-testid="dot-app-sections">
            {app.sectionsComplete} of {app.sectionsTotal}
          </span>
        </Fact>
        {l ? (
          <>
            <Fact label="Email">{l.email || '—'}</Fact>
            <Fact label="Emailed">{l.emailedAt ? longDateTime(l.emailedAt) : 'Not emailed'}</Fact>
            <Fact label="Link copied">{l.copiedAt ? longDateTime(l.copiedAt) : 'Not copied'}</Fact>
            <Fact label="Opened">{l.firstOpenedAt ? `${longDateTime(l.firstOpenedAt)}${l.lastOpenedAt && l.lastOpenedAt !== l.firstOpenedAt ? ` · last ${longDateTime(l.lastOpenedAt)}` : ''}` : 'Not opened yet'}</Fact>
            <Fact label={l.state === 'revoked' ? 'Revoked' : 'Link expires'}>{l.state === 'revoked' ? `${longDateTime(l.revokedAt)}${l.revokedByName ? ` by ${l.revokedByName}` : ''}` : longDateTime(l.expiresAt)}</Fact>
          </>
        ) : null}
        {app.submittedAt ? <Fact label="Submitted">{longDateTime(app.submittedAt)}</Fact> : null}
        {app.approvedAt ? <Fact label="Safety approved">{longDateTime(app.approvedAt)}</Fact> : null}
      </div>
      {l?.emailStatus === 'bounced' ? <Alert tone="danger" title="Email bounced — check address" description={`The link email to ${l.email} came back. Check the address, then Resend, or copy the link instead.`} /> : null}
    </div>
  );
}

const LABELS: Record<(typeof DOT_APP_JOURNEY)[number], string> = {
  sent: 'Sent',
  opened: 'Opened',
  in_progress: 'In progress',
  submitted: 'Submitted',
  under_review: 'Under Safety review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  hired: 'Hired',
  rejected: 'Rejected',
};

export function previewMessage({ firstName, company, url, email, expiresInDays }: { firstName: string; company: string; url: string | null; email: string; expiresInDays: number }): string {
  const until = longDate(new Date(nowMs() + expiresInDays * 86_400_000).toISOString());
  return [
    `Hi ${firstName || 'there'}, please complete your DOT driver application for ${company}: ${url ?? '[the link appears after you press Send]'}`,
    `To open it, enter the 6-digit code we email to ${email || 'your email address'}. The link expires ${until}.`,
  ].join('\n');
}

/** The send dialog: company locked to the candidate's, expiry, and the two ways to send. No SMS. */
export function SendDotAppModal({ candidate: c, reservedId, resend, onClose }: { candidate: RecruitCandidate; reservedId: string | null; resend: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const company = useAccount()?.companyName ?? 'your company';
  const [expiry, setExpiry] = useState('14');
  const [byEmail, setByEmail] = useState(true);
  const [byCopy, setByCopy] = useState(true);
  const [email, setEmail] = useState(c.email ?? '');
  const [issued, setIssued] = useState<DotAppIssued | null>(null);
  const issue = useJourneyMutation((body: { sendEmail: boolean; email?: string; expiresInDays: 3 | 7 | 14 }) => dotAppRecruiterApi.issue(c.key, body));
  const copied = useJourneyMutation(() => dotAppRecruiterApi.copied(c.key));
  const days = Number(expiry) as 3 | 7 | 14;
  const address = email.trim();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  const message = previewMessage({ firstName: c.firstName || c.name.split(/\s+/)[0] || '', company, url: issued?.url ?? null, email: address, expiresInDays: days });

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text).then(() => true).catch(() => false);
    if (!ok) return toast({ tone: 'danger', title: 'Could not copy', description: 'Select the text and copy it by hand.' });
    copied.mutate(undefined);
    toast({ tone: 'success', title: `${what} copied`, description: 'Paste it into Telegram, WhatsApp or another chat with the driver.' });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !issue.isPending ? onClose() : undefined)}
      size="md"
      title={`${resend ? 'Resend' : 'Send'} DOT application to ${c.name}`}
      description={company}
      dismissible={!issue.isPending}
      footer={
        issued ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={issue.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Send />}
              loading={issue.isPending}
              disabled={(!byEmail && !byCopy) || !validEmail}
              data-testid="dot-app-send-confirm"
              onClick={() =>
                issue.mutate(
                  { sendEmail: byEmail, email: address && address !== (c.email ?? '') ? address : undefined, expiresInDays: days },
                  { onSuccess: (r) => setIssued(r), onError: (e) => toast({ tone: 'danger', title: 'Not sent', description: errorText(e) }) },
                )
              }
            >
              {resend ? 'Send a new link' : 'Send application'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4" data-testid="dot-app-send-modal">
        <dl className="flex flex-col gap-1">
          <Fact label="Company">
            {company} <span className="text-xs text-nw-text-3">(from the candidate — locked)</span>
          </Fact>
          <Fact label="Reserved driver ID">
            <span className="font-mono">{reservedId ? driverNumber(reservedId) : 'Reserved when the link is made'}</span>
          </Fact>
        </dl>
        {issued ? (
          <IssuedResult issued={issued} byEmail={byEmail} message={message} onCopy={copy} />
        ) : (
          <>
            {resend ? <Alert tone="warning" title="A new link replaces the old one" description="The link the driver has now stops working. Their answers are kept." /> : null}
            <FormField label="Link expires in">
              <Select aria-label="Link expires in" value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} />
            </FormField>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold text-nw-text">Send by</legend>
              <div className="grid gap-2 sm:grid-cols-2" data-testid="dot-app-channels">
                <div className={cn('flex flex-col gap-2 rounded-lg border p-3', byEmail ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border')}>
                  <Checkbox checked={byEmail} onCheckedChange={(v) => setByEmail(v === true)} label="Email from NeWay" description="The link and the 6-digit code go to this address." data-testid="channel-email" />
                </div>
                <div className={cn('flex flex-col gap-2 rounded-lg border p-3', byCopy ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border')}>
                  <Checkbox checked={byCopy} onCheckedChange={(v) => setByCopy(v === true)} label="Copy link + message" description="Paste into Telegram, WhatsApp, etc." data-testid="channel-copy" />
                </div>
              </div>
            </fieldset>
            <FormField label="Driver's email" required description="The 6-digit code is always sent here, whichever way the link goes." error={address && !validEmail ? 'Enter a valid email address' : !address ? 'The candidate has no email on file: add one' : undefined}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="dot-app-email" />
            </FormField>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-nw-text">Message preview</span>
              <pre className="rounded-lg border border-nw-border bg-nw-subtle p-3 font-sans text-sm whitespace-pre-wrap text-nw-text-2" data-testid="dot-app-message-preview">
                {message}
              </pre>
            </div>
            <Alert tone="info" description="No SMS is sent by NeWay. The link holds no personal data; the driver confirms it is them with the emailed code (5 tries, then the link pauses)." />
          </>
        )}
      </div>
    </Modal>
  );
}

function IssuedResult({ issued, byEmail, message, onCopy }: { issued: DotAppIssued; byEmail: boolean; message: string; onCopy: (text: string, what: string) => void }) {
  const status = issued.email.status;
  return (
    <div className="flex flex-col gap-3" data-testid="dot-app-issued">
      {byEmail && status === 'sent' ? <Alert tone="success" title="Email sent" description={`The link went to ${issued.application.link?.email ?? 'the driver'}.`} /> : null}
      {byEmail && status === 'failed' ? <Alert tone="danger" title="Email failed — copy the link instead" description={issued.email.error ?? undefined} data-testid="dot-app-email-failed" /> : null}
      {byEmail && status === 'skipped' ? <Alert tone="warning" title="Email is not set up on the server — copy the link instead" data-testid="dot-app-email-skipped" /> : null}
      <p className="text-xs text-nw-text-3">This link is shown once. Copy it now; it expires {longDateTime(issued.expiresAt)}.</p>
      <div className="flex items-center gap-2 rounded-lg border border-nw-border bg-nw-subtle p-2">
        <code className="min-w-0 flex-1 truncate text-xs text-nw-text" data-testid="dot-app-url">
          {issued.url}
        </code>
        <Button size="sm" variant="outline" icon={<Copy />} onClick={() => onCopy(issued.url, 'Link')} data-testid="dot-app-copy-link">
          Copy link
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <pre className="rounded-lg border border-nw-border bg-nw-subtle p-3 font-sans text-sm whitespace-pre-wrap text-nw-text-2">{message}</pre>
        <Button size="sm" variant="outline" icon={<Copy />} className="w-fit" onClick={() => onCopy(message, 'Message')} data-testid="dot-app-copy-message">
          Copy message
        </Button>
      </div>
    </div>
  );
}

/** Step 6 for a v2 application: where it is now, and the way to Safety's screen. */
export function DotAppReceivedCard({ app }: { app: DotAppSummary }) {
  return (
    <StepCard step={6} title="Application received" subtitle={`Submitted ${longDateTime(app.submittedAt)} — in the Safety queue`} testId="step-application-received-v2" footnote="Safety reviews the DOT application, completes the carrier's forms, approves it and hires the driver into Fleet → Drivers.">
      <div className="flex flex-wrap items-center gap-3">
        <DotAppStatusBadge status={app.status} />
        <Link to="/safety/applications/$applicationId" params={{ applicationId: app.id }} className="inline-flex items-center gap-1.5 text-sm font-semibold text-nw-accent-ink hover:underline" data-testid="open-in-safety-review">
          Open in Safety review <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
    </StepCard>
  );
}

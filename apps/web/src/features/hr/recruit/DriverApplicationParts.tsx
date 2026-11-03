import { Copy, Download, Eye, FileText, Link2, Send } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  DriverApplicationLinkIssued,
  DriverApplicationSessionView,
  DriverAuthorizationView,
  RecruitCandidate,
} from '@neway/shared';
import { Alert, Button, FormField, Input, Modal, Select, StatusSymbol, cn, useToast, type StatusSymbolFamily } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '@/lib/format';
import { Initials, RecruitCard } from './RecruitKit';
import { downloadAuthed, longDate, shortDate } from './recruit-format';
import { driverApplicationUrls, recruitApi, useRecruitMutation } from './useRecruit';

/**
 * The personal driver application in the TMS (owner brief, 2026-10-08): Send application (the
 * link, Copy link, a copyable message, Link copied kept apart from Mark as sent), and what the
 * driver sent — answers with the SSN masked, the documents and each authorization on its own.
 */

const CHANNELS = ['Text message', 'WhatsApp', 'Telegram', 'Email', 'Phone call', 'Other'];

function problemMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function Status({ family, children, testId }: { family: StatusSymbolFamily; children: ReactNode; testId?: string }) {
  const cls: Record<string, string> = {
    done: 'text-nw-done-icon',
    warning: 'text-nw-warning-icon',
    urgent: 'text-nw-urgent-icon',
    moving: 'text-nw-moving-icon',
    info: 'text-nw-moving-icon',
    neutral: 'text-nw-text-3',
    inShop: 'text-nw-warning-icon',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-nw-text" data-testid={testId}>
      <StatusSymbol family={family} size={14} className={cls[family]} />
      {children}
    </span>
  );
}

function sessionStatus(s: DriverApplicationSessionView): { family: StatusSymbolFamily; word: string } {
  switch (s.state) {
    case 'live':
      return { family: 'moving', word: `Link works until ${shortDate(s.expiresAt)}` };
    case 'submitted':
      return { family: 'done', word: 'Application received' };
    case 'expired':
      return { family: 'warning', word: 'Link expired' };
    default:
      return { family: 'neutral', word: 'Link turned off' };
  }
}

// ---------------------------------------------------------------------------- send application

/**
 * Send application. Making the link is real (the server issues it and keeps only its digest);
 * copying is only copying — "Link copied" is recorded as that. "Mark as sent" is the recruiter's
 * own word that they sent it. Nothing is sent from the TMS.
 */
export function SendApplicationModal({ candidate, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const make = useRecruitMutation(() => recruitApi.issueApplication(candidate.key));
  const copied = useRecruitMutation(() => recruitApi.applicationCopied(candidate.key));
  const mark = useRecruitMutation((channel: string | null) => recruitApi.applicationMarkSent(candidate.key, channel));
  const [issued, setIssued] = useState<DriverApplicationLinkIssued | null>(null);
  const [channel, setChannel] = useState('Text message');
  const [copiedWhat, setCopiedWhat] = useState<'link' | 'message' | null>(null);
  const da = candidate.driverApplication;
  const session = issued?.session ?? da.session;
  const live = session?.state === 'live';
  const url = issued?.url ?? null;
  const first = candidate.name.split(/\s+/)[0] ?? candidate.name;
  const recruiterFirst = candidate.recruiter?.name.split(/\s+/)[0] ?? null;
  const message = url
    ? `Hi ${first}! ${recruiterFirst ? `This is ${recruiterFirst} from` : 'This is'} NORTHWIND FREIGHT recruiting. Here is your personal driver application link — it takes a few minutes; have your CDL and medical card ready. Please don't share it: ${url}`
    : '';
  const markedSentAt = mark.data?.markedSentAt ?? session?.markedSentAt ?? null;
  const linkCopiedAt = copied.data?.linkCopiedAt ?? session?.linkCopiedAt ?? null;

  const copy = async (what: 'link' | 'message', text: string) => {
    try {
      await copyText(text);
    } catch {
      toast({ tone: 'warning', title: 'Copy is not available here', description: 'Select the text and copy it by hand.' });
      return;
    }
    setCopiedWhat(what);
    copied.mutate(undefined, {
      onSuccess: () => toast({ tone: 'success', title: what === 'link' ? 'Link copied' : 'Message copied', description: 'Copied to your clipboard. Nothing was sent.' }),
      onError: () => toast({ tone: 'warning', title: 'Copied, but not recorded', description: 'The copy worked; the TMS could not record it.' }),
    });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Send application"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="send-application-dialog">
        <div className="flex items-center gap-3 rounded-xl border border-nw-border bg-nw-subtle px-3 py-2.5">
          <Initials name={candidate.name} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-nw-text">{candidate.name}</p>
            <p className="truncate text-[13px] text-nw-text-3">
              {candidate.sourceLabel}
              {candidate.recruiter ? ` · ${candidate.recruiter.name}` : ''}
            </p>
          </div>
        </div>

        {make.error ? <Alert tone="danger" title="No link was made" description={problemMessage(make.error, 'Try again.')} /> : null}

        {da.submission ? (
          <Alert tone="info" title={`Application received ${formatDateTime(da.submission.receivedAt)}`}>
            Reference {da.submission.reference}. A second application through a new link is not available.
          </Alert>
        ) : url ? (
          <>
            <FormField label="Personal application link" description={`Works until ${formatDateTime(issued?.expiresAt ?? '')}. Only ${first} should get it.`}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={url} aria-label="Personal application link" onFocus={(e) => e.currentTarget.select()} data-testid="application-link-url" />
                <Button variant="primary" icon={<Copy />} onClick={() => void copy('link', url)} data-testid="copy-link-button">
                  {copiedWhat === 'link' ? 'Link copied' : 'Copy link'}
                </Button>
              </div>
            </FormField>
            <div className="rounded-xl border border-nw-border bg-nw-subtle p-3">
              <p className="text-[13px] font-semibold text-nw-text">Message for the driver</p>
              <p className="mt-1 text-sm break-words text-nw-text-2" data-testid="driver-message">
                {message}
              </p>
              <Button variant="outline" size="sm" className="mt-2" icon={<Copy />} onClick={() => void copy('message', message)} data-testid="copy-message-button">
                {copiedWhat === 'message' ? 'Message copied' : 'Copy message'}
              </Button>
            </div>
            <p className="text-xs text-nw-text-3">
              The address is shown only now; the TMS keeps a fingerprint, not the link. To send it again later, make a new link — the old one stops working.
            </p>
          </>
        ) : live && session ? (
          <div className="rounded-xl border border-nw-border px-3 py-3 text-sm" data-testid="link-live">
            <p className="font-semibold text-nw-text">
              A link was made on {shortDate(session.createdAt)} by {session.createdByName} and works until {shortDate(session.expiresAt)}.
            </p>
            <p className="mt-2 text-nw-text-3">The address is not kept. A new link turns this one off.</p>
            <Button variant="outline" className="mt-3" loading={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => setIssued(r) })} data-testid="make-new-link">
              Make a new link
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-nw-text-2">
              This makes a private link to the NORTHWIND FREIGHT driver application for {candidate.name}. What they send arrives on this page. It works for 14 days.
            </p>
            {session ? <Status family={sessionStatus(session).family}>{sessionStatus(session).word}</Status> : null}
            <Button variant="primary" icon={<Link2 />} loading={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => setIssued(r) })} data-testid="make-link">
              Make the link
            </Button>
          </div>
        )}

        {session && !da.submission ? (
          <div className="flex flex-col gap-2.5 border-t border-nw-border pt-3" data-testid="send-status">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Status family={linkCopiedAt ? 'done' : 'neutral'} testId="status-copied">
                {linkCopiedAt ? `Link copied ${formatDateTime(linkCopiedAt)}` : 'Link not copied'}
              </Status>
              <Status family={markedSentAt ? 'done' : 'neutral'} testId="status-sent">
                {markedSentAt ? `Marked as sent ${formatDateTime(markedSentAt)}` : 'Not marked as sent'}
              </Status>
            </div>
            {live && !markedSentAt ? (
              <div className="flex flex-wrap items-end gap-2">
                <span className="w-44">
                  <Select aria-label="Sent by" value={channel} onValueChange={setChannel} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
                </span>
                <Button
                  variant="primary"
                  icon={<Send />}
                  loading={mark.isPending}
                  onClick={() => mark.mutate(channel, { onSuccess: () => toast({ tone: 'success', title: 'Recorded as sent by you' }) })}
                  data-testid="mark-sent"
                >
                  I sent it — mark as sent
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-nw-text-3">Copying the link is not sending it. Mark it as sent once you have sent it yourself.</p>
          </div>
        ) : null}
        {mark.error ? <Alert tone="danger" title="Not recorded" description={problemMessage(mark.error, 'Try again.')} /> : null}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------- the application received

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

function documentStatus(status: string | null): { family: StatusSymbolFamily; word: string } {
  if (status === 'verified') return { family: 'done', word: 'Approved by Safety' };
  if (status === 'rejected') return { family: 'urgent', word: 'Rejected by Safety' };
  if (status === 'expired') return { family: 'warning', word: 'Expired' };
  if (status === 'pending_review') return { family: 'moving', word: 'Pending review' };
  return { family: 'neutral', word: 'Received · filing' };
}

/** The application the driver sent through the personal link: their answers, the SSN masked. */
export function PersonalApplication({ candidate }: { candidate: RecruitCandidate }) {
  const { toast } = useToast();
  const s = candidate.driverApplication.submission;
  const canReveal = useAccount()?.permissions.includes('compliance_sensitive.view') ?? false;
  const reveal = useRecruitMutation(() => recruitApi.revealSsn(candidate.key));
  if (!s) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="personal-application">
      <p className="flex flex-wrap items-center gap-2 text-sm text-nw-text-2">
        <Status family="done">Application submitted</Status>
        <span>
          {formatDateTime(s.receivedAt)} · reference <span className="font-semibold text-nw-text" data-testid="application-reference">{s.reference}</span>
        </span>
      </p>
      <RecruitCard title="Driver application" testId="personal-answers">
        <Grid>
          {s.answers.map((a) => (
            <Item key={a.key} label={a.label}>
              {a.value}
            </Item>
          ))}
          <Item label="SSN">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span data-testid="ssn-masked">{reveal.data?.ssn ?? s.ssnMasked ?? '—'}</span>
              {canReveal && !reveal.data ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-nw-accent-ink hover:underline"
                  onClick={() => reveal.mutate(undefined, { onError: () => toast({ tone: 'danger', title: 'Not revealed' }) })}
                >
                  Reveal (recorded)
                </button>
              ) : null}
            </span>
          </Item>
        </Grid>
        <p className="mt-4 text-xs text-nw-text-3">
          This is the initial recruiting application. It does not replace the full DOT employment application (More › Full DOT application).
        </p>
      </RecruitCard>
      <RecruitCard title="Documents sent with the application" testId="personal-documents">
        <ApplicationFiles candidate={candidate} />
      </RecruitCard>
      <RecruitCard title="Authorizations" testId="personal-authorizations">
        <ApplicationConsents candidate={candidate} compact />
      </RecruitCard>
    </div>
  );
}

export function ApplicationFiles({ candidate }: { candidate: RecruitCandidate }) {
  const { toast } = useToast();
  const s = candidate.driverApplication.submission;
  const [viewing, setViewing] = useState<{ id: string; label: string; type: string } | null>(null);
  if (!s) return null;
  if (s.files.length === 0) return <p className="text-sm text-nw-text-3">No documents were attached. They are optional on this application.</p>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {s.files.map((f) => {
          const st = documentStatus(f.documentStatus);
          return (
            <li key={f.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-nw-border px-3 py-2.5" data-testid={`application-file-${f.code}`}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nw-subtle text-nw-text-2">
                <FileText aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-nw-text">{f.label}</span>
                <span className="block truncate text-xs text-nw-text-3">
                  {f.fileName} · {(f.sizeBytes / 1024 / 1024).toFixed(2)} MB · {longDate(f.uploadedAt)}
                </span>
                <span className="mt-1 block">
                  <Status family={st.family}>{st.word}</Status>
                </span>
              </span>
              <Button variant="outline" size="sm" icon={<Eye />} onClick={() => setViewing({ id: f.id, label: f.label, type: f.contentType })}>
                View
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Download />}
                aria-label={`Download ${f.label}`}
                onClick={() => void downloadAuthed(driverApplicationUrls.file(candidate.key, f.id), f.fileName).catch(() => toast({ tone: 'danger', title: 'The file could not be downloaded' }))}
              />
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-nw-text-3">Uploaded is not approved: Safety reviews these in the qualification file.</p>
      {viewing ? (
        <Modal open onOpenChange={(o) => !o && setViewing(null)} size="lg" title={viewing.label}>
          <AuthedPreview url={driverApplicationUrls.file(candidate.key, viewing.id)} type={viewing.type} alt={viewing.label} />
        </Modal>
      ) : null}
    </>
  );
}

/** A private file fetched with the session, shown on paper (documents stay light in both themes). */
function AuthedPreview({ url, type, alt, className }: { url: string; type: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    void import('@/lib/files')
      .then(({ fetchFileBlob }) => fetchFileBlob({ fileUrl: url }))
      .then((blob) => {
        if (cancelled) return;
        revoke = URL.createObjectURL(blob);
        setSrc(revoke);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [url]);
  return (
    <div className={cn('nw-paper overflow-hidden rounded-lg border border-line', className)} data-theme="light">
      {failed ? (
        <p className="p-4 text-sm text-nw-urgent-text">The file could not be loaded.</p>
      ) : !src ? (
        <p className="p-4 text-sm text-nw-text-3">Loading…</p>
      ) : type === 'application/pdf' ? (
        <iframe title={alt} src={src} className="h-[70vh] w-full" />
      ) : (
        <img src={src} alt={alt} className="mx-auto max-h-[70vh] w-auto" />
      )}
    </div>
  );
}

function authorizationStatus(a: DriverAuthorizationView): { family: StatusSymbolFamily; word: string } {
  if (a.decision === 'signed') return { family: 'done', word: 'Signed' };
  if (a.decision === 'declined') return { family: 'warning', word: 'Declined' };
  return { family: 'neutral', word: 'Not provided' };
}

/** MVR and PSP, each on its own: signed / declined / not provided, signer, times, signature, export. */
export function ApplicationConsents({ candidate, compact = false }: { candidate: RecruitCandidate; compact?: boolean }) {
  const { toast } = useToast();
  const s = candidate.driverApplication.submission;
  if (!s) return <p className="text-sm text-nw-text-3">Shows once the driver submits the application.</p>;
  // The application no longer asks for MVR and PSP (owner, 2026-10-12): they are signed on the
  // consent form, so an application without them is normal, never "Not provided".
  if (s.authorizations.every((a) => a.decision !== 'signed')) {
    return (
      <p className="text-sm text-nw-text-2" data-testid="application-consents">
        {candidate.journeyState.consent === 'received'
          ? 'MVR and PSP are signed on the consent form — see Consent received (step 3).'
          : 'MVR and PSP are signed on the consent form, not on the application. No consent has been received yet.'}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="application-consents">
      {s.authorizations.map((a) => {
        const st = authorizationStatus(a);
        return (
          <li key={a.type} className="rounded-[10px] border border-nw-border px-3 py-3" data-testid={`consent-${a.type}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-nw-text">{a.label}</span>
              <Status family={st.family}>{st.word}</Status>
            </div>
            {a.decision === 'signed' ? (
              <>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                  <Item label="Signed by">{a.signerName}</Item>
                  <Item label="Received by the TMS">{a.receivedAt ? formatDateTime(a.receivedAt) : '—'}</Item>
                  <Item label="Device time (as claimed)">{a.clientSignedAt ? formatDateTime(a.clientSignedAt) : '—'}</Item>
                  <Item label="Disclosure">{a.disclosureVersion ?? '—'}</Item>
                </dl>
                {a.id && a.hasSignatureImage && !compact ? (
                  <AuthedPreview url={driverApplicationUrls.signature(candidate.key, a.id)} type="image/png" alt={`${a.label} signature`} className="mt-3 max-w-sm" />
                ) : null}
                {a.id ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    icon={<Download />}
                    onClick={() =>
                      void downloadAuthed(driverApplicationUrls.pdf(candidate.key, a.id as string), `${a.type}-authorization-${s.reference}.pdf`).catch(() =>
                        toast({ tone: 'danger', title: 'The authorization could not be exported' }),
                      )
                    }
                  >
                    Export signed {a.type.toUpperCase()} (PDF)
                  </Button>
                ) : null}
              </>
            ) : a.decision === 'declined' ? (
              <p className="mt-1 text-xs text-nw-text-3">The driver chose not to authorize this report{a.receivedAt ? ` (received ${formatDateTime(a.receivedAt)})` : ''}.</p>
            ) : (
              <p className="mt-1 text-xs text-nw-text-3">The driver did not open or answer this authorization.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const PANEL_SECTIONS: [string, string[]][] = [
  ['Personal information', ['firstName', 'lastName', 'phone', 'email', 'address', 'city', 'stateZip']],
  ['CDL & experience', ['cdlClass', 'cdlState', 'cdlExpiration', 'medicalExpiration', 'experience', 'endorsements', 'position', 'preference', 'startDate', 'routes']],
  ['Driving history', ['employer', 'employmentStart', 'employmentEnd', 'leavingReason', 'accidents', 'violations', 'suspended', 'source', 'details']],
];

/** The received driver application, read-only, for the Documents tab's right-hand panel. */
export function DriverApplicationPanel({ candidate }: { candidate: RecruitCandidate }) {
  const s = candidate.driverApplication.submission;
  if (!s) return null;
  const rows = (pairs: [string, string | null][]) => (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-1.5 text-[13px]">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-nw-text-3">{k}</dt>
          <dd className="break-words text-nw-text">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
  const value = (key: string) => s.answers.find((a) => a.key === key);
  return (
    <article className="flex flex-col gap-4" data-testid="driver-application-panel">
      <div>
        <h3 className="text-[15px] font-semibold text-nw-text">Driver application</h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-nw-text-3">
          <Status family="done">Submitted</Status>
          <span>{formatDateTime(s.receivedAt)}</span>
          <span>· reference <span className="font-semibold text-nw-text">{s.reference}</span></span>
        </p>
      </div>
      {PANEL_SECTIONS.map(([title, keys]) => (
        <section key={title} className="flex flex-col gap-2 border-b border-nw-border pb-4">
          <h4 className="text-[13px] font-semibold text-nw-text">{title}</h4>
          {rows([
            ...keys.map((k): [string, string | null] => {
              const a = value(k);
              return [a?.label ?? k, a?.value ?? null];
            }).filter(([, v]) => v),
            ...(title === 'Personal information' ? ([['SSN', s.ssnMasked]] as [string, string | null][]) : []),
          ])}
        </section>
      ))}
      <section className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-nw-text">Documents & authorizations</h4>
        {rows([
          ...s.files.map((f): [string, string | null] => [f.label, documentStatus(f.documentStatus).word]),
          // MVR and PSP are signed on the consent form, not here (owner, 2026-10-12): never "Not provided".
          ...s.authorizations.map((a): [string, string | null] => [
            a.type.toUpperCase(),
            a.decision === 'signed' ? `${authorizationStatus(a).word}${a.signerName ? ` · ${a.signerName}` : ''}` : 'Signed on the consent form',
          ]),
        ])}
      </section>
    </article>
  );
}

/** One line on where the personal link stands, for the "not submitted yet" card. */
export function SessionLine({ session }: { session: DriverApplicationSessionView | null }) {
  if (!session) return null;
  const st = sessionStatus(session);
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-nw-text-3" data-testid="link-status">
      <Status family={st.family}>{st.word}</Status>
      <span>Made {shortDate(session.createdAt)}</span>
      <span>{session.linkCopiedAt ? `copied ${formatDateTime(session.linkCopiedAt)}` : 'not copied'}</span>
      <span>{session.markedSentAt ? `marked sent ${formatDateTime(session.markedSentAt)}` : 'not marked as sent'}</span>
    </p>
  );
}

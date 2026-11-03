import { ChevronDown, Eye, FileText, MessageSquare, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { CONSENT_DOCUMENT_LABELS, CONSENT_DOCUMENT_TYPES, type CandidateJourney, type ConsentLinkIssued, type RecruitCandidate } from '@neway/shared';
import { Alert, Button, FormField, Modal, StatusSymbol, Textarea, cn, useToast } from '@/design-system';
import { ScreeningReports } from '@/features/safety/hiring/ScreeningReports';
import { copyText } from '@/lib/clipboard';
import { longDateTime } from '../recruit-format';
import { journeyApi, journeySafetyBase, journeyUrls } from '../useJourney';
import { recruitApi, useRecruitNotes } from '../useRecruit';
import { DocRow, Fact, Pill, StepCard } from './JourneyKit';
import { errorText, useJourneyMutation } from './journey-utils';
import { SimpleLinkCard } from './SimpleLinkCard';

/**
 * Step 2 — Send consent, the simple way (owner, 2026-10-12): Create link, Copy it to the driver,
 * Mark as sent. Sent shows the date and time. A new link turns the old one off; both stay on record.
 */
export function SendConsentStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const session = j.consent.session;
  const [issued, setIssued] = useState<ConsentLinkIssued | null>(null);
  const make = useJourneyMutation(() => journeyApi.consentLink(c.key));
  const copied = useJourneyMutation(() => journeyApi.consentCopied(c.key));
  const mark = useJourneyMutation(() => journeyApi.consentMarkSent(c.key, null));
  const current = session ?? issued?.session ?? null;
  const live = current?.state === 'live';

  const newLink = () =>
    make.mutate(undefined, {
      onSuccess: (r) => setIssued(r),
      onError: (e) => toast({ tone: 'danger', title: 'No link made', description: errorText(e) }),
    });
  const copy = async (text: string) => {
    const ok = await copyText(text).then(() => true).catch(() => false);
    if (!ok) return toast({ tone: 'danger', title: 'Could not copy', description: 'Select the link and copy it by hand.' });
    copied.mutate(undefined);
    toast({ tone: 'success', title: 'Link copied', description: 'Send it to the driver, then mark it as sent.' });
  };

  return (
    <StepCard step={2} title="Send consent" subtitle="Ask the driver to sign the MVR, PSP and Clearinghouse consents." testId="step-send-consent">
      <SimpleLinkCard
        title="Consent link"
        url={issued && live ? issued.url : null}
        live={live}
        sentAt={live ? (current?.markedSentAt ?? null) : null}
        canManage={j.permissions.canManage}
        creating={make.isPending}
        marking={mark.isPending}
        onCreate={newLink}
        onCopy={(u) => void copy(u)}
        onMarkSent={() => mark.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Marked as sent' }), onError: (e) => toast({ tone: 'danger', title: 'Not marked', description: errorText(e) }) })}
        testId="consent-link"
      />
    </StepCard>
  );
}

/**
 * Step 3 — Consent received. Each signed document on its own (View, PDF), the CDL front, and the
 * signature with its history in a staff-only section. Send to Safety is the next thing to do.
 */
export function ConsentReceivedStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const s = j.consent.submission;
  const [history, setHistory] = useState(false);
  const [sending, setSending] = useState(false);
  if (!s) return null;
  // The MVR / PSP reports and Send to Safety sit right under the signed consent (owner, 2026-10-13).
  const sent = j.safety.review && j.safety.review.status !== 'preparing' ? j.safety.review : null;
  const missing = (['mvr', 'psp'] as const).filter((k) => !j.safety.reports.some((r) => r.kind === k)).map((k) => k.toUpperCase());
  // Any Yes on the safety questions: disqualified per company policy, never sent (owner, 2026-10-16).
  // The server lifts it when Recruiting reopened the candidate after this consent.
  const disqualified = s.safetyDisqualified;
  return (
    <StepCard
      step={3}
      title="Consent received"
      subtitle={`Signed ${longDateTime(s.receivedAt)} · reference ${s.reference}`}
      testId="step-consent-received"
      footnote="The driver signed each consent, sent the CDL front and answered the safety questions. A signature is permission to run the checks, not a result. Upload the MVR and PSP reports below, then send to Safety."
      actions={sent ? <Pill family="info">With Safety since {longDateTime(sent.openedAt)}</Pill> : null}
    >
      <ul className="rounded-xl border border-nw-border px-3">
        {CONSENT_DOCUMENT_TYPES.map((type) => {
          const d = s.documents.find((x) => x.type === type);
          if (!d) {
            return (
              <DocRow
                key={type}
                label={CONSENT_DOCUMENT_LABELS[type]}
                detail={type === 'clearinghouse' && !j.consent.clearinghouseAvailable ? "Waiting for the company's own Clearinghouse wording; not offered to drivers yet" : 'Not signed'}
                status={<Pill family="neutral">Pending</Pill>}
                testId={`consent-doc-${type}`}
              />
            );
          }
          return (
            <DocRow
              key={type}
              label={d.label}
              detail={`Signed ${longDateTime(d.signedAt)} · text ${d.disclosureVersion}${d.scope ? ` · ${d.scope}${d.validUntil ? `, usable until ${longDateTime(d.validUntil)}` : ''}` : ''}`}
              status={<Pill family="done">Signed</Pill>}
              view={{ url: journeyUrls.consentPdf(c.key, d.id), title: d.label, contentType: 'application/pdf', fileName: `${type}-consent-${s.reference}.pdf` }}
              download={{ url: journeyUrls.consentPdf(c.key, d.id), fileName: `${type}-consent-${s.reference}.pdf`, label: 'PDF' }}
              testId={`consent-doc-${type}`}
            />
          );
        })}
        {s.files.map((f) => (
          <DocRow
            key={f.id}
            label={f.label}
            detail={`${f.fileName} · received ${longDateTime(f.uploadedAt)}`}
            status={<Pill family="done">Received</Pill>}
            view={{ url: journeyUrls.consentFile(c.key, f.id), title: f.label, contentType: f.contentType, fileName: f.fileName }}
            download={{ url: journeyUrls.consentFile(c.key, f.id), fileName: f.fileName }}
            testId="consent-cdl-front"
          />
        ))}
      </ul>
      <div className="rounded-xl border border-nw-border">
        <button type="button" onClick={() => setHistory((h) => !h)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-nw-text" aria-expanded={history} data-testid="signature-history-toggle">
          <ChevronDown aria-hidden className={`size-4 transition-transform ${history ? 'rotate-0' : '-rotate-90'}`} />
          Signature & history
          <span className="text-xs font-normal text-nw-text-3">· staff only</span>
        </button>
        {history ? (
          <div className="flex flex-col gap-1 border-t border-nw-border px-4 py-3" data-testid="signature-history">
            <Fact label="Signed by">
              {s.firstName} {s.lastName} · {s.phone} · {s.email}
            </Fact>
            <Fact label="Signature">{s.signatureMethod === 'typed' ? 'Typed electronic signature' : 'Drawn electronic signature'}</Fact>
            {s.signatureMethod === 'typed' && s.signatureText ? (
              <div className="my-1 flex min-h-[84px] items-center rounded-[10px] border border-nw-border bg-nw-panel px-5" data-testid="typed-signature-view">
                <span className="border-b border-nw-border-strong pb-1 font-['Great_Vibes',cursive] text-[40px] leading-tight text-nw-text">{s.signatureText}</span>
              </div>
            ) : null}
            {s.hasSignatureImage ? (
              <DocRow label="Drawn signature" view={{ url: journeyUrls.consentSignature(c.key), title: 'Drawn signature', contentType: 'image/png', fileName: `signature-${s.reference}.png` }} />
            ) : null}
            <Fact label="Opened">{j.consent.session?.firstOpenedAt ? longDateTime(j.consent.session.firstOpenedAt) : '—'}</Fact>
            <Fact label="Confirmed and signed">{longDateTime(s.confirmedAt)}</Fact>
            <Fact label="Received by the TMS">{longDateTime(s.receivedAt)}</Fact>
            <Fact label="Device time (claimed)">{s.audit.clientSignedAt ?? '—'}</Fact>
            <Fact label="IP address">{s.audit.ipVisible ? (s.audit.ipAddress ?? 'Not recorded') : 'Restricted'}</Fact>
            <Fact label="Browser">{s.audit.userAgent ?? '—'}</Fact>
          </div>
        ) : null}
      </div>

      <SafetyAnswers submission={s} candidate={c} canManage={j.permissions.canManage} />

      {/* The screening reports and Send to Safety, under the consent (owner, 2026-10-13). */}
      {!sent ? (
        <section aria-label="Screening reports" className="flex flex-col gap-3" data-testid="consent-reports">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-nw-text">Screening reports</h3>
            {missing.length > 0 ? <Pill family="warning">To upload: {missing.join(' and ')}</Pill> : <Pill family="done">MVR and PSP on file · ready to send</Pill>}
          </div>
          <ScreeningReports base={journeySafetyBase(c.key)} safety={j.safety} editable={j.safety.canUpload} testPrefix="recruit" />
          {j.permissions.canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                icon={<Send />}
                disabled={missing.length > 0 || disqualified}
                title={disqualified ? 'Any Yes on the safety questions: disqualified per company hiring policy' : missing.length > 0 ? `Upload the ${missing.join(' and ')} first` : undefined}
                onClick={() => setSending(true)}
                data-testid="send-to-safety"
              >
                Send to Safety
              </Button>
              {disqualified ? (
                <div className="flex items-center gap-2 rounded-lg bg-nw-urgent-bg px-3 py-1.5" data-testid="send-disqualified">
                  <StatusSymbol family="urgent" size={16} className="shrink-0 text-nw-urgent-icon" />
                  <span>
                    <span className="block text-sm font-bold text-nw-urgent-text">Any Yes: Disqualified</span>
                    <span className="block text-xs text-nw-urgent-text">Per company hiring policy</span>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {sending ? <SendToSafetyDialog candidate={c} onClose={() => setSending(false)} /> : null}
    </StepCard>
  );
}

export function SendToSafetyDialog({ candidate: c, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const send = useJourneyMutation(() => journeyApi.sendToSafety(c.key, note.trim() || null));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Send to Safety"
      description="Safety reads the reports you filed and decides: Qualified, Not qualified or Insurance check. The application waits for their decision."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={send.isPending}
            onClick={() =>
              send.mutate(undefined, {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Sent to Safety' });
                  onClose();
                },
              })
            }
            data-testid="confirm-send-to-safety"
          >
            Send to Safety
          </Button>
        </>
      }
    >
      {send.error ? <Alert tone="danger" title="Not sent" description={errorText(send.error)} /> : null}
      <FormField label="Note for Safety (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
      </FormField>
    </Modal>
  );
}

/**
 * The consent's safety questions, for staff only (owner, 2026-10-13): any Yes is a
 * disqualification under the company's hiring policy, judged apart from the verified reports.
 */
function SafetyAnswers({ submission: s, candidate: c, canManage }: { submission: NonNullable<CandidateJourney['consent']['submission']>; candidate: RecruitCandidate; canManage: boolean }) {
  const [commenting, setCommenting] = useState<string | null>(null);
  // The comments written on a Yes are notes that name the question (owner, 2026-10-16).
  const notes = useRecruitNotes(c.key);
  const commentsFor = (label: string) => {
    const prefix = `Safety question "${label}" answered Yes: `;
    return (notes.data ?? [])
      .filter((n) => n.text?.startsWith(prefix))
      .map((n) => ({ id: n.id, text: (n.text ?? '').slice(prefix.length), by: n.byName, at: n.at }));
  };
  if (!s.safetyAnswers) return null;
  const yes = s.safetyAnswers.filter((a) => a.answer);
  return (
    <section aria-label="Safety questions" className="flex flex-col gap-3 rounded-xl border border-nw-border bg-nw-subtle/60 p-3" data-testid="consent-safety-answers">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-nw-accent-tint text-nw-accent-ink" aria-hidden>
            <Eye className="size-4" />
          </span>
          <span>
            <span className="block text-sm font-bold text-nw-accent-ink">TMS / Safety only</span>
            <span className="block text-xs text-nw-text-3">Not visible to driver</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <FileText aria-hidden className="size-5 shrink-0 text-nw-text-2" />
          <span>
            <span className="block text-sm font-bold text-nw-text">Screening answers received</span>
            <span className="block text-xs text-nw-text-3">{s.safetyAnswers.length} safety questions</span>
          </span>
        </div>
        {yes.length > 0 && !s.safetyDisqualified ? (
          <div className="flex items-center gap-3 rounded-lg bg-nw-warning-bg px-3 py-2" data-testid="safety-reopened">
            <StatusSymbol family="warning" size={18} className="shrink-0 text-nw-warning-icon" />
            <span>
              <span className="block text-sm font-bold text-nw-warning-text">Any Yes · Reopened</span>
              <span className="block text-xs text-nw-warning-text">Recruiting reopened with a note</span>
            </span>
          </div>
        ) : yes.length > 0 ? (
          <div className="flex items-center gap-3 rounded-lg bg-nw-urgent-bg px-3 py-2" data-testid="safety-disqualified">
            <StatusSymbol family="urgent" size={18} className="shrink-0 text-nw-urgent-icon" />
            <span>
              <span className="block text-sm font-bold text-nw-urgent-text">Any Yes: Disqualified</span>
              <span className="block text-xs text-nw-urgent-text">Per company hiring policy</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg bg-nw-done-bg px-3 py-2" data-testid="safety-clear">
            <StatusSymbol family="done" size={18} className="shrink-0 text-nw-done-icon" />
            <span>
              <span className="block text-sm font-bold text-nw-done-text">All answers No</span>
              <span className="block text-xs text-nw-done-text">No disqualifying answer</span>
            </span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Users aria-hidden className="size-5 shrink-0 text-nw-text-2" />
          <span className="text-xs text-nw-text-3">Company policy evaluated separately from verified reports.</span>
        </div>
      </div>
      <ol className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        {s.safetyAnswers.map((a, i) => (
          <li key={a.key} className="flex flex-wrap items-start gap-2 py-1 text-sm">
            <span className="w-5 shrink-0 text-right text-xs text-nw-text-3">{i + 1}.</span>
            <span className={cn('min-w-0 flex-1', a.answer ? 'font-semibold text-nw-urgent-text' : 'text-nw-text-2')}>{a.label}</span>
            <span className={cn('shrink-0 text-xs font-bold', a.answer ? 'text-nw-urgent-text' : 'text-nw-text-3')}>{a.answer ? 'Yes' : 'No'}</span>
            {a.answer && canManage ? (
              <Button variant="outline" size="sm" icon={<MessageSquare />} className="-my-1 h-7 shrink-0 px-2 text-xs" onClick={() => setCommenting(a.label)} data-testid={`safety-comment-${a.key}`}>
                Comment
              </Button>
            ) : null}
            {a.answer && commentsFor(a.label).length > 0 ? (
              <ul className="basis-full pl-7 text-xs text-nw-text-2" data-testid={`safety-comments-${a.key}`}>
                {commentsFor(a.label).map((m) => (
                  <li key={m.id} className="flex items-start gap-1.5 py-0.5">
                    <MessageSquare aria-hidden className="mt-0.5 size-3 shrink-0 text-nw-text-3" />
                    <span>
                      {m.text} <span className="text-nw-text-3">· {m.by}, {longDateTime(m.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      {commenting ? <SafetyCommentModal candidate={c} question={commenting} reopen={c.caseState === 'disqualified'} onClose={() => setCommenting(null)} /> : null}
    </section>
  );
}

/**
 * A comment on a Yes answer (owner, 2026-10-16): kept as a note on the candidate, and when the
 * candidate was disqualified for it, the same comment brings them back into the hiring process.
 */
function SafetyCommentModal({ candidate: c, question, reopen, onClose }: { candidate: RecruitCandidate; question: string; reopen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const save = useJourneyMutation(async (comment: string) => {
    const note = `Safety question "${question}" answered Yes: ${comment}`;
    await recruitApi.addNote(c.key, { note });
    if (reopen) await recruitApi.reopen(c.key, note);
  });
  const tooShort = text.trim().length < 3;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Comment on a Yes answer"
      description={reopen ? `${question}. Saving the comment returns ${c.name} to the hiring process; it is kept with your name.` : `${question}. The comment is kept on the candidate with your name.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={tooShort}
            loading={save.isPending}
            onClick={() =>
              save.mutate(text.trim(), {
                onSuccess: () => {
                  toast({ tone: 'success', title: reopen ? `${c.name} is back in the hiring process` : 'Comment saved' });
                  onClose();
                },
                onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }),
              })
            }
          >
            {reopen ? 'Save and return to hiring' : 'Save comment'}
          </Button>
        </>
      }
    >
      <FormField label="Comment" required>
        <Textarea rows={3} maxLength={800} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. SAP completed in 2021, return-to-duty test passed" aria-label="Comment" />
      </FormField>
    </Modal>
  );
}

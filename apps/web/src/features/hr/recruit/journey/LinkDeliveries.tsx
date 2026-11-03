import { Mail, MessageSquareText, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { LINK_DELIVERY_STATUS_LABELS, SMS_OPT_IN_SOURCES, SMS_OPT_IN_SOURCE_LABELS, type SmsOptInSource, type CandidateJourney, type JourneyLinkKind, type LinkDeliveryStatus, type LinkDeliveryView, type RecruitCandidate } from '@neway/shared';
import { Alert, Button, FormField, Input, Modal, Select, useToast, type StatusSymbolFamily } from '@/design-system';
import { longDateTime } from '../recruit-format';
import { journeyApi } from '../useJourney';
import { Pill } from './JourneyKit';
import { errorText, useJourneyMutation } from './journey-utils';

const FAMILY: Record<LinkDeliveryStatus, StatusSymbolFamily> = { sending: 'neutral', sent: 'moving', delivered: 'done', failed: 'urgent' };
const PROVIDER: Record<string, string> = { twilio: 'Twilio', smtp: 'the mail server', graph: 'Microsoft 365', file: 'the sandbox outbox' };

/**
 * Send the link from the TMS (owner brief, 2026-10-11): by SMS through the company's Twilio account
 * or by email. A channel that is not set up says exactly why and sends nothing; Copy link stays.
 * Each send is a new link, so the buttons say so when a link is already out.
 */
export function SendByChannel({ candidate: c, journey: j, link, disabled }: { candidate: RecruitCandidate; journey: CandidateJourney; link: JourneyLinkKind; disabled?: string | null }) {
  const { toast } = useToast();
  const send = useJourneyMutation((channel: 'sms' | 'email') => journeyApi.sendLink(c.key, { link, channel }));
  const { sms, email } = j.deliveries.channels;
  if (!j.permissions.canManage) return null;
  const go = (channel: 'sms' | 'email') =>
    send.mutate(channel, {
      onSuccess: (d) =>
        d.status === 'failed'
          ? toast({ tone: 'danger', title: channel === 'sms' ? 'Text not sent' : 'Email not sent', description: d.error ?? 'The provider refused it.' })
          : toast({ tone: 'success', title: channel === 'sms' ? `Texted to ${d.recipient}` : `Emailed to ${d.recipient}`, description: `Accepted by ${PROVIDER[d.provider] ?? d.provider}. The earlier link no longer works.` }),
      onError: (e) => toast({ tone: 'danger', title: 'Not sent', description: errorText(e) }),
    });
  const busy = send.isPending ? send.variables : null;
  const consent = j.deliveries.sms;
  const smsBlocked = consent.status === 'opted_in' ? null : consent.status === 'opted_out' ? 'The candidate opted out of texts' : 'Record the texting consent first';
  return (
    <div className="flex flex-col gap-2" data-testid={`send-by-channel-${link}`}>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          icon={<MessageSquareText />}
          disabled={Boolean(disabled) || !sms.available || !c.phone || Boolean(smsBlocked)}
          title={disabled ?? sms.reason ?? smsBlocked ?? (c.phone ? undefined : 'No phone number on file')}
          loading={busy === 'sms'}
          onClick={() => go('sms')}
          data-testid={`send-sms-${link}`}
        >
          {c.phone ? `Text to ${c.phone}` : 'Send by SMS'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<Mail />}
          disabled={Boolean(disabled) || !email.available || !c.email}
          title={disabled ?? email.reason ?? (c.email ? undefined : 'No email on file')}
          loading={busy === 'email'}
          onClick={() => go('email')}
          data-testid={`send-email-${link}`}
        >
          {c.email ? `Email to ${c.email}` : 'Send by email'}
        </Button>
      </div>
      {c.phone ? <SmsConsentLine candidate={c} journey={j} /> : null}
      {!sms.available || !email.available ? (
        <ul className="flex flex-col gap-0.5 text-xs text-nw-text-3" data-testid={`channel-reasons-${link}`}>
          {!sms.available ? <li>SMS: {sms.reason}</li> : null}
          {!email.available ? <li>Email: {email.reason}</li> : null}
        </ul>
      ) : (
        <p className="text-xs text-nw-text-3">
          SMS via {sms.via} · Email via {email.via}
        </p>
      )}
    </div>
  );
}

/**
 * The candidate's texting consent: staff record how they agreed; their STOP ends it and only their
 * START brings it back (staff cannot override a STOP).
 */
function SmsConsentLine({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const off = useJourneyMutation(() => journeyApi.smsConsent(c.key, { action: 'opt_out', source: null, note: 'Turned off by staff' }));
  const s = j.deliveries.sms;
  const text =
    s.status === 'opted_in'
      ? `Texting consent: ${s.optedInSource ? SMS_OPT_IN_SOURCE_LABELS[s.optedInSource] : 'recorded'}${s.optedInBy ? ` · recorded by ${s.optedInBy}` : ''}${s.optedInAt ? ` · ${longDateTime(s.optedInAt)}` : ''}`
      : s.status === 'opted_out'
        ? `Texts off: ${s.optedOutSource === 'staff' ? 'turned off by staff' : 'the candidate replied STOP'}${s.optedOutAt ? ` on ${longDateTime(s.optedOutAt)}` : ''}${s.optedOutSource === 'staff' ? '' : ' — only their START turns texts back on'}`
        : 'Texting consent: not recorded — texts are not sent without it';
  const canRecord = s.status === 'none' || (s.status === 'opted_out' && s.optedOutSource === 'staff');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="sms-consent">
      <Pill family={s.status === 'opted_in' ? 'done' : s.status === 'opted_out' ? 'urgent' : 'neutral'}>
        {s.status === 'opted_in' ? 'Texts allowed' : s.status === 'opted_out' ? 'Texts off' : 'No texting consent'}
      </Pill>
      <span className="text-nw-text-3">{text}</span>
      {canRecord ? (
        <Button variant="ghost" size="sm" icon={<ShieldCheck />} onClick={() => setOpen(true)} data-testid="sms-consent-record">
          Record texting consent
        </Button>
      ) : s.status === 'opted_in' ? (
        <Button variant="ghost" size="sm" loading={off.isPending} onClick={() => off.mutate(undefined, { onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: errorText(e) }) })}>
          Turn texts off
        </Button>
      ) : null}
      {open ? <SmsConsentDialog candidate={c} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function SmsConsentDialog({ candidate: c, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const [source, setSource] = useState<SmsOptInSource>('verbal');
  const [note, setNote] = useState('');
  const save = useJourneyMutation(() => journeyApi.smsConsent(c.key, { action: 'opt_in', source, note: note.trim() || null }));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Record texting consent"
      description={`Only text ${c.phone ?? 'this number'} when the candidate agreed to receive texts about their application. Their STOP reply always ends it.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { toast({ tone: 'success', title: 'Texting consent recorded' }); onClose(); } })} data-testid="confirm-sms-consent">
            Record
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error ? <Alert tone="danger" title="Not recorded" description={errorText(save.error)} /> : null}
        <FormField label="How did they agree?">
          <Select aria-label="How did they agree?" value={source} onValueChange={(v) => setSource(v as SmsOptInSource)} options={SMS_OPT_IN_SOURCES.map((x) => ({ value: x, label: SMS_OPT_IN_SOURCE_LABELS[x] }))} />
        </FormField>
        <FormField label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. agreed on the call of Oct 11" />
        </FormField>
      </div>
    </Modal>
  );
}

/** What the TMS sent for this link: Sent, Delivered or Failed, with Resend and Check status. */
export function DeliveryList({ candidate: c, journey: j, link }: { candidate: RecruitCandidate; journey: CandidateJourney; link: JourneyLinkKind }) {
  const items = j.deliveries.items.filter((d) => d.link === link);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={`deliveries-${link}`}>
      <p className="text-xs font-semibold tracking-wide text-nw-text-3 uppercase">Sent by the TMS</p>
      <ul className="rounded-xl border border-nw-border">
        {items.map((d) => (
          <DeliveryRow key={d.id} candidate={c} delivery={d} canManage={j.permissions.canManage} />
        ))}
      </ul>
    </div>
  );
}

function DeliveryRow({ candidate: c, delivery: d, canManage }: { candidate: RecruitCandidate; delivery: LinkDeliveryView; canManage: boolean }) {
  const { toast } = useToast();
  const resend = useJourneyMutation(() => journeyApi.resendLink(c.key, d.id));
  const refresh = useJourneyMutation(() => journeyApi.refreshLink(c.key, d.id));
  const when = d.deliveredAt ?? d.failedAt ?? d.sentAt ?? d.createdAt;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-nw-border px-3 py-2.5 last:border-0" data-testid="delivery-row">
      {d.channel === 'sms' ? <MessageSquareText aria-hidden className="size-4 text-nw-text-3" /> : <Mail aria-hidden className="size-4 text-nw-text-3" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-nw-text">
          {d.channel === 'sms' ? 'SMS' : 'Email'} to {d.recipient}
          {d.resendOfId ? <span className="text-nw-text-3"> · resend</span> : null}
        </p>
        <p className="text-xs text-nw-text-3">
          {longDateTime(when)} · {d.createdByName}
          {d.channel === 'email' && d.status === 'sent' ? ' · accepted by the mail server (email has no delivery receipt)' : ''}
          {d.statusCheckedAt ? ` · checked ${longDateTime(d.statusCheckedAt)}` : ''}
          {!d.linkLive && d.status !== 'failed' ? ' · this link no longer works (a newer one was made)' : ''}
        </p>
        {d.error ? <p className="text-xs text-nw-urgent-text">{d.error}</p> : null}
      </div>
      <Pill family={FAMILY[d.status]} testId="delivery-status">
        {LINK_DELIVERY_STATUS_LABELS[d.status]}
      </Pill>
      {canManage && d.channel === 'sms' && d.status === 'sent' ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw />}
          loading={refresh.isPending}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast({ tone: 'danger', title: 'Status not checked', description: errorText(e) }) })}
        >
          Check status
        </Button>
      ) : null}
      {canManage ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCw />}
          loading={resend.isPending}
          title="Sends a new link to the same address; the old link stops working"
          onClick={() =>
            resend.mutate(undefined, {
              onSuccess: (r) => toast({ tone: r.status === 'failed' ? 'danger' : 'success', title: r.status === 'failed' ? 'Resend failed' : 'Sent again', description: r.error ?? undefined }),
              onError: (e) => toast({ tone: 'danger', title: 'Not sent', description: errorText(e) }),
            })
          }
          data-testid="delivery-resend"
        >
          Resend
        </Button>
      ) : null}
    </li>
  );
}

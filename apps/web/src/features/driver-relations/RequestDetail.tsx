import { Lock, Paperclip, Phone } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  CONTACT_METHODS,
  CONTACT_METHOD_LABELS,
  type ContactMethod,
  type DriverRelationActivity,
  type DriverRelationDetail,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  ErrorState,
  Select,
  StatusSymbol,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { openFile } from '@/lib/files';
import { formatDateTime, formatIsoDate, formatMoney, formatPhone } from '@/lib/format';
import {
  useAddNote,
  useAssign,
  useAssignees,
  useDriverRelationDetail,
  useRecordAttempt,
  useRecordContact,
  useReopen,
  useResolve,
} from './api';
import { LinksSection } from './LinksSection';
import { DriverMessageButton } from './DriverMessageButton';
import { RequestStatus } from './RequestStatus';

const ACTIVITY_LABEL: Record<DriverRelationActivity['type'], string> = {
  received: 'Request received',
  driver_message: 'New message from the driver',
  assigned: 'Assigned',
  attempt: 'Attempted contact',
  contacted: 'Contacted',
  note: 'Note',
  correction: 'Correction',
  resolved: 'Resolved',
  reopened: 'Reopened',
  linked: 'Linked records',
};

const PAYLOAD_LABELS: Record<string, string> = {
  referralName: 'Referred driver',
  referralPhone: 'Referred driver’s phone',
  callTopicLabel: 'Topic',
  amount: 'Amount paid',
  loadNumber: 'Load #',
  weekStart: 'Week starting',
  subjectLabel: 'Help with',
  preferredTime: 'Preferred call time',
};

function payloadValue(key: string, value: string | number | null): string | null {
  if (value === null || value === '') return null;
  if (key === 'amount' && typeof value === 'number') return formatMoney(value);
  if ((key === 'expenseDate' || key === 'weekStart') && typeof value === 'string') return formatIsoDate(value);
  if (key === 'referralPhone' && typeof value === 'string') return formatPhone(value);
  return String(value);
}

function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Not saved: the server could not be reached. Your note is still here; try again.';
    return `Not saved: ${error.message}`;
  }
  return 'Not saved. Your note is still here; try again.';
}

/**
 * The selected request: the driver's message, the red alert while contact is owed, the owner, the
 * contact method and the note, and the activity timeline beside it.
 *
 * The note is held by the page (per request, in memory) so assigning, a refetch or a failed save
 * never loses it; it is cleared only after the server confirms the write. Every button is
 * disabled while a write is in flight, so a double click is one request.
 */
export function RequestDetail({
  id,
  canContact,
  draft,
  onDraft,
}: {
  id: string;
  canContact: boolean;
  draft: string;
  onDraft: (value: string) => void;
}) {
  const detail = useDriverRelationDetail(id);
  const assignees = useAssignees();
  const contact = useRecordContact();
  const attempt = useRecordAttempt();
  const note = useAddNote();
  const resolve = useResolve();
  const reopen = useReopen();
  const assign = useAssign();
  const { toast } = useToast();
  const [method, setMethod] = useState<ContactMethod>('phone');
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const busy = contact.isPending || attempt.isPending || note.isPending || resolve.isPending || reopen.isPending || assign.isPending;

  if (detail.isPending) return <p className="px-6 py-10 text-center text-sm text-nw-text-3">Loading…</p>;
  if (detail.isError || !detail.data) {
    const status = detail.error instanceof ApiError ? detail.error.status : null;
    return (
      <ErrorState
        size="sm"
        className="py-8"
        title={status === 404 ? 'This request is not available' : 'The request could not be loaded'}
        error={detail.error}
        onRetry={status === 404 ? undefined : () => void detail.refetch()}
      />
    );
  }
  const { request, activities, deliveries, attachments } = detail.data;
  const resolved = request.status === 'resolved';

  const run = async (kind: 'contact' | 'attempt' | 'note' | 'reply' | 'resolve' | 'reopen') => {
    if (busy) return;
    setError(null);
    const text = draft.trim();
    if (!text) {
      setError(
        kind === 'contact'
          ? 'Write what was discussed before marking contacted.'
          : kind === 'resolve'
            ? 'Write a resolution note first.'
            : kind === 'reopen'
              ? 'Write why it is being reopened.'
              : 'Write a note first.',
      );
      noteRef.current?.focus();
      return;
    }
    try {
      let done: DriverRelationDetail;
      if (kind === 'contact') done = await contact.mutateAsync({ id, body: { method, note: text, expectedVersion: request.version } });
      else if (kind === 'attempt') done = await attempt.mutateAsync({ id, body: { method, note: text } });
      else if (kind === 'note') done = await note.mutateAsync({ id, body: { note: text } });
      // A reply the driver reads in the driver app (mobile M3); every other note stays internal.
      else if (kind === 'reply') done = await note.mutateAsync({ id, body: { note: text, shareWithDriver: true } });
      else if (kind === 'resolve') done = await resolve.mutateAsync({ id, body: { note: text, expectedVersion: request.version } });
      else done = await reopen.mutateAsync({ id, body: { note: text, expectedVersion: request.version } });
      onDraft('');
      toast({
        tone: 'success',
        title:
          kind === 'contact'
            ? `${done.request.requestNumber}: contact recorded`
            : kind === 'attempt'
              ? `${done.request.requestNumber}: attempt recorded — still needs contact`
              : kind === 'resolve'
                ? `${done.request.requestNumber} resolved`
                : kind === 'reopen'
                  ? `${done.request.requestNumber} reopened`
                  : kind === 'reply'
                    ? 'Reply sent to the driver app'
                    : 'Note saved',
      });
    } catch (e) {
      setError(failure(e));
      if (e instanceof ApiError && e.status === 409) void detail.refetch();
    }
  };

  const onAssign = async (value: string) => {
    if (busy) return;
    setError(null);
    try {
      await assign.mutateAsync({
        id,
        body: { assigneeUserId: value === 'unassigned' ? null : value, expectedVersion: request.version },
      });
    } catch (e) {
      setError(failure(e).replace('Your note is still here; try again.', 'Try again.'));
      if (e instanceof ApiError && e.status === 409) void detail.refetch();
    }
  };

  const ownerOptions = [
    { value: 'unassigned', label: 'Driver Relations (unassigned)' },
    ...(assignees.data ?? []).map((a) => ({ value: a.userId, label: a.name })),
  ];
  if (request.assignedUserId && !ownerOptions.some((o) => o.value === request.assignedUserId)) {
    ownerOptions.push({ value: request.assignedUserId, label: request.assignedUserName ?? 'Assigned' });
  }
  const payload = Object.entries(request.payload)
    .filter(([key]) => key in PAYLOAD_LABELS)
    .map(([key, value]) => [PAYLOAD_LABELS[key]!, payloadValue(key, value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  return (
    <div className="grid grid-cols-1 gap-6 p-5 2xl:grid-cols-[minmax(0,1fr)_200px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <RequestStatus request={request} label="Awaiting contact" />
            {request.confidential ? (
              <Badge tone="neutral" icon={<Lock className="size-3" aria-hidden />}>
                Confidential
              </Badge>
            ) : null}
          </span>
          <span className="text-sm text-nw-text-2">Request {request.requestNumber}</span>
        </div>
        <div>
          <h2 className="text-lg font-bold text-nw-text">{request.topicLabel}</h2>
          <p className="mt-1 text-md font-semibold text-nw-text">{request.submittedName}</p>
          <p className="text-sm text-nw-text-2">{request.truckNumber ? `Truck ${request.truckNumber}` : 'No truck given'}</p>
          {request.contactPhone ? (
            <a href={`tel:${request.contactPhone}`} className="mt-2 inline-flex items-center gap-2 text-sm text-nw-text hover:underline">
              <Phone className="size-4 text-nw-text-3" aria-hidden />
              {formatPhone(request.contactPhone)}
            </a>
          ) : (
            <p className="mt-2 text-xs text-nw-text-3">The referral form asks no phone of the referring driver; find them on the roster.</p>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-nw-text-2">Driver’s message</h3>
          <p className="rounded-md bg-nw-subtle px-3 py-2.5 text-sm whitespace-pre-wrap text-nw-text">{request.description}</p>
          {payload.length > 0 ? (
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {payload.map(([label, value]) => (
                <div key={label} className="flex gap-1.5">
                  <dt className="text-nw-text-3">{label}:</dt>
                  <dd className="text-nw-text">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {request.topic === 'management_call' ? (
            <p className="mt-1 text-2xs text-nw-text-3">A requested time, not a booked call.</p>
          ) : null}
          {attachments.length > 0 ? (
            <div className="mt-3">
              <h3 className="mb-1.5 text-xs font-semibold text-nw-text-2">Receipts ({attachments.length})</h3>
              <ul className="flex flex-col gap-1.5" aria-label="Receipts">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-nw-border px-2.5 py-1.5 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <Paperclip className="size-3.5 shrink-0 text-nw-text-3" aria-hidden />
                      <span className="truncate text-nw-text">{a.fileName}</span>
                      <span className="shrink-0 text-nw-text-3">{Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => openFile({ fileUrl: a.url, fileName: a.fileName, mimeType: a.contentType })}>
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {request.needsContact ? (
          <Alert tone="danger" title="Alert stays until contact is recorded." data-testid="contact-alert" />
        ) : null}

        <LinksSection request={request} canContact={canContact} />

        {canContact ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-nw-text-2">
                <span id={`owner-${id}`}>Assigned owner</span>
                <Select
                  aria-labelledby={`owner-${id}`}
                  value={request.assignedUserId ?? 'unassigned'}
                  onValueChange={(v) => void onAssign(v)}
                  disabled={busy || resolved}
                  options={ownerOptions}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-nw-text-2">
                <span id={`method-${id}`}>Contact method</span>
                <Select
                  aria-labelledby={`method-${id}`}
                  value={method}
                  onValueChange={(v) => setMethod(v as ContactMethod)}
                  disabled={busy}
                  options={CONTACT_METHODS.map((m) => ({ value: m, label: CONTACT_METHOD_LABELS[m] }))}
                />
              </label>
            </div>
            <label htmlFor={`note-${id}`} className="text-xs font-semibold text-nw-text-2">
              {resolved ? 'Reason to reopen (required)' : request.needsContact ? 'Contact note (required)' : 'Note (required)'}
            </label>
            <Textarea
              id={`note-${id}`}
              ref={noteRef}
              rows={3}
              value={draft}
              onChange={(e) => {
                onDraft(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Who did you reach, what was discussed, what happens next…"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `note-error-${id}` : undefined}
              maxLength={4000}
            />
            {error ? (
              <p id={`note-error-${id}`} role="alert" className="flex items-start gap-1.5 text-xs text-nw-urgent-text">
                <StatusSymbol family="urgent" size={13} className="mt-px shrink-0 text-nw-urgent-icon" />
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {resolved ? (
                <Button variant="primary" onClick={() => void run('reopen')} loading={reopen.isPending} disabled={busy}>
                  Reopen request
                </Button>
              ) : (
                <>
                  <Button variant="primary" onClick={() => void run('contact')} loading={contact.isPending} disabled={busy}>
                    {request.needsContact ? 'Mark Contacted & save note' : 'Record another contact'}
                  </Button>
                  <Button variant="secondary" onClick={() => void run('attempt')} loading={attempt.isPending} disabled={busy}>
                    Record attempt
                  </Button>
                  {!request.needsContact ? (
                    <Button variant="secondary" onClick={() => void run('resolve')} loading={resolve.isPending} disabled={busy}>
                      Resolve with this note
                    </Button>
                  ) : null}
                </>
              )}
              <Button variant="ghost" onClick={() => void run('note')} loading={note.isPending} disabled={busy}>
                Add note only
              </Button>
              {request.source === 'driver_app' ? (
                <Button variant="secondary" onClick={() => void run('reply')} loading={note.isPending} disabled={busy}>
                  Reply to the driver (app)
                </Button>
              ) : null}
              <DriverMessageButton request={request} disabled={busy} />
            </div>
            <p className="text-2xs text-nw-text-3">
              An attempt (no answer, voicemail) keeps the alert. Resolving needs a recorded contact first.
            </p>
          </div>
        ) : (
          <p className="text-xs text-nw-text-3">You can read this request. Recording contact needs the Driver Relations contact permission.</p>
        )}
      </div>

      <aside aria-label="Activity timeline" className="min-w-0 border-nw-border 2xl:border-l 2xl:pl-5">
        <h3 className="mb-3 text-sm font-bold text-nw-text">Activity timeline</h3>
        <Timeline activities={activities} contacted={Boolean(request.contactedAt)} resolved={resolved} />
        <div className="mt-4 border-t border-nw-border pt-3">
          <h4 className="mb-1 text-xs font-semibold text-nw-text-2">Notifications</h4>
          {deliveries.length === 0 ? (
            <p className="text-2xs text-nw-text-3">None queued.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {deliveries.map((d) => (
                <li key={d.id} className="text-2xs text-nw-text-3">
                  <Badge
                    size="sm"
                    dot
                    tone={d.status === 'sent' ? 'success' : d.status === 'failed' ? 'danger' : 'neutral'}
                  >
                    Telegram: {d.status === 'pending' ? 'not sent (queued)' : d.status === 'failed' ? 'delivery failed' : d.status}
                  </Badge>
                  {d.lastError ? <span className="mt-0.5 block">{d.lastError}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function Timeline({ activities, contacted, resolved }: { activities: DriverRelationActivity[]; contacted: boolean; resolved: boolean }) {
  const step = (done: boolean) => (
    <span
      aria-hidden
      className={cn(
        'absolute top-1 -left-[21px] size-2.5 rounded-full ring-2 ring-nw-panel',
        done ? 'bg-nw-accent' : 'border border-nw-border-strong bg-nw-panel',
      )}
    />
  );
  return (
    <ol className="relative ml-2 flex flex-col gap-4 border-l border-nw-border pl-4">
      {activities.map((a) => (
        <li key={a.id} className="relative text-xs">
          {step(true)}
          <p className="font-semibold text-nw-text">
            {ACTIVITY_LABEL[a.type]}
            {a.method ? ` · ${CONTACT_METHOD_LABELS[a.method]}` : ''}
          </p>
          <p className="text-2xs text-nw-text-3">{formatDateTime(a.at)}</p>
          <p className="text-2xs text-nw-text-3">By {a.actorName}</p>
          {a.type === 'assigned' && a.detail ? (
            <p className="text-2xs text-nw-text-2">To {String(a.detail.to ?? 'Driver Relations (unassigned)')}</p>
          ) : null}
          {a.note ? <p className="mt-1 text-2xs whitespace-pre-wrap text-nw-text-2">{a.note}</p> : null}
          {a.detail?.sharedWithDriver === true ? <p className="text-2xs font-semibold text-nw-info-text">Shared with the driver in the app</p> : null}
          {a.correctsActivityId ? <p className="text-2xs text-nw-text-3">Corrects an earlier entry, which is kept.</p> : null}
        </li>
      ))}
      {!contacted ? (
        <li className="relative text-xs">
          {step(false)}
          <p className="font-semibold text-nw-text-2">Contacted</p>
          <p className="text-2xs text-nw-text-3">Not yet recorded</p>
        </li>
      ) : null}
      {!resolved ? (
        <li className="relative text-xs">
          {step(false)}
          <p className="font-semibold text-nw-text-2">Resolved</p>
          <p className="text-2xs text-nw-text-3">Not yet recorded</p>
        </li>
      ) : null}
    </ol>
  );
}


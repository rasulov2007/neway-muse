import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Modal, useToast } from '@/design-system';
import {
  fetchStatementEmailPreview,
  fetchStatementEmailStatus,
  sendStatementEmail,
  sendStatementsEmail,
  type StatementEmailOutcome,
  type StatementEmailPreviewItem,
  type StatementEmailSkip,
  type StatementEmailState,
  type StatementEmailSummary,
} from '@/demo';
import { formatIsoDate } from '@/lib/format';

/**
 * Driver statements by email (owner brief 2026-10-27 §7.4). The page never names a recipient: the
 * server reads the address from each statement's own driver record, attaches that statement's PDF
 * and nothing else, and skips drivers with no email (listed here by name). Status is a symbol, a
 * word and a colour; a bounce says "check address".
 */

const KEY = ['accounting', 'statement-email'] as const;

export function useStatementEmailStatus(batchId: string | null | undefined) {
  return useQuery({ queryKey: [...KEY, 'status', batchId ?? null], queryFn: () => fetchStatementEmailStatus({ batchId: batchId! }), enabled: Boolean(batchId), staleTime: 15_000 });
}

const SKIP_WORDS: Record<StatementEmailSkip, string> = {
  no_email: 'No email on file',
  invalid_email: 'Email on file is not valid',
  not_approved: 'Not approved yet',
  already_sent: 'Already emailed',
  not_driver: 'Not a driver statement',
  in_progress: 'Being sent now',
};

const when = (iso: string) => formatIsoDate(new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));

/** The last email of one statement: Emailed / Delivered / Failed, or "Email bounced — check address". */
export function StatementEmailBadge({ state }: { state: StatementEmailState | null | undefined }) {
  if (!state) return null;
  if (state.bounced) return <Badge tone="danger" size="sm" dot title={state.error ?? undefined}>Email bounced — check address</Badge>;
  const look =
    state.status === 'delivered' ? { tone: 'success' as const, word: 'Email delivered' }
    : state.status === 'sent' ? { tone: 'info' as const, word: 'Emailed' }
    : state.status === 'queued' ? { tone: 'neutral' as const, word: 'Email sending' }
    : state.status === 'failed' ? { tone: 'danger' as const, word: 'Email failed' }
    : state.status === 'skipped' ? { tone: 'warning' as const, word: 'Email not sent' }
    : null;
  if (!look) return null;
  return <Badge tone={look.tone} size="sm" dot title={`${state.to ? `${state.to} · ` : ''}${when(state.at)}${state.error ? ` · ${state.error}` : ''}`}>{look.word}</Badge>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : undefined);

/** "Send by email" for one statement, with a confirm that names the driver and the address on file. */
export function SendStatementEmailButton({ s, canEdit, size = 'sm' }: { s: { id: string; batchId: string; settlementNumber: string; partyName: string; partyType: string; status: string }; canEdit: boolean; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const status = useStatementEmailStatus(s.batchId);
  if (s.partyType !== 'driver') return null;
  const state = status.data?.[s.id];
  const approved = s.status === 'approved' || s.status === 'paid';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {canEdit ? (
        <Button variant="secondary" size={size} icon={<Mail />} disabled={!approved} title={approved ? undefined : 'Approve the statement first; drafts are not emailed'} onClick={() => setOpen(true)}>
          Send by email
        </Button>
      ) : null}
      {status.isPending ? <span className="text-2xs text-muted">Loading…</span> : <StatementEmailBadge state={state} />}
      {open ? <SendOneDialog s={s} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function SendOneDialog({ s, onClose }: { s: { id: string; batchId: string; settlementNumber: string; partyName: string }; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: [...KEY, 'preview', s.batchId, true], queryFn: () => fetchStatementEmailPreview(s.batchId, true) });
  const item: StatementEmailPreviewItem | undefined = preview.data?.items.find((i) => i.statementId === s.id);
  const already = Boolean(item?.last && ['queued', 'sent', 'delivered'].includes(item.last.status));
  const send = useMutation({
    mutationFn: () => sendStatementEmail(s.id, already),
    onSuccess: async (r: StatementEmailOutcome) => {
      await queryClient.invalidateQueries({ queryKey: KEY });
      toast({ tone: r.status === 'sent' ? 'success' : 'danger', title: r.status === 'sent' ? `Emailed to ${r.driverName}` : 'Email not sent', description: r.status === 'sent' ? `${s.settlementNumber} · PDF attached · ${r.recipient ?? ''}` : (r.error ?? undefined) });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Email not sent', description: errorText(e) }),
  });
  const blocked = item ? item.refused ?? (item.reason && item.reason !== 'already_sent' ? SKIP_WORDS[item.reason] : null) : null;
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={already ? `Resend ${s.settlementNumber}?` : `Email ${s.settlementNumber}?`}
      description="One email to this driver, with this statement's PDF attached. The address is the one on the driver's own file."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Mail />} disabled={!item || Boolean(blocked)} loading={send.isPending} onClick={() => send.mutate()}>{already ? 'Resend' : 'Send'}</Button>
        </>
      }
    >
      {preview.isPending ? <p className="text-sm text-muted">Loading…</p> : preview.isError ? <Alert tone="danger" title="Could not check the address" description={errorText(preview.error)} /> : item ? (
        <div className="flex flex-col gap-2 text-sm">
          <p><span className="text-muted">Driver</span> <span className="font-semibold text-ink">{item.driverName}</span></p>
          <p><span className="text-muted">Email on file</span> <span className="font-semibold text-ink">{item.recipient ?? 'none'}</span></p>
          {item.last ? <p className="flex items-center gap-2"><span className="text-muted">Last email</span><StatementEmailBadge state={item.last} /></p> : null}
          {blocked ? <Alert tone="warning" title="Cannot be sent" description={blocked} /> : null}
          {already ? <p className="text-xs text-secondary">This statement was already emailed. Resend sends it again to the address on file now.</p> : null}
          {!preview.data?.ready ? <p className="text-xs text-warning-text">Email is not set up on this server; the send will be logged as not sent.</p> : null}
        </div>
      ) : <p className="text-sm text-muted">This statement is not in its week's list.</p>}
    </Modal>
  );
}

/** "Send all by email" for the week: confirm with counts and the drivers skipped, then the summary. */
export function SendAllEmailDialog({ batchId, weekLabel, onClose }: { batchId: string; weekLabel: string; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resend, setResend] = useState(false);
  const [result, setResult] = useState<StatementEmailSummary | null>(null);
  const preview = useQuery({ queryKey: [...KEY, 'preview', batchId, resend], queryFn: () => fetchStatementEmailPreview(batchId, resend) });
  const send = useMutation({
    mutationFn: () => sendStatementsEmail(batchId, resend),
    onSuccess: async (r) => {
      setResult(r);
      await queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Send all did not run', description: errorText(e) }),
  });
  const items = preview.data?.items ?? [];
  const toSend = items.filter((i) => i.action === 'send');
  const noEmail = items.filter((i) => i.reason === 'no_email' || i.reason === 'invalid_email');
  const other = items.filter((i) => i.action === 'skip' && i.reason !== 'no_email' && i.reason !== 'invalid_email');

  if (result) {
    return (
      <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title="Send all by email · done" description={weekLabel} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <div className="flex flex-col gap-3 text-sm" data-testid="email-summary">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success" dot>{result.sent.length} sent</Badge>
            <Badge tone={result.failed.length ? 'danger' : 'neutral'} dot>{result.failed.length} failed</Badge>
            <Badge tone={result.skipped_no_email.length ? 'warning' : 'neutral'} dot>{result.skipped_no_email.length} without email</Badge>
            <Badge tone="neutral" dot>{result.skipped.length} skipped</Badge>
          </div>
          <OutcomeList title="Not sent — failed" rows={result.failed} detail={(o) => o.error ?? 'Failed'} />
          <OutcomeList title="No email on file — add one on the driver's profile" rows={result.skipped_no_email} detail={(o) => SKIP_WORDS[o.reason ?? 'no_email']} />
          <OutcomeList title="Skipped" rows={result.skipped} detail={(o) => (o.reason ? SKIP_WORDS[o.reason] : '')} />
          <OutcomeList title="Sent" rows={result.sent} detail={(o) => o.recipient ?? ''} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="md"
      title="Send all statements by email"
      description={`${weekLabel}. One email per driver, their own statement attached, to the address on their driver file. Emailing never marks anything paid.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Mail />} disabled={toSend.length === 0 || preview.data?.running} loading={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : `Send ${toSend.length}`}
          </Button>
        </>
      }
    >
      {preview.isPending ? <p className="text-sm text-muted">Loading…</p> : preview.isError ? <Alert tone="danger" title="Could not prepare the list" description={errorText(preview.error)} /> : (
        <div className="flex flex-col gap-3 text-sm" data-testid="email-confirm">
          <p className="font-semibold text-ink">{toSend.length} statement{toSend.length === 1 ? '' : 's'} will be emailed{noEmail.length ? ` · ${noEmail.length} driver${noEmail.length === 1 ? '' : 's'} skipped (no email)` : ''}{other.length ? ` · ${other.length} skipped for other reasons` : ''}.</p>
          {preview.data?.running ? <Alert tone="info" title="Send all is already running for this week" description="Wait for it to finish, then open this again." /> : null}
          {!preview.data?.ready ? <Alert tone="warning" title="Email is not set up on this server" description="Each send will be logged as not sent." /> : null}
          {noEmail.length ? (
            <div>
              <p className="text-xs font-semibold text-ink">Skipped — no email on file</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">{noEmail.map((i) => <li key={i.statementId}>{i.driverName} · {i.settlementNumber} · {SKIP_WORDS[i.reason!]}</li>)}</ul>
            </div>
          ) : null}
          {other.length ? (
            <div>
              <p className="text-xs font-semibold text-ink">Skipped</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">{other.map((i) => <li key={i.statementId}>{i.driverName} · {i.settlementNumber} · {i.refused ?? (i.reason ? SKIP_WORDS[i.reason] : '')}</li>)}</ul>
            </div>
          ) : null}
          {toSend.length ? (
            <div>
              <p className="text-xs font-semibold text-ink">Will be emailed</p>
              <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-auto text-xs text-secondary">{toSend.map((i) => <li key={i.statementId}>{i.driverName} · {i.settlementNumber} · {i.recipient}{i.last?.bounced ? ' · last email bounced' : ''}</li>)}</ul>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-secondary">
            <Checkbox checked={resend} onCheckedChange={(v) => setResend(v === true)} aria-label="Also resend to drivers already emailed" />
            Also resend to drivers already emailed this week
          </label>
        </div>
      )}
    </Modal>
  );
}

function OutcomeList({ title, rows, detail }: { title: string; rows: StatementEmailOutcome[]; detail: (o: StatementEmailOutcome) => string }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-ink">{title}</p>
      <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-auto text-xs text-secondary">{rows.map((o) => <li key={o.statementId}>{o.driverName} · {o.settlementNumber}{detail(o) ? ` · ${detail(o)}` : ''}</li>)}</ul>
    </div>
  );
}

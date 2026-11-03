import { Link, useNavigate } from '@tanstack/react-router';
import {
  Ban,
  ChevronRight,
  Download,
  Eye,
  FileDown,
  FileText,
  MapPin,
  Pause,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  CircleX,
  Wallet,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  EFS_STATUS_LABEL,
  FLEET_EXPENSE_CHARGE_TO_LABEL,
  FLEET_EXPENSE_OUTCOME_LABEL,
  FLEET_EXPENSE_PAYER_LABEL,
  FLEET_PAYMENT_METHOD_LABEL,
  INVESTIGATION_OVERDUE_DAYS,
  type FleetExpenseDetail,
  type InvestigationItem,
  type FleetExpenseFileView,
  type FleetExpenseRecoveryAction,
} from '@neway/shared';
import {
  Alert,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  FormField,
  IconButton,
  Input,
  Textarea,
  Tooltip,
  useToast,
} from '@/design-system';
import { DocumentViewer } from '@/features/documents';
import { downloadFile, uploadFile } from '@/lib/files';
import { formatDateTime, formatIsoDate, parseMoney } from '@/lib/format';
import {
  errorText,
  expensePdfPath,
  fetchPdf,
  storedFileUrl,
  useAttachFile,
  useExpenseDetail,
  usePostExpense,
  useRecoveryAction,
  useRemoveFile,
  useVoidExpense,
} from './api';
import { CategoryLabel, Fact, LookBadge, PaymentStatusBadge, RecoveryStatusBadge } from './expense-ui';
import { SettleInvestigationDialog } from './investigations';
import { fullAddress, mapHref, money } from './expense-format';
import { FilePick } from './ExpenseFormDialog';

/**
 * One expense, in a side panel (the accepted detail design, owner 2026-10-12): the amount large,
 * then Expense and location, Payment, EFS and deduction when there is one, Documents, Accounting
 * and History. Every action is the server's to allow - the panel offers what `permissions` and
 * the expense's state say, and the server checks again.
 */
export function ExpenseDetailDrawer({
  expenseId,
  onClose,
  onEdit,
}: {
  expenseId: string | null;
  onClose: () => void;
  onEdit: (detail: FleetExpenseDetail) => void;
}) {
  const query = useExpenseDetail(expenseId);
  const d = query.data;
  return (
    <Drawer
      open={expenseId !== null}
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={d ? `${d.reference} · ${d.categoryLabel}` : 'Expense'}
      headerExtra={
        d ? (
          <>
            {d.status === 'draft' ? <LookBadge look="neutral">Draft</LookBadge> : null}
            {d.status === 'void' ? <LookBadge look="neutral">Void</LookBadge> : null}
            {d.status === 'recorded' ? <PaymentStatusBadge status={d.paymentStatus} /> : null}
            {d.status === 'recorded' && d.recoveryStatus !== 'none' ? <RecoveryStatusBadge status={d.recoveryStatus} /> : null}
          </>
        ) : null
      }
      description={d ? `${d.unitNumber ? `Unit ${d.unitNumber}` : 'No truck'} · ${formatIsoDate(d.expenseDate)}` : undefined}
    >
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !d ? (
        <p className="py-16 text-center text-sm text-nw-text-3">Loading…</p>
      ) : (
        <DetailBody d={d} onEdit={() => onEdit(d)} />
      )}
    </Drawer>
  );
}

function DetailBody({ d, onEdit }: { d: FleetExpenseDetail; onEdit: () => void }) {
  const { toast } = useToast();
  const voidExpense = useVoidExpense();
  const post = usePostExpense();
  const [voiding, setVoiding] = useState(false);
  const [posting, setPosting] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const address = fullAddress(d);
  const live = d.status !== 'void';

  async function pdf(mode: 'open' | 'download') {
    setPdfBusy(true);
    try {
      await fetchPdf(expensePdfPath(d.id), {}, mode, `${d.reference}.pdf`);
    } catch (error) {
      toast({ tone: 'danger', title: 'The PDF could not be prepared', description: errorText(error) });
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-4">
      {d.status === 'void' ? (
        <Alert
          tone="neutral"
          title="This expense is void"
          description={`${d.voidReason ?? ''}${d.voidedBy ? ` — ${d.voidedBy}` : ''}${d.voidedAt ? `, ${formatDateTime(d.voidedAt)}` : ''}. It is kept and counted nowhere.`}
        />
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="tabular text-[32px] leading-none font-bold tracking-[-0.02em] text-nw-text">{money(d.amountCents)}</p>
          <p className="mt-1.5 text-[13px] text-nw-text-2">{FLEET_EXPENSE_OUTCOME_LABEL[d.outcome]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" icon={<Eye />} disabled={pdfBusy} onClick={() => void pdf('open')}>
            Preview PDF
          </Button>
          <Button variant="outline" size="sm" icon={<FileDown />} disabled={pdfBusy} onClick={() => void pdf('download')}>
            Download PDF
          </Button>
          {d.permissions.canEdit && live ? (
            <Button variant="outline" size="sm" icon={<Pencil />} onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {d.permissions.canVoid && live ? (
            <Button variant="ghost" size="sm" icon={<Ban />} onClick={() => setVoiding(true)}>
              Void
            </Button>
          ) : null}
        </div>
      </div>

      <Section title="Expense and location">
        <dl>
          <Fact label="Reference">{d.reference}</Fact>
          <Fact label="Truck">
            <Link to="/fleet/trucks/$truckId" params={{ truckId: d.truckId }} search={{ tab: 'expenses' }} className="font-semibold text-nw-accent-ink hover:underline">
              {d.unitNumber ? `Unit ${d.unitNumber}` : 'No truck'}
            </Link>
          </Fact>
          <Fact label="Category"><CategoryLabel category={d.category} label={d.categoryLabel} /></Fact>
          <Fact label="Expense date">{formatIsoDate(d.expenseDate)}</Fact>
          <Fact label="Vendor">{d.vendorName ?? '—'}</Fact>
          {d.invoiceNumber ? <Fact label="Invoice #">{d.invoiceNumber}</Fact> : null}
          {d.description ? <Fact label="Description">{d.description}</Fact> : null}
          {d.placeName ? <Fact label={d.category === 'parking' ? 'Parking name' : d.category === 'truck_wash' ? 'Wash name' : 'Place'}>{d.placeName}</Fact> : null}
          {address ? (
            <Fact label="Address">
              <span className="block">{address}</span>
              <a href={mapHref(address)!} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline">
                <MapPin aria-hidden className="size-3.5" /> Open map
              </a>
            </Fact>
          ) : null}
        </dl>
        {d.notes ? (
          <div className="mt-2 rounded-[10px] bg-nw-subtle px-3 py-2.5">
            <p className="text-xs font-semibold text-nw-text-3">Notes</p>
            <p className="mt-1 text-[13px] whitespace-pre-wrap text-nw-text">{d.notes}</p>
          </div>
        ) : null}
      </Section>

      <Section title="Payment">
        <dl>
          <Fact label="Paid by">
            {FLEET_EXPENSE_PAYER_LABEL[d.paidBy]}
            {d.payerDriverName ? ` · ${d.payerDriverName}` : d.payerName ? ` · ${d.payerName}` : ''}
          </Fact>
          <Fact label="Payment method">{d.paymentMethod ? FLEET_PAYMENT_METHOD_LABEL[d.paymentMethod] : '—'}</Fact>
          <Fact label="Payment status"><PaymentStatusBadge status={d.paymentStatus} /></Fact>
          {d.paymentReference ? <Fact label="Payment reference">{d.paymentReference}</Fact> : null}
          <Fact label="Charge to">
            {FLEET_EXPENSE_CHARGE_TO_LABEL[d.chargeTo]}
            {d.chargeDriverName ? ` · ${d.chargeDriverName}` : ''}
            {d.chargeTo === 'investigation' && d.status === 'recorded' ? <SettleButton d={d} /> : null}
          </Fact>
          {d.chargeCents !== null && d.chargeTo === 'driver' ? (
            <>
              <Fact label="Driver charge">{money(d.chargeCents)}</Fact>
              {d.chargeReason ? <Fact label="Reason">{d.chargeReason}</Fact> : null}
              <Fact label="Deduct from settlement">{d.deductFromSettlement ? 'Requested — Accounting approves it' : 'No'}</Fact>
            </>
          ) : null}
        </dl>
      </Section>

      {d.efs || d.recovery ? <EfsAndDeduction d={d} /> : null}

      <Documents d={d} />

      <Section title="Accounting">
        <p className="text-[13px] text-nw-text-2">{accountingLine(d)}</p>
        {d.accounting.postedAt ? (
          <p className="mt-1 text-xs text-nw-text-3">
            Posted {formatDateTime(d.accounting.postedAt)}
            {d.accounting.postedBy ? ` by ${d.accounting.postedBy}` : ''}
          </p>
        ) : null}
        {d.accounting.links.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-nw-border rounded-[10px] border border-nw-border">
            {d.accounting.links.map((l) => (
              <li key={`${l.kind}:${l.id}`} className="flex items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <RouterHref href={l.href} className="block truncate text-[13px] font-semibold text-nw-accent-ink hover:underline">
                    {l.label}
                  </RouterHref>
                  <span className="block text-xs text-nw-text-3">
                    {l.status}
                    {l.at ? ` · ${formatDateTime(l.at)}` : ''}
                    {l.by ? ` · ${l.by}` : ''}
                  </span>
                </span>
                {l.amountCents !== null ? <span className="tabular text-[13px] font-semibold text-nw-text">{money(l.amountCents)}</span> : null}
                <ChevronRight aria-hidden className="size-4 text-nw-text-3" />
              </li>
            ))}
          </ul>
        ) : null}
        {d.permissions.canPost && d.accounting.state === 'awaiting_posting' && d.outcome !== 'investigation' ? (
          <Button className="mt-3" icon={<Send />} onClick={() => setPosting(true)}>
            Post to Accounting
          </Button>
        ) : null}
      </Section>

      <details className="group rounded-[10px] border border-nw-border">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-bold text-nw-text">
          History
          <span className="text-xs font-medium text-nw-text-3">{d.history.length} {d.history.length === 1 ? 'entry' : 'entries'}</span>
        </summary>
        <ol className="flex flex-col gap-3 border-t border-nw-border px-4 py-3">
          {d.history.map((h, i) => (
            <li key={`${h.at}:${i}`} className="text-[13px]">
              <p className="font-semibold text-nw-text">{h.summary}</p>
              <p className="text-xs text-nw-text-3">
                {formatDateTime(h.at)} · {h.by}
                {h.reason ? ` · ${h.reason}` : ''}
              </p>
            </li>
          ))}
          <li className="text-xs text-nw-text-3">
            Created {formatDateTime(d.createdAt)} by {d.createdBy}
          </li>
        </ol>
      </details>

      <ReasonDialog
        open={voiding}
        onOpenChange={setVoiding}
        title={`Void ${d.reference}?`}
        description="The expense is kept and hidden, and counted nowhere. Anything already posted in Accounting follows Accounting's own reversal."
        confirmLabel="Void expense"
        tone="danger"
        onConfirm={async (reason) => {
          try {
            await voidExpense.mutateAsync({ id: d.id, reason });
            toast({ tone: 'success', title: `${d.reference} voided` });
          } catch (error) {
            toast({ tone: 'danger', title: 'Not voided', description: errorText(error) });
            throw error;
          }
        }}
      />
      <ConfirmDialog
        open={posting}
        onOpenChange={setPosting}
        title={`Post ${d.reference} to Accounting?`}
        description={postingLine(d)}
        confirmLabel="Post to Accounting"
        onConfirm={async () => {
          try {
            await post.mutateAsync(d.id);
            toast({ tone: 'success', title: `${d.reference} posted to Accounting` });
          } catch (error) {
            toast({ tone: 'danger', title: 'Not posted', description: errorText(error) });
            throw error;
          }
        }}
      />
    </div>
  );
}

function accountingLine(d: FleetExpenseDetail): string {
  switch (d.accounting.state) {
    case 'not_required':
      return 'Nothing goes to Accounting: tracked fleet spend only, no payable and no deduction.';
    case 'awaiting_posting':
      return 'Recorded, not yet posted to Accounting. Company cost counts it once it is posted.';
    case 'posted':
      return 'Posted to Accounting.';
    case 'draft':
      return 'A draft goes nowhere until it is saved as an expense.';
    case 'void':
      return 'Void: counted nowhere.';
  }
}

function postingLine(d: FleetExpenseDetail): string {
  switch (d.outcome) {
    case 'company_cost':
      return d.paid ? 'Accounting gets the payment record for this expense.' : 'Accounting gets one vendor bill for this expense.';
    case 'driver_charge':
      return `Accounting gets the payment once, plus a driver charge of ${money(d.chargeCents)} to review. Nothing is deducted until Accounting approves it.`;
    case 'reimbursement':
      return 'Accounting gets a reimbursement for the driver who paid.';
    case 'external':
      return 'Nothing to post: this cost was paid and borne outside the company.';
    case 'investigation':
      return 'Held: it goes to Accounting once a fleet manager or Safety decides who bears it.';
  }
}

/** Under investigation: settle it as Company or Driver from the expense itself (owner, 2026-10-13). */
function SettleButton({ d }: { d: FleetExpenseDetail }) {
  const [open, setOpen] = useState(false);
  const [now] = useState(() => Date.now());
  if (!d.permissions.canEdit) return null;
  const days = Math.max(0, Math.floor((now - Date.parse(d.createdAt)) / 86_400_000));
  const item: InvestigationItem = {
    kind: 'fleet_expense',
    id: d.id,
    reference: d.reference,
    unitKind: 'truck',
    unitId: d.truckId,
    unitNumber: d.unitNumber,
    driverId: d.chargeDriverId,
    driverName: d.chargeDriverName,
    amountCents: d.chargeCents ?? d.amountCents,
    date: d.expenseDate,
    since: d.createdAt,
    days,
    overdue: days > INVESTIGATION_OVERDUE_DAYS,
    description: d.description,
    open: false,
    version: d.version,
  };
  return (
    <>
      <Button size="sm" variant="outline" className="ml-2" onClick={() => setOpen(true)} data-testid="expense-settle">
        Settle
      </Button>
      {open ? <SettleInvestigationDialog item={item} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------- EFS & deduction

function EfsAndDeduction({ d }: { d: FleetExpenseDetail }) {
  const { toast } = useToast();
  const recovery = useRecoveryAction();
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'hold' | 'cancel' } | { kind: 'reverse'; settlementId: string; label: string }>(null);
  const [cap, setCap] = useState('');
  const r = d.recovery;
  const canRecover = d.permissions.canRecover && d.status === 'recorded';

  async function act(action: FleetExpenseRecoveryAction, done: string) {
    try {
      await recovery.mutateAsync({ id: d.id, action });
      toast({ tone: 'success', title: done });
    } catch (error) {
      toast({ tone: 'danger', title: 'Nothing changed', description: errorText(error) });
      throw error;
    }
  }

  return (
    <Section title="EFS and deduction">
      {d.efs ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure label="Issued" value={money(d.efs.issuedCents)} />
            <Figure label="Used" value={money(d.efs.usedCents)} />
            <Figure label="Unused" value={money(d.efs.unusedCents)} hint="Not spend" />
          </div>
          <dl className="mt-2">
            <Fact label="EFS code">{d.efs.masked ?? '—'}</Fact>
            <Fact label="Issued on">{formatIsoDate(d.efs.issuedOn)}</Fact>
            <Fact label="EFS status">{EFS_STATUS_LABEL[d.efs.status]}</Fact>
          </dl>
        </>
      ) : null}

      {r ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure label="Driver charge" value={money(r.chargeCents)} />
            <Figure label="Deducted" value={money(r.deductedCents)} />
            <Figure label="Remaining" value={money(r.remainingCents)} strong />
          </div>
          <dl>
            <Fact label="Driver">{r.driverName ?? '—'}</Fact>
            <Fact label="Recovery"><RecoveryStatusBadge status={d.recoveryStatus} /></Fact>
            {r.perSettlementCents !== null ? <Fact label="Per settlement">Up to {money(r.perSettlementCents)}</Fact> : null}
            {r.approvedAt ? <Fact label="Approved">{formatDateTime(r.approvedAt)}{r.approvedBy ? ` · ${r.approvedBy}` : ''}</Fact> : null}
          </dl>
          {r.inDraft ? (
            <Alert
              tone="info"
              title={`In draft settlement ${r.inDraft.settlementNumber}: ${money(r.inDraft.cents)}`}
              description="Not deducted yet. Remaining goes down only when that settlement is posted."
            />
          ) : null}
          {r.entries.length > 0 ? (
            <ul className="flex flex-col divide-y divide-nw-border rounded-[10px] border border-nw-border">
              {r.entries.map((e, i) => (
                <li key={`${e.settlementId}:${i}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-nw-text">
                      Settlement {e.settlementNumber ?? e.settlementId}
                    </span>
                    <span className="block text-xs text-nw-text-3">
                      {formatDateTime(e.at)}
                      {e.status === 'reversed' && e.reversedAt ? ` · reversed ${formatDateTime(e.reversedAt)}${e.reversedBy ? ` by ${e.reversedBy}` : ''}` : ''}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </span>
                  </span>
                  <span className="tabular text-[13px] font-semibold text-nw-text">{money(e.cents)}</span>
                  {e.status === 'posted' ? (
                    <LookBadge look="done" size="sm">Deducted</LookBadge>
                  ) : e.status === 'reversed' ? (
                    <LookBadge look="neutral" size="sm">Reversed</LookBadge>
                  ) : (
                    <LookBadge look="moving" size="sm">In draft</LookBadge>
                  )}
                  {canRecover && e.status === 'posted' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<RotateCcw />}
                      onClick={() => setDialog({ kind: 'reverse', settlementId: e.settlementId, label: e.settlementNumber ?? e.settlementId })}
                    >
                      Reverse
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-nw-text-3">Nothing deducted yet.</p>
          )}
          {canRecover && r.remainingCents > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Wallet />} onClick={() => setDialog({ kind: 'add' })}>
                Add to next settlement
              </Button>
              <Button size="sm" variant="outline" icon={<Pause />} onClick={() => setDialog({ kind: 'hold' })}>
                Hold
              </Button>
              <Button size="sm" variant="ghost" icon={<CircleX />} onClick={() => setDialog({ kind: 'cancel' })}>
                Cancel recovery
              </Button>
            </div>
          ) : null}
          {!d.permissions.canRecover && r.remainingCents > 0 ? (
            <p className="text-xs text-nw-text-3">Accounting adds the charge to a settlement under its own approval rules.</p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === 'add'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Add to the next settlement?"
        description={`The next eligible settlement takes up to the remaining ${money(r?.remainingCents ?? 0)}. It is deducted when that settlement is posted, not before.`}
        confirmLabel="Add to next settlement"
        onConfirm={() => {
          const capCents = cap.trim() ? Math.round((parseMoney(cap) ?? 0) * 100) : null;
          return act({ action: 'add_to_settlement', perSettlementCents: capCents && capCents > 0 ? capCents : null, reason: '' }, 'Added to the next settlement');
        }}
      >
        <FormField label="Most per settlement" description="Optional: leave empty to take the whole remaining amount.">
          <Input inputMode="decimal" prefix="$" placeholder="0.00" value={cap} onChange={(e) => setCap(e.target.value)} />
        </FormField>
      </ConfirmDialog>
      <ReasonDialog
        open={dialog?.kind === 'hold'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Hold this recovery?"
        description="Nothing is taken from settlements until it is released."
        confirmLabel="Hold"
        onConfirm={(reason) => act({ action: 'hold', reason }, 'Recovery on hold')}
      />
      <ReasonDialog
        open={dialog?.kind === 'cancel'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Cancel this recovery?"
        description="The remaining amount is no longer recovered from the driver; the company bears it."
        confirmLabel="Cancel recovery"
        tone="danger"
        onConfirm={(reason) => act({ action: 'cancel', reason }, 'Recovery cancelled')}
      />
      <ReasonDialog
        open={dialog?.kind === 'reverse'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog?.kind === 'reverse' ? `Reverse the deduction on settlement ${dialog.label}?` : 'Reverse the deduction?'}
        description="The amount comes back to the balance and the driver is refunded on the next settlement."
        confirmLabel="Reverse deduction"
        tone="danger"
        onConfirm={(reason) =>
          dialog?.kind === 'reverse'
            ? act({ action: 'reverse', settlementId: dialog.settlementId, reason }, 'Deduction reversed')
            : Promise.resolve()
        }
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------- documents

function Documents({ d }: { d: FleetExpenseDetail }) {
  const { toast } = useToast();
  const attach = useAttachFile();
  const remove = useRemoveFile();
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<FleetExpenseFileView | null>(null);
  const [removing, setRemoving] = useState<FleetExpenseFileView | null>(null);
  const canAdd = d.permissions.canEdit && d.status !== 'void';

  async function add(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const stored = await uploadFile(file);
        await attach.mutateAsync({ id: d.id, fileId: stored.id, kind: 'receipt' });
      }
      toast({ tone: 'success', title: list.length === 1 ? 'File attached' : `${list.length} files attached` });
    } catch (error) {
      toast({ tone: 'danger', title: 'The file was not attached', description: errorText(error) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Section
      title="Documents"
      action={canAdd ? <FilePick label={uploading ? 'Uploading…' : 'Upload'} disabled={uploading} multiple onFiles={(f) => void add(f)} /> : null}
    >
      {d.files.length === 0 ? (
        <p className="text-[13px] text-nw-text-3">No receipt or invoice attached.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-nw-border rounded-[10px] border border-nw-border">
          {d.files.map((f) => {
            const ref = { fileUrl: storedFileUrl(f.fileId), fileName: f.fileName, mimeType: f.contentType ?? undefined };
            return (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <FileText aria-hidden className="size-4 shrink-0 text-nw-text-3" />
                <span className="min-w-0 flex-1">
                  <button type="button" onClick={() => setViewing(f)} className="block max-w-full truncate text-left text-[13px] font-semibold text-nw-accent-ink hover:underline">
                    {f.fileName}
                  </button>
                  <span className="block text-xs text-nw-text-3">
                    {KIND_LABEL[f.kind]} · {formatDateTime(f.addedAt)} · {f.addedBy}
                  </span>
                  {!f.removable && f.removeBlockedReason ? <span className="block text-xs text-nw-text-3">{f.removeBlockedReason}</span> : null}
                </span>
                <span className="flex items-center gap-1">
                  <IconButton label={`View ${f.fileName}`} size="sm" onClick={() => setViewing(f)}>
                    <Eye />
                  </IconButton>
                  <IconButton label={`Download ${f.fileName}`} size="sm" onClick={() => downloadFile(ref, f.fileName)}>
                    <Download />
                  </IconButton>
                  <span className="ml-3">
                    {f.removable && canAdd ? (
                      <IconButton label={`Remove ${f.fileName}`} size="sm" className="text-nw-urgent-icon" onClick={() => setRemoving(f)}>
                        <Trash2 />
                      </IconButton>
                    ) : (
                      <Tooltip content={f.removeBlockedReason ?? 'This file cannot be removed here.'}>
                        <span tabIndex={0} className="inline-flex">
                          <IconButton label={`${f.fileName} cannot be removed`} size="sm" disabled className="text-nw-text-3">
                            <Trash2 />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {viewing ? (
        <DocumentViewer
          source={{ kind: 'file', file: { fileUrl: storedFileUrl(viewing.fileId), fileName: viewing.fileName, mimeType: viewing.contentType ?? undefined } }}
          title={viewing.fileName}
          subtitle={`${KIND_LABEL[viewing.kind]} · ${d.reference} · added ${formatDateTime(viewing.addedAt)} by ${viewing.addedBy}`}
          contentType={viewing.contentType ?? undefined}
          fileName={viewing.fileName}
          onClose={() => setViewing(null)}
        />
      ) : null}

      <ReasonDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? `Remove ${removing.fileName}?` : 'Remove file?'}
        description="The file is taken off this expense and kept in the audit history. Say why."
        confirmLabel="Remove file"
        tone="danger"
        onConfirm={async (reason) => {
          if (!removing) return;
          try {
            await remove.mutateAsync({ id: d.id, fileRowId: removing.id, reason });
            toast({ tone: 'success', title: `${removing.fileName} removed` });
          } catch (error) {
            toast({ tone: 'danger', title: 'The file was not removed', description: errorText(error) });
            throw error;
          }
        }}
      />
    </Section>
  );
}

const KIND_LABEL: Record<FleetExpenseFileView['kind'], string> = {
  receipt: 'Receipt',
  invoice: 'Invoice',
  efs_receipt: 'EFS receipt',
  other: 'Other',
};

// ---------------------------------------------------------------------------- pieces

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-nw-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-nw-text">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Figure({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2.5">
      <p className="text-xs text-nw-text-3">{label}</p>
      <p className={strong ? 'tabular text-lg font-bold text-nw-text' : 'tabular text-base font-semibold text-nw-text'}>{value}</p>
      {hint ? <p className="text-2xs text-nw-text-3">{hint}</p> : null}
    </div>
  );
}

/** A link the server wrote (Accounting's own pages), followed inside the app. */
function RouterHref({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || !href.startsWith('/')) return;
        e.preventDefault();
        void navigate({ href });
      }}
    >
      {children}
    </a>
  );
}

/** A confirmation that needs a reason: void, remove, hold, cancel, reverse. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'default',
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason('');
          setError(null);
        }
        onOpenChange(next);
      }}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      onConfirm={async () => {
        if (reason.trim().length < 3) {
          setError('Say why, in a few words.');
          throw new Error('reason');
        }
        await onConfirm(reason.trim());
        setReason('');
        setError(null);
      }}
    >
      <FormField label="Reason" required error={error ?? undefined}>
        <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </ConfirmDialog>
  );
}


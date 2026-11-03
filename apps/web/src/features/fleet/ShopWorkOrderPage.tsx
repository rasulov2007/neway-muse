import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Gauge,
  MessageSquarePlus,
  RotateCcw,
  Upload,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccidentLinkBanner } from '@/features/accidents/AccidentLinkBanner';
import { isEnabled } from '@/lib/feature-flags';
import {
  SHOP_STAGES,
  SHOP_STAGE_LABEL,
  WORK_ORDER_STATUS_LABEL,
  downtimeMinutes,
  formatDowntime,
  type ShopStage,
  type WorkOrderAction,
  type WorkOrderDetail,
  defaultInvoiceNumber,
} from '@neway/shared';
import {
  Alert,
  BackButton,
  Button,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Modal,
  PageHeader,
  SectionCard,
  Skeleton,
  StatusBadge,
  StatusSymbol,
  Textarea,
  Timeline,
  cn,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { FileDropzone } from './components/FileDropzone';
import { MoveIntoShopDialog } from './components/MoveIntoShopDialog';
import { apiPost } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';
import { downloadFile, uploadFile } from '@/lib/files';
import { DocumentViewer } from '@/features/documents';
import { formatDate, formatDateTime, formatMiles, formatMoney } from '@/lib/format';
import { WORK_ORDER_ACTION_TONE, workOrderActionWord } from './fleet-ui';
import { OTHER_WORK_SYSTEMS } from './pm/board-model';
import { useFleetToday, useWorkOrder, workOrderKey } from './useFleetToday';
import { usePtiDefect } from './pti/api';

/**
 * The walk-around defect this order was opened for: the other end of the link (WP6), with the
 * word on where it stands. Closing the order proposes verification; it does not verify.
 */
function DefectFact({ defectId, unitId }: { defectId: string; unitId: string }) {
  const defect = usePtiDefect(defectId);
  if (defect.isPending) return <span className="text-nw-text-3">Loading…</span>;
  if (!defect.data) return <span className="text-nw-text-3">A defect that could not be read</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <Link
        to="/fleet/trucks/$truckId"
        params={{ truckId: unitId }}
        search={{ tab: 'maintenance' }}
        className="font-semibold text-nw-accent-ink hover:underline"
      >
        {defect.data.defectNumber} · {defect.data.componentName}
      </Link>
      <span className="text-nw-text-3">{defect.data.description}</span>
      <StatusBadge status={defect.data.state} size="sm" className="self-start" />
    </span>
  );
}

/** Reopening a completed record is a fleet manager's call; the server checks the same permission. */
const REOPEN_PERMISSION = 'trucks.edit';

const SYSTEM_LABEL: Record<string, string> = Object.fromEntries([
  ...OTHER_WORK_SYSTEMS.map((s) => [s.value, s.label]),
  ['pm', 'PM / oil change'],
  ['fees', 'Fees'],
]);
const systemLabel = (code: string) => SYSTEM_LABEL[code] ?? code.replace(/_/g, ' ');

export function ShopWorkOrderRoute() {
  const { orderId } = useParams({ from: '/fleet/shop/$orderId' });
  return <ShopWorkOrderPage orderId={orderId} />;
}

/**
 * One work order, as the owner drew it (2026-09-20).
 *
 * A banner says where it stands, four tiles give the numbers, and the record reads top to bottom:
 * what was done, the invoice, and — on a completed record — the one action left, reopening it
 * with a reason. The right column is the record's facts and its read-only history. On an open
 * record the stage board and the close-out form take the place of the reopen card, because those
 * are the things a mechanic does here and nothing else; every press writes a line to the history.
 */
export function ShopWorkOrderPage({ orderId }: { orderId: string }) {
  const query = useWorkOrder(orderId);
  const today = useFleetToday();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const account = useAccount();

  const [note, setNote] = useState('');
  /** Add note (owner, 2026-10-15): open while writing one, its own entry once saved. */
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  /** Upload invoice opens a small form: what it cost, the shop's number, the file. */
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoiceTotal, setInvoiceTotal] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [reason, setReason] = useState('');
  const [workDone, setWorkDone] = useState('');
  const [odometer, setOdometer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // The counter on an open record moves while the page sits open on a bench. Company clock, so a
  // tablet with the wrong time cannot invent an hour of downtime.
  const [clock, setClock] = useState(() => nowMs());
  /*
   * Which invoice the viewer is showing, by id rather than by value: the order is re-read after
   * every write, and holding the object would leave the viewer showing a stale copy of a file
   * that has since been replaced.
   */
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(nowMs()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const order = query.data;
  /* Resolved from the freshly read order, so a replaced file is the one the viewer shows. */
  const viewingInvoice = order?.invoiceFiles.find((f) => f.id === viewingInvoiceId) ?? null;

  async function afterWrite(next: WorkOrderDetail, title: string, description: string) {
    queryClient.setQueryData(workOrderKey(account?.companyId ?? null, orderId), next);
    await queryClient.invalidateQueries({ queryKey: ['fleet'] });
    await queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    void today.refetch();
    setNote('');
    setReason('');
    setError(null);
    toast({ tone: 'success', title, description });
  }

  const changeStage = useMutation({
    mutationFn: (stage: ShopStage) =>
      apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/stage`, {
        stage,
        note: note.trim() || undefined,
      }),
    onSuccess: (next, stage) => afterWrite(next, `Moved to ${SHOP_STAGE_LABEL[stage]}`, next.label),
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That stage could not be saved'),
  });

  const complete = useMutation({
    mutationFn: () =>
      apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/complete`, {
        workDone: workDone.trim(),
        odometer: odometer.trim() === '' ? undefined : Number(odometer),
      }),
    onSuccess: (next) => {
      setWorkDone('');
      setOdometer('');
      if (next.odometerWarning) toast({ tone: 'warning', title: 'Odometer not accepted', description: `${next.odometerWarning}. It is kept as a conflict and not used.` });
      return afterWrite(
        next,
        `${next.number} completed`,
        `Downtime ${formatDowntime(next.downtimeMinutes)}`,
      );
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That work order could not be completed'),
  });

  const reopen = useMutation({
    mutationFn: () =>
      apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/reopen`, {
        note: reason.trim() || undefined,
      }),
    onSuccess: (next) => afterWrite(next, `${next.number} reopened`, next.label),
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That work order could not be reopened'),
  });

  /* Voiding a record entered by mistake - most often a duplicate (owner, 2026-09-30). */
  const [voiding, setVoiding] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const voidOrder = useMutation({
    mutationFn: () =>
      apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/void`, { reason: voidReason.trim() }),
    onSuccess: (next) => {
      setVoiding(false);
      setVoidReason('');
      return afterWrite(next, `${next.number} voided`, 'Kept on record; no longer counted anywhere.');
    },
    onError: (e: unknown) => {
      setVoiding(false);
      setError(e instanceof Error ? e.message : 'That work order could not be voided');
    },
  });

  const attach = useMutation({
    mutationFn: async (input: { file: File; total: number | null; number: string | null }) => {
      const stored = await uploadFile(input.file);
      return apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/invoice`, {
        fileId: stored.id,
        invoiceTotal: input.total,
        invoiceNumber: input.number,
      });
    },
    onSuccess: (next, input) => {
      setInvoiceOpen(false);
      setInvoiceFile(null);
      return afterWrite(next, 'Invoice attached', input.total !== null ? `${input.file.name} · ${formatMoney(input.total)}` : input.file.name);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That invoice could not be attached'),
  });

  const addNote = useMutation({
    mutationFn: (text: string) => apiPost<WorkOrderDetail>(`/fleet/work-orders/${orderId}/note`, { note: text }),
    onSuccess: (next) => {
      setAddingNote(false);
      setNoteText('');
      return afterWrite(next, 'Note added', '');
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'That note could not be saved'),
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (query.isError || !order) {
    return (
      <ErrorState
        title="That work order could not be opened"
        description={query.error instanceof Error ? query.error.message : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const open = order.status === 'in_shop';
  const completed = order.status === 'completed';
  // Frozen minutes on a closed record; counted to the ticking clock on an open one.
  const minutes = open ? downtimeMinutes(order.shopInAt, null, clock) : order.downtimeMinutes;
  const mayReopen =
    account !== null && (account.isOwner || account.permissions.includes(REOPEN_PERMISSION));
  const seesCost = order.invoiceTotal !== undefined;
  const mayEdit =
    account !== null && (account.isOwner || account.permissions.includes('maintenance.edit'));
  const busy = changeStage.isPending || complete.isPending || reopen.isPending || attach.isPending;
  const stageChanges = order.actions.filter((a) => a.action === 'stage_changed');
  const unitLink =
    order.assetType === 'truck' ? (
      <Link
        to="/fleet/trucks/$truckId"
        params={{ truckId: order.unitId }}
        className="font-semibold text-nw-accent-ink hover:underline"
      >
        {order.unitNumber}
      </Link>
    ) : (
      <Link
        to="/fleet/trailers/$trailerId"
        params={{ trailerId: order.unitId }}
        className="font-semibold text-nw-accent-ink hover:underline"
      >
        {order.unitNumber}
      </Link>
    );

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <BackButton fallback="/fleet/maintenance" label="Back" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {order.label}
            <StatusBadge status={order.status} />
          </span>
        }
        description={order.number}
        actions={
          mayEdit && !order.voided ? (
            <span className="flex flex-wrap items-center gap-2">
              {/* A booked order taken into the shop (owner, 2026-10-30): beside Void. */}
              {order.status === 'scheduled' ? (
                <Button variant="primary" onClick={() => setCheckingIn(true)}>
                  In shop
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setVoiding(true)}>
                Void work order
              </Button>
            </span>
          ) : null
        }
      />

      {/* Accident & Claims v2 (SPEC §6.5): an accident repair says which case it is on, or asks for one. Off with the flag. */}
      {isEnabled('accidents_v2') ? <AccidentLinkBanner workOrderId={order.id} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {checkingIn ? (
        <MoveIntoShopDialog
          order={order}
          onClose={() => setCheckingIn(false)}
          onSaved={(next) => {
            setCheckingIn(false);
            void afterWrite(next, `${next.number} is in the shop`, `Unit ${next.unitNumber} is out of dispatch until the work order is completed.`);
          }}
        />
      ) : null}
      {order.voided ? (
        <Alert tone="warning" title={`Voided ${formatDate(order.voided.at)}${order.voided.by ? ` by ${order.voided.by}` : ''}`}>
          {order.voided.reason ?? 'No reason recorded.'} It is kept on record and no longer counted in lists, spend or the dashboard.
        </Alert>
      ) : null}
      <Modal
        open={voiding}
        onOpenChange={(next) => {
          if (!next) setVoiding(false);
        }}
        title={`Void ${order.number}?`}
        description="For a work order entered by mistake, such as a duplicate. Nothing is deleted: the record stays, marked with who, when and why, and stops counting in lists, spend and the dashboard."
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoiding(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={voidOrder.isPending}
              disabled={voidReason.trim().length < 3}
              onClick={() => {
                setError(null);
                voidOrder.mutate();
              }}
            >
              Void work order
            </Button>
          </>
        }
      >
        <FormField label="Reason" required description="For example: Duplicate of RO-2026-1033.">
          <Textarea aria-label="Void reason" rows={2} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
        </FormField>
      </Modal>

      <div className="grid gap-(--section-gap) lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-(--section-gap)">
          {/* The banner: one line on where the record stands. */}
          <section
            aria-label="Where it stands"
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3',
              completed
                ? 'border-success-border bg-success-soft'
                : 'border-info-border bg-info-soft',
            )}
          >
            <StatusSymbol
              family={completed ? 'done' : 'inShop'}
              className={cn('size-7', completed ? 'text-success-text' : 'text-info-text')}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">
                {completed
                  ? 'Repair completed'
                  : order.status === 'scheduled'
                    ? 'Scheduled into a shop'
                    : `In the shop · ${order.shopStage ? SHOP_STAGE_LABEL[order.shopStage] : 'diagnosing'}`}
              </span>
              <span className="block text-xs text-muted">
                {completed
                  ? formatDateTime(order.completedAt ?? order.updatedAt)
                  : order.status === 'scheduled' && order.scheduledFor
                    ? `Booked for ${formatDateTime(order.scheduledFor)}`
                    : `In since ${formatDateTime(order.shopInAt)}`}
              </span>
            </span>
            <button
              type="button"
              className="text-xs font-semibold text-nw-accent-ink hover:underline"
              onClick={() =>
                historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              View stage history
            </button>
          </section>

          {/* Three numbers; Shop in sits with Completed in the details (owner, 2026-10-13). */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label="Status">
              <span className="flex items-center gap-1.5">
                <StatusSymbol
                  family={completed ? 'done' : order.status === 'scheduled' ? 'info' : 'inShop'}
                  className={cn('size-4', completed ? 'text-success-text' : 'text-info-text')}
                />
                {WORK_ORDER_STATUS_LABEL[order.status]}
              </span>
            </Stat>
            <Stat label="Downtime">
              <span className="tabular-nums">{formatDowntime(minutes)}</span>
              {open ? <span className="text-xs font-normal text-muted"> and counting</span> : null}
            </Stat>
            <Stat label="Odometer">
              {order.odometer !== null ? formatMiles(order.odometer) : '—'}
            </Stat>
          </div>

          {open ? (
            /* The stage board: one tap per stage, and every tap is a line in the history. */
            <SectionCard
              icon={<Wrench />}
              title="Where it is now"
              description="Tap the stage it has reached. A note is optional and is kept with it."
            >
              <div className="flex flex-col gap-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  {SHOP_STAGES.map((stage) => {
                    const current = order.shopStage === stage;
                    return (
                      <button
                        key={stage}
                        type="button"
                        disabled={busy}
                        aria-pressed={current}
                        onClick={() => changeStage.mutate(stage)}
                        className={cn(
                          'min-h-11 rounded-lg px-3 py-2 text-left text-sm font-semibold ring-1 transition-colors',
                          current
                            ? 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent'
                            : 'bg-nw-panel text-nw-text-1 ring-nw-border hover:bg-nw-surface',
                          busy && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        {SHOP_STAGE_LABEL[stage]}
                        {current ? (
                          <span className="mt-0.5 block text-xs font-normal text-nw-text-2">
                            Current stage
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <FormField label="Note" description="Optional. Saved with the stage change.">
                  <Input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Waiting on the injector from Fort Worth"
                  />
                </FormField>
              </div>
            </SectionCard>
          ) : null}

          {/* What was done: the lines, then the record's own facts. */}
          <SectionCard icon={<Wrench />} title="What was done" padding="none">
            <div className="flex flex-col">
              {order.lines.length > 0 ? (
                <table className="mx-4 mt-3 text-sm">
                  <thead>
                    <tr className="bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
                      <th className="rounded-l-md px-3 py-2">System</th>
                      <th className={cn('px-3 py-2', !seesCost && 'rounded-r-md')}>
                        Work performed
                      </th>
                      {seesCost ? (
                        <th className="rounded-r-md px-3 py-2 text-right">Amount</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.map((line) => (
                      <tr key={line.id} className="border-b border-nw-border last:border-b-0">
                        <td className="px-3 py-2 text-ink">{systemLabel(line.systemCode)}</td>
                        <td className="px-3 py-2 text-ink">{line.description ?? '—'}</td>
                        {seesCost ? (
                          <td className="px-3 py-2 text-right tabular-nums">
                            {line.amount === null || line.amount === undefined
                              ? '—'
                              : formatMoney(line.amount)}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-4 pt-3 text-sm text-nw-text-1">
                  {order.workDone ?? (open ? 'Nothing written up yet.' : 'No description saved.')}
                </p>
              )}
              <dl className="grid gap-x-6 gap-y-2 border-t border-nw-border px-4 py-3 text-sm sm:grid-cols-2">
                <Fact label="Work order">{order.number}</Fact>
                <Fact label="Unit">{unitLink}</Fact>
                {/* In, then out: Shop in always, Completed right after it once done. */}
                <Fact label="Shop in">{formatDateTime(order.shopInAt)}</Fact>
                {completed ? (
                  <Fact label="Completed">
                    {formatDateTime(order.completedAt ?? order.updatedAt)}
                  </Fact>
                ) : null}
                {order.title ? <Fact label="Title">{order.title}</Fact> : null}
                {order.assignedTo ? <Fact label="Technician">{order.assignedTo}</Fact> : null}
                {order.defectId ? (
                  <Fact label="Opened for">
                    <DefectFact defectId={order.defectId} unitId={order.unitId} />
                  </Fact>
                ) : null}
              </dl>
              {order.notes ? (
                <p className="border-t border-nw-border px-4 py-3 text-sm whitespace-pre-line text-nw-text-2">
                  {order.notes}
                </p>
              ) : null}
              {/* Notes written on the order (owner, 2026-10-15), newest first as the detail reads them, each with who and when. */}
              {order.actions.some((a) => a.action === 'note_added' && a.note) ? (
                <ul className="flex flex-col gap-2 border-t border-nw-border px-4 py-3" aria-label="Notes" data-testid="wo-notes">
                  {order.actions
                    .filter((a) => a.action === 'note_added' && a.note)
                    .map((a) => (
                      <li key={a.id} className="rounded-md border border-nw-border bg-nw-subtle px-3 py-2">
                        <p className="text-sm whitespace-pre-line text-nw-text">{a.note}</p>
                        <p className="mt-0.5 text-xs text-nw-text-3">
                          {a.userName || 'Someone'} · {formatDateTime(a.createdAt)}
                        </p>
                      </li>
                    ))}
                </ul>
              ) : null}
              {order.voided ? null : addingNote ? (
                <div className="flex flex-col gap-2 border-t border-nw-border px-4 py-3">
                  <Textarea
                    rows={3}
                    autoFocus
                    aria-label="Note"
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="Waiting on the injector from Fort Worth; shop expects it Friday."
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => { setAddingNote(false); setNoteText(''); }}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" loading={addNote.isPending} disabled={noteText.trim() === ''} onClick={() => addNote.mutate(noteText.trim())} data-testid="wo-note-save">
                      Save note
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="border-t border-nw-border px-4 py-2.5">
                  <Button size="sm" variant="outline" icon={<MessageSquarePlus />} onClick={() => setAddingNote(true)} data-testid="wo-add-note">
                    Add note
                  </Button>
                </div>
              )}
            </div>
          </SectionCard>

          {open ? (
            <SectionCard
              icon={<CheckCircle2 />}
              title="Close it out"
              description="What was done is required. Completing it stops the downtime clock and resets the service the work type belongs to."
            >
              <div className="flex flex-col gap-4">
                <FormField label="What was done" required>
                  <Textarea
                    rows={4}
                    value={workDone}
                    onChange={(event) => setWorkDone(event.target.value)}
                    placeholder="Oil and both filters. Greased, checked the air dryer, no leaks on the road test."
                  />
                </FormField>
                {order.assetType === 'truck' ? (
                  <FormField
                    label="Odometer out"
                    description={
                      order.odometer !== null
                        ? `In at ${formatMiles(order.odometer)}`
                        : 'Optional. Used as the service baseline.'
                    }
                  >
                    <Input
                      inputMode="numeric"
                      prefix={<Gauge />}
                      value={odometer}
                      onChange={(event) => setOdometer(event.target.value)}
                      placeholder="0"
                    />
                  </FormField>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<CheckCircle2 />}
                    loading={complete.isPending}
                    disabled={workDone.trim() === '' || busy}
                    onClick={() => {
                      setError(null);
                      complete.mutate();
                    }}
                  >
                    Complete
                  </Button>
                  {workDone.trim() === '' ? (
                    <span className="text-xs text-nw-urgent-text">
                      Say what was done before completing it.
                    </span>
                  ) : null}
                </div>
              </div>
            </SectionCard>
          ) : null}

          {/* The invoice: the file, and the three facts on it. */}
          <SectionCard
            icon={<FileText />}
            title="Invoice"
            padding="none"
            actions={
              <>
                <Button
                  size="sm"
                  variant="link"
                  icon={<Upload />}
                  loading={attach.isPending}
                  disabled={busy}
                  onClick={() => {
                    setInvoiceFile(null);
                    setInvoiceTotal(order.invoiceTotal !== null && order.invoiceTotal !== undefined ? String(order.invoiceTotal) : '');
                    setInvoiceNo(order.invoiceNumber ?? '');
                    setInvoiceOpen(true);
                  }}
                  data-testid="wo-upload-invoice"
                >
                  Upload invoice
                </Button>
              </>
            }
          >
            <div className="flex flex-col">
              {order.invoiceFiles.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted">
                  {completed
                    ? 'No invoice on the record — it is listed for review until one is attached.'
                    : 'No invoice yet.'}
                </p>
              ) : (
                <ul className="flex flex-col gap-2 px-4 py-3">
                  {order.invoiceFiles.map((file) => (
                    <li
                      key={file.id}
                      className="flex items-center gap-3 rounded-md border border-nw-border bg-nw-panel px-3 py-2"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger-text">
                        <FileText aria-hidden className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {file.fileName}
                        </span>
                        <span className="block text-xs text-muted">
                          {file.contentType.split('/')[1]?.toUpperCase() ?? 'File'} ·{' '}
                          {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setViewingInvoiceId(file.id)}
                      >
                        View invoice
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Download />}
                        aria-label={`Download ${file.fileName}`}
                        onClick={() =>
                          downloadFile(
                            { fileUrl: file.url, fileName: file.fileName },
                            file.fileName,
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
              <dl className="grid divide-nw-border border-t border-nw-border text-sm sm:grid-cols-3 sm:divide-x">
                <div className="px-4 py-3">
                  <dt className="text-xs text-nw-text-3">Invoice number</dt>
                  {/* Records saved before the number was given on save show the one they would have got. */}
                  <dd className="mt-0.5 text-ink">
                    {order.invoiceNumber ?? defaultInvoiceNumber(order.number)}
                  </dd>
                </div>
                <div className="px-4 py-3">
                  <dt className="text-xs text-nw-text-3">Shop / vendor</dt>
                  <dd className="mt-0.5 text-ink">{order.vendorName || '—'}</dd>
                </div>
                <div className="px-4 py-3">
                  <dt className="text-xs text-nw-text-3">Invoice total</dt>
                  <dd className="mt-0.5 text-ink tabular-nums">
                    {!seesCost
                      ? 'Not shown'
                      : order.invoiceTotal === null || order.invoiceTotal === undefined
                        ? '—'
                        : formatMoney(order.invoiceTotal)}
                  </dd>
                </div>
              </dl>
            </div>
          </SectionCard>

          {completed ? (
            <SectionCard
              icon={<RotateCcw />}
              title="Reopen repair"
              description="Reopen this record if the issue returns."
            >
              {mayReopen ? (
                <div className="flex flex-col gap-3">
                  <FormField
                    label="Reason"
                    required
                    description="Your reason and name will be saved in the activity history."
                  >
                    <Textarea
                      rows={2}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Describe why this repair needs to be reopened…"
                    />
                  </FormField>
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      loading={reopen.isPending}
                      disabled={busy || reason.trim() === ''}
                      onClick={() => {
                        setError(null);
                        reopen.mutate();
                      }}
                    >
                      Reopen repair
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-nw-text-3">
                  Reopening a completed work order is a fleet manager's action.
                </p>
              )}
            </SectionCard>
          ) : null}
        </div>

        <div className="flex flex-col gap-(--section-gap)">
          <SectionCard icon={<FileText />} title="Record details" padding="none">
            <dl className="flex flex-col divide-y divide-nw-border text-sm">
              <Row label="Unit">{unitLink}</Row>
              <Row label="Created by">{order.createdBy || 'Unknown'}</Row>
              <Row label="Created on">{formatDate(order.createdAt)}</Row>
              {order.vendorName ? <Row label="Shop">{order.vendorName}</Row> : null}
              {order.assignedTo ? <Row label="Technician">{order.assignedTo}</Row> : null}
            </dl>
          </SectionCard>

          <div ref={historyRef} className="scroll-mt-4">
            <SectionCard
              icon={<Clock />}
              title="Activity"
              description="Read-only history."
              padding="sm"
            >
              {order.actions.length === 0 ? (
                <EmptyState size="sm" title="No entries yet" />
              ) : (
                <div className="flex flex-col gap-3">
                  <Timeline dense items={order.actions.map(timelineItem)} />
                  {stageChanges.length === 0 ? (
                    <p className="rounded-md bg-nw-subtle px-3 py-2.5 text-xs text-muted">
                      No stage changes recorded.
                    </p>
                  ) : null}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      </div>

      {/* Upload invoice (owner, 2026-10-15): what it cost, the shop's number and the file, in one go. */}
      {invoiceOpen ? (
        <Modal
          open
          onOpenChange={(o) => {
            if (!o && !attach.isPending) setInvoiceOpen(false);
          }}
          size="md"
          title="Upload invoice"
          description={`${order.number} · ${order.unitNumber}`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setInvoiceOpen(false)} disabled={attach.isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<Upload />}
                loading={attach.isPending}
                disabled={!invoiceFile || (invoiceTotal.trim() !== '' && !Number.isFinite(Number(invoiceTotal.replace(/[$,\s]/g, ''))))}
                onClick={() => {
                  if (!invoiceFile) return;
                  const t = invoiceTotal.trim() === '' ? null : Math.round(Number(invoiceTotal.replace(/[$,\s]/g, '')) * 100) / 100;
                  setError(null);
                  attach.mutate({ file: invoiceFile, total: t, number: invoiceNo.trim() || null });
                }}
                data-testid="wo-invoice-save"
              >
                Upload
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="How much it cost ($)" description="The invoice total, as the shop charged it.">
                <Input inputMode="decimal" aria-label="Invoice total" value={invoiceTotal} onChange={(event) => setInvoiceTotal(event.target.value)} placeholder="0.00" />
              </FormField>
              <FormField label="Shop invoice #">
                <Input aria-label="Shop invoice number" value={invoiceNo} onChange={(event) => setInvoiceNo(event.target.value)} placeholder={defaultInvoiceNumber(order.number)} />
              </FormField>
            </div>
            <FileDropzone
              title="Invoice *"
              subtitle="The shop's invoice · PDF or photo"
              hint="Photos are made smaller before they upload."
              actionLabel="Browse files"
              file={invoiceFile}
              onFile={setInvoiceFile}
            />
            {attach.error ? <Alert tone="danger" title="Not uploaded">{attach.error instanceof Error ? attach.error.message : 'Try again.'}</Alert> : null}
          </div>
        </Modal>
      ) : null}

      {/*
       * The invoice opens here, on the repair, rather than in a second tab. Leaving the page to
       * read the bill and coming back to type what it says is how a number gets mistyped — and
       * the bytes are behind the session, so a plain link could not have carried them anyway.
       */}
      {viewingInvoice ? (
        <DocumentViewer
          source={{ kind: 'file', file: { fileUrl: viewingInvoice.url, fileName: viewingInvoice.fileName } }}
          title={viewingInvoice.fileName}
          subtitle={`${order.number}${order.vendorName ? ` · ${order.vendorName}` : ''}`}
          contentType={viewingInvoice.contentType}
          fileName={viewingInvoice.fileName}
          onClose={() => setViewingInvoiceId(null)}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
      <span className="block text-xs text-nw-text-3">{label}</span>
      <span className="mt-1 block text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-24 shrink-0 text-xs text-nw-text-3">{label}</dt>
      <dd className="min-w-0 text-nw-text-1">{children}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <dt className="text-xs text-nw-text-3">{label}</dt>
      <dd className="text-right text-nw-text-1">{children}</dd>
    </div>
  );
}

function timelineItem(action: WorkOrderAction): TimelineItem {
  return {
    id: action.id,
    at: action.createdAt,
    tone: WORK_ORDER_ACTION_TONE[action.action],
    title: action.stage
      ? SHOP_STAGE_LABEL[action.stage]
      : action.action === 'completed'
        ? 'Recorded as completed'
        : workOrderActionWord(action.action),
    description: action.note ?? undefined,
    actor: { name: action.userName },
  };
}

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ExternalLink, FileText, Lock, MapPin, Paperclip, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EFS_STATUSES,
  EFS_STATUS_LABEL,
  FLEET_EXPENSE_CATEGORIES,
  FLEET_EXPENSE_CATEGORY_LABEL,
  FLEET_EXPENSE_NOTES_MAX,
  FLEET_EXPENSE_OUTCOME_LABEL,
  FLEET_PAYMENT_METHODS,
  FLEET_PAYMENT_METHOD_LABEL,
  SaveFleetExpenseSchema,
  expenseOutcome,
  locationRule,
  maskEfsCode,
  validateFleetExpense,
  type EfsStatus,
  type FleetExpenseCategory,
  type FleetExpenseChargeTo,
  type FleetExpenseDetail,
  type FleetExpensePayer,
  type FleetExpenseProblem,
  type FleetPaymentMethod,
  type SaveFleetExpenseInput,
} from '@neway/shared';
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  DatePicker,
  FormField,
  IconButton,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { parseMoney } from '@/lib/format';
import { uploadFile, type StoredFile } from '@/lib/files';
import {
  checkDuplicate,
  duplicatesOf,
  errorText,
  problemsOf,
  useAttachFile,
  useExpenseOptions,
  useSaveExpense,
  type DuplicateMatch,
  type FileKind,
} from './api';
import { centsToField, fullAddress, mapHref, money } from './expense-format';

/**
 * Add (or edit) one fleet expense, on one screen.
 *
 * The owner's rule (2026-10-12): a simple parking receipt is not an eight-step wizard. The
 * groups are there - Expense, Location, Payment and charge, EFS, Documents, Review - but a group
 * only opens when the answers above it make it matter: Location for parking and washes (or on
 * request), EFS only when EFS paid it, the driver charge only when a driver bears the cost.
 *
 * The rules are the shared `validateFleetExpense`, run here for inline errors and again on the
 * server. A refused save keeps every typed value and shows the server's words beside the field.
 */
interface FormState {
  truckId: string;
  category: FleetExpenseCategory | '';
  expenseDate: string;
  amount: string;
  vendorId: string | null;
  vendorName: string;
  invoiceNumber: string;
  description: string;
  notes: string;
  placeName: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  paidBy: FleetExpensePayer;
  payerDriverId: string;
  payerName: string;
  paymentMethod: FleetPaymentMethod | '';
  paid: boolean;
  paymentReference: string;
  chargeTo: FleetExpenseChargeTo;
  chargeDriverId: string;
  chargeAmount: string;
  chargeReason: string;
  deductFromSettlement: boolean;
  efsCode: string;
  efsIssuedOn: string;
  efsIssued: string;
  efsUsed: string;
  efsStatus: EfsStatus;
  efsReceiptFileId: string | null;
  notDuplicateOf: string | null;
}

interface PendingFile {
  file: StoredFile;
  kind: FileKind;
}

function blankState(truckId: string, today: string): FormState {
  return {
    truckId,
    category: '',
    expenseDate: today,
    amount: '',
    vendorId: null,
    vendorName: '',
    invoiceNumber: '',
    description: '',
    notes: '',
    placeName: '',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    paidBy: 'company',
    payerDriverId: '',
    payerName: '',
    paymentMethod: 'card',
    paid: true,
    paymentReference: '',
    chargeTo: 'company',
    chargeDriverId: '',
    chargeAmount: '',
    chargeReason: '',
    deductFromSettlement: true,
    efsCode: '',
    efsIssuedOn: today,
    efsIssued: '',
    efsUsed: '',
    efsStatus: 'used',
    efsReceiptFileId: null,
    notDuplicateOf: null,
  };
}

function stateOf(d: FleetExpenseDetail): FormState {
  return {
    truckId: d.truckId,
    category: d.category,
    expenseDate: d.expenseDate,
    amount: centsToField(d.amountCents),
    vendorId: d.vendorId,
    vendorName: d.vendorName ?? '',
    invoiceNumber: d.invoiceNumber ?? '',
    description: d.description ?? '',
    notes: d.notes ?? '',
    placeName: d.placeName ?? '',
    address: d.address ?? '',
    city: d.city ?? '',
    state: d.state ?? '',
    postalCode: d.postalCode ?? '',
    paidBy: d.paidBy,
    payerDriverId: d.payerDriverId ?? '',
    payerName: d.payerName ?? '',
    paymentMethod: d.paymentMethod ?? '',
    paid: d.paid,
    paymentReference: d.paymentReference ?? '',
    chargeTo: d.chargeTo,
    chargeDriverId: d.chargeDriverId ?? '',
    chargeAmount: centsToField(d.chargeCents),
    chargeReason: d.chargeReason ?? '',
    deductFromSettlement: d.deductFromSettlement,
    // The full code never comes back; empty here means "keep the one on file".
    efsCode: '',
    efsIssuedOn: d.efs?.issuedOn ?? d.expenseDate,
    efsIssued: centsToField(d.efs?.issuedCents),
    efsUsed: centsToField(d.efs?.usedCents),
    efsStatus: d.efs?.status ?? 'used',
    efsReceiptFileId: d.efs?.receiptFileId ?? null,
    notDuplicateOf: null,
  };
}

const toCents = (text: string): number | null => {
  const value = parseMoney(text);
  return value === null ? null : Math.round(value * 100);
};
const orNull = (text: string): string | null => (text.trim() ? text.trim() : null);

/** The form as the API takes it; `amountProblem` when the amount could not be read. */
function bodyOf(s: FormState, status: 'draft' | 'recorded', expectedVersion?: number): { body: SaveFleetExpenseInput; unreadable: FleetExpenseProblem[] } {
  const unreadable: FleetExpenseProblem[] = [];
  const efs = s.paymentMethod === 'efs';
  const usedCents = toCents(s.efsUsed);
  let amountCents = efs ? usedCents : toCents(s.amount);
  if (amountCents === null) {
    if (status === 'recorded' || (efs ? s.efsUsed : s.amount).trim()) {
      unreadable.push({ field: efs ? 'efs.usedCents' : 'amountCents', message: 'Enter the amount, like 150.00.' });
    }
    amountCents = 0;
  }
  const charged = s.paidBy === 'company' && s.chargeTo === 'driver';
  // Under investigation keeps the driver in question, when one is named; nothing is deducted.
  const questioned = s.paidBy === 'company' && s.chargeTo === 'investigation' && Boolean(s.chargeDriverId);
  const chargeCents = toCents(s.chargeAmount) ?? amountCents;
  return {
    unreadable,
    body: {
      status,
      truckId: s.truckId,
      category: (s.category || 'other') as FleetExpenseCategory,
      expenseDate: s.expenseDate,
      amountCents,
      vendorId: s.vendorId,
      vendorName: orNull(s.vendorName),
      invoiceNumber: orNull(s.invoiceNumber),
      description: orNull(s.description),
      notes: orNull(s.notes),
      location: {
        placeName: orNull(s.placeName),
        address: orNull(s.address),
        city: orNull(s.city),
        state: orNull(s.state),
        postalCode: orNull(s.postalCode),
      },
      paidBy: s.paidBy,
      payerDriverId: s.paidBy === 'driver' ? orNull(s.payerDriverId) : null,
      payerName: s.paidBy === 'owner' ? orNull(s.payerName) : null,
      paymentMethod: s.paymentMethod || null,
      paid: s.paidBy === 'company' ? (efs ? true : s.paid) : true,
      paymentReference: orNull(s.paymentReference),
      chargeTo: s.chargeTo,
      charge: charged
        ? {
            driverId: s.chargeDriverId,
            amountCents: chargeCents,
            reason: s.chargeReason.trim(),
            deductFromSettlement: s.deductFromSettlement,
          }
        : questioned
          ? { driverId: s.chargeDriverId, amountCents: chargeCents, reason: s.chargeReason.trim() || 'Under investigation', deductFromSettlement: false }
          : null,
      efs: efs
        ? {
            code: orNull(s.efsCode),
            issuedOn: orNull(s.efsIssuedOn),
            issuedCents: toCents(s.efsIssued),
            usedCents,
            status: s.efsStatus,
            receiptFileId: s.efsReceiptFileId,
          }
        : null,
      notDuplicateOf: s.notDuplicateOf,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

/** Every rule the save will be held to, in field order, before anything is sent. */
function checkLocally(s: FormState, status: 'draft' | 'recorded'): FleetExpenseProblem[] {
  const { body, unreadable } = bodyOf(s, status);
  const out = [...unreadable];
  if (!s.category) out.push({ field: 'category', message: 'Choose the category.' });
  if (s.paidBy === 'company' && s.chargeTo === 'driver') {
    if (!s.chargeDriverId) out.push({ field: 'charge.driverId', message: 'Choose the driver the charge is for.' });
    if (s.chargeReason.trim().length < 3) out.push({ field: 'charge.reason', message: 'Say why the driver bears this cost.' });
    if (s.chargeAmount.trim() && toCents(s.chargeAmount) === null) out.push({ field: 'charge.amountCents', message: 'Enter the charge, like 100.00.' });
  }
  if (status === 'recorded' && s.paidBy === 'company' && s.paymentMethod !== 'efs' && !s.paid && !s.vendorId && !s.vendorName.trim()) {
    out.push({ field: 'vendorName', message: 'An unpaid expense becomes a vendor bill: enter the vendor.' });
  }
  const parsed = SaveFleetExpenseSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.');
      // The checks above already say these in plainer words.
      if (['truckId', 'category', 'charge.driverId', 'charge.reason', 'charge.amountCents', 'charge'].includes(field)) continue;
      out.push({ field, message: issue.message });
    }
    return dedupe(out);
  }
  return dedupe([...out, ...validateFleetExpense(parsed.data)]);
}

function dedupe(list: FleetExpenseProblem[]): FleetExpenseProblem[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = `${p.field}|${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The fields this form draws an error under; anything else is listed at the top. */
const KNOWN_FIELDS = new Set([
  'truckId', 'category', 'expenseDate', 'amountCents', 'vendorName', 'vendorId', 'invoiceNumber', 'description', 'notes',
  'location.placeName', 'location.address', 'location.city', 'location.state', 'location.postalCode',
  'paidBy', 'payerDriverId', 'payerName', 'paymentMethod', 'paymentReference', 'chargeTo',
  'charge', 'charge.driverId', 'charge.amountCents', 'charge.reason',
  'efs', 'efs.code', 'efs.issuedOn', 'efs.issuedCents', 'efs.usedCents', 'efs.status',
]);

export interface ExpenseFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this expense; absent = a new one. */
  expense?: FleetExpenseDetail | null;
  /** Opened from a truck profile: the truck is chosen and cannot be changed. */
  lockedTruckId?: string;
  onSaved?: (detail: FleetExpenseDetail) => void;
}

export function ExpenseFormDialog(props: ExpenseFormDialogProps) {
  // A fresh form every time it opens: no values from the last expense linger.
  return props.open ? <ExpenseForm {...props} /> : <Modal open={false} onOpenChange={props.onOpenChange} title="Add expense" />;
}

function ExpenseForm({ open, onOpenChange, expense, lockedTruckId, onSaved }: ExpenseFormDialogProps) {
  const { toast } = useToast();
  const options = useExpenseOptions();
  const save = useSaveExpense();
  const attach = useAttachFile();
  const today = companyToday();
  const editing = Boolean(expense);

  const [s, setS] = useState<FormState>(() =>
    expense ? stateOf(expense) : blankState(lockedTruckId ?? '', today),
  );
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const [problems, setProblems] = useState<FleetExpenseProblem[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverDuplicates, setServerDuplicates] = useState<DuplicateMatch[]>([]);
  const [showLocation, setShowLocation] = useState(() => Boolean(expense && (expense.placeName || expense.address || expense.city)));
  const [showMore, setShowMore] = useState(() => Boolean(expense && (expense.notes || expense.description)));
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [efsReceiptName, setEfsReceiptName] = useState<string | null>(expense?.efs?.receiptFileId ? 'EFS receipt on file' : null);

  const opts = options.data;
  const efs = s.paymentMethod === 'efs';
  const rule = s.category ? locationRule(s.category) : 'optional';
  const locationOpen = rule !== 'optional' || showLocation;
  const charged = s.paidBy === 'company' && s.chargeTo === 'driver';
  const outcome = expenseOutcome(s.paidBy, s.chargeTo);

  const errorFor = (field: string): string | undefined => problems.find((p) => p.field === field)?.message;
  const otherProblems = problems.filter((p) => !KNOWN_FIELDS.has(p.field));

  // A manual repair may already be a work order in Maintenance: ask the server, show the match.
  const amountCents = toCents(efs ? s.efsUsed : s.amount);
  const dupParams =
    s.category === 'repair_maintenance' && s.truckId && amountCents && amountCents > 0
      ? { truckId: s.truckId, category: s.category, amountCents, expenseDate: s.expenseDate, invoiceNumber: orNull(s.invoiceNumber) }
      : null;
  const dupQuery = useQuery({
    queryKey: ['fleet', 'expenses', 'duplicate-check', dupParams],
    queryFn: () => checkDuplicate(dupParams!),
    enabled: dupParams !== null,
    staleTime: 30_000,
  });
  const duplicates = useMemo(() => {
    const all = [...(dupQuery.data?.matches ?? []), ...serverDuplicates];
    return all.filter((m, i) => all.findIndex((o) => o.workOrderId === m.workOrderId) === i);
  }, [dupQuery.data, serverDuplicates]);

  function setPaidBy(next: FleetExpensePayer) {
    setS((prev) => ({
      ...prev,
      paidBy: next,
      // Owner-paid is the owner's own cost; anyone else's cost is never "charged to owner".
      chargeTo: next === 'owner' ? 'owner' : prev.chargeTo === 'owner' || (prev.chargeTo === 'investigation' && next !== 'company') ? 'company' : prev.chargeTo,
      paymentMethod: next !== 'company' && prev.paymentMethod === 'efs' ? '' : prev.paymentMethod,
    }));
  }

  async function addFiles(list: FileList | null, kind: FileKind) {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const stored = await uploadFile(file);
        if (kind === 'efs_receipt') {
          set('efsReceiptFileId', stored.id);
          setEfsReceiptName(stored.fileName);
        } else {
          setPending((prev) => [...prev, { file: stored, kind }]);
        }
      }
    } catch (error) {
      toast({ tone: 'danger', title: 'The file was not uploaded', description: errorText(error) });
    } finally {
      setUploading(false);
    }
  }

  async function submit(status: 'draft' | 'recorded') {
    setServerError(null);
    const local = checkLocally(s, status);
    // A draft needs only the category; the rest can wait.
    const blocking = status === 'draft' ? local.filter((p) => p.field === 'category') : local;
    setProblems(local);
    if (blocking.length > 0) return;
    if (status === 'recorded' && duplicates.length > 0 && !s.notDuplicateOf) {
      setProblems([{ field: 'duplicate', message: 'This looks like a repair already in Maintenance. Open it, or tick “This is a different cost”.' }]);
      return;
    }
    const { body } = bodyOf(s, status, expense?.version);
    try {
      const detail = await save.mutateAsync({ id: expense?.id ?? null, body });
      // Receipts chosen before the expense existed are attached now, one by one.
      const failed: string[] = [];
      for (const p of pending) {
        try {
          await attach.mutateAsync({ id: detail.id, fileId: p.file.id, kind: p.kind });
        } catch {
          failed.push(p.file.fileName);
        }
      }
      toast({
        tone: failed.length ? 'warning' : 'success',
        title: status === 'draft' ? `Draft ${detail.reference} saved` : `${detail.reference} saved`,
        description: failed.length
          ? `Saved, but ${failed.join(', ')} could not be attached. Add ${failed.length === 1 ? 'it' : 'them'} from the expense.`
          : status === 'draft'
            ? 'A draft is not counted as spend until it is saved as an expense.'
            : FLEET_EXPENSE_OUTCOME_LABEL[detail.outcome],
      });
      onSaved?.(detail);
      onOpenChange(false);
    } catch (error) {
      const dups = duplicatesOf(error);
      if (dups.length > 0) {
        setServerDuplicates(dups);
        setProblems([{ field: 'duplicate', message: 'This looks like a repair already in Maintenance. Open it, or tick “This is a different cost”.' }]);
        return;
      }
      setProblems(problemsOf(error));
      // A stale save says so in its own words (someone else saved first); every value stays typed.
      setServerError(errorText(error));
    }
  }

  const truckOptions = (opts?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.unitNumber}` }));
  const driverOptions = (opts?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }));
  const vendorOptions = [
    ...(opts?.vendors ?? []).map((v) => ({ value: v.id, label: v.name })),
    ...(s.vendorId === null && s.vendorName.trim() ? [{ value: '__typed__', label: s.vendorName.trim() }] : []),
  ];
  const lockedUnit = opts?.trucks.find((t) => t.id === s.truckId)?.unitNumber;
  const address = fullAddress(s);
  const issued = toCents(s.efsIssued);
  const used = toCents(s.efsUsed);
  const chargeShown = toCents(s.chargeAmount) ?? amountCents ?? 0;
  const busy = save.isPending || attach.isPending || uploading;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      size="lg"
      title={editing ? `Edit ${expense!.reference}` : 'Add expense'}
      description="One cost on one truck: what it was, who paid it and who bears it."
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {!editing || expense?.status === 'draft' ? (
            <Button variant="outline" onClick={() => void submit('draft')} loading={save.isPending} disabled={busy}>
              Save draft
            </Button>
          ) : null}
          <Button onClick={() => void submit('recorded')} loading={save.isPending} disabled={busy}>
            Save expense
          </Button>
        </div>
      }
    >
      {options.isError ? (
        <Alert tone="danger" title="The form could not load its lists" description={errorText(options.error)} actions={<Button size="sm" variant="outline" onClick={() => void options.refetch()}>Retry</Button>} />
      ) : !opts ? (
        <p className="py-10 text-center text-sm text-nw-text-3">Loading…</p>
      ) : (
        <div className="flex flex-col gap-7 pt-1">
          {serverError || otherProblems.length > 0 ? (
            <Alert tone="danger" title="Nothing was saved yet" description={
              <span className="flex flex-col gap-1">
                {serverError ? <span>{serverError}</span> : null}
                {otherProblems.filter((p) => p.field !== 'duplicate').map((p) => <span key={p.field + p.message}>{p.message}</span>)}
              </span>
            } />
          ) : null}

          {/* ------------------------------------------------------------ Expense */}
          <Group title="Expense">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Truck" error={errorFor('truckId')} description="Optional. Leave it empty when the cost is not for one truck.">
                {lockedTruckId ? (
                  <div className="flex h-(--control-height-md) items-center gap-2 rounded-md border border-nw-border bg-nw-subtle px-3 text-sm text-nw-text">
                    <Lock aria-hidden className="size-3.5 text-nw-text-3" />
                    Unit {lockedUnit ?? '…'}
                  </div>
                ) : (
                  <Combobox
                    options={truckOptions}
                    value={s.truckId || null}
                    onValueChange={(v) => set('truckId', v ?? '')}
                    placeholder="No truck"
                    searchPlaceholder="Unit number…"
                    invalid={Boolean(errorFor('truckId'))}
                  />
                )}
              </FormField>
              <FormField label="Category" required error={errorFor('category')}>
                <Select
                  options={FLEET_EXPENSE_CATEGORIES.map((c) => ({ value: c, label: FLEET_EXPENSE_CATEGORY_LABEL[c] }))}
                  value={s.category}
                  onValueChange={(v) => set('category', v as FleetExpenseCategory)}
                  placeholder="Choose a category"
                  invalid={Boolean(errorFor('category'))}
                />
              </FormField>
              <FormField label="Expense date" required error={errorFor('expenseDate')}>
                <DatePicker value={s.expenseDate} onIsoChange={(iso) => set('expenseDate', iso || today)} />
              </FormField>
              <FormField
                label="Amount"
                required
                error={errorFor('amountCents')}
                description={efs ? 'For EFS the amount is what was actually used (below).' : undefined}
              >
                <Input
                  inputMode="decimal"
                  prefix="$"
                  placeholder="0.00"
                  // EFS: the amount is what was actually used, so it follows the Used field.
                  value={efs ? s.efsUsed : s.amount}
                  readOnly={efs}
                  onChange={(e) => set('amount', e.target.value)}
                />
              </FormField>
              <FormField
                label="Vendor / payee"
                required={s.paidBy === 'company' && !efs && !s.paid}
                error={errorFor('vendorName') ?? errorFor('vendorId')}
                description={s.paidBy === 'company' && !efs && !s.paid ? 'Unpaid: Accounting gets one bill for this vendor.' : 'Pick a vendor, or type a name.'}
              >
                <Combobox
                  options={vendorOptions}
                  value={s.vendorId ?? (s.vendorName.trim() ? '__typed__' : null)}
                  onValueChange={(v) => {
                    if (v === null) setS((p) => ({ ...p, vendorId: null, vendorName: '' }));
                    else if (v !== '__typed__') setS((p) => ({ ...p, vendorId: v, vendorName: opts.vendors.find((x) => x.id === v)?.name ?? '' }));
                  }}
                  onCreate={(q) => setS((p) => ({ ...p, vendorId: null, vendorName: q }))}
                  createLabel={(q) => `Use “${q}”`}
                  placeholder="Optional"
                  searchPlaceholder="Vendor name…"
                />
              </FormField>
              <FormField label="Invoice #" error={errorFor('invoiceNumber')}>
                <Input value={s.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} placeholder="Optional" />
              </FormField>
            </div>

            {duplicates.length > 0 ? (
              <Alert
                tone="warning"
                title="This looks like a repair already in Maintenance"
                description={
                  <span className="flex flex-col gap-2">
                    {duplicates.map((m) => (
                      <span key={m.workOrderId}>
                        <Link to="/fleet/maintenance/$orderId" params={{ orderId: m.workOrderId }} target="_blank" className="font-semibold text-nw-accent-ink hover:underline">
                          {m.roNumber} <ExternalLink aria-hidden className="inline size-3" />
                        </Link>{' '}
                        · {money(m.amountCents)} · {m.date}
                        {m.vendorName ? ` · ${m.vendorName}` : ''} — open it rather than entering the repair twice.
                      </span>
                    ))}
                    <Checkbox
                      label="This is a different cost"
                      checked={s.notDuplicateOf !== null}
                      onCheckedChange={(v) => set('notDuplicateOf', v === true ? duplicates[0]!.workOrderId : null)}
                    />
                    {errorFor('duplicate') ? <span className="font-semibold text-nw-urgent-text">{errorFor('duplicate')}</span> : null}
                  </span>
                }
              />
            ) : null}

            {showMore ? (
              <div className="grid gap-4">
                <FormField label="Description" error={errorFor('description')}>
                  <Input value={s.description} maxLength={300} onChange={(e) => set('description', e.target.value)} placeholder="What it was for" />
                </FormField>
                <FormField
                  label="Notes"
                  error={errorFor('notes')}
                  description={`${s.notes.length.toLocaleString('en-US')} of ${FLEET_EXPENSE_NOTES_MAX.toLocaleString('en-US')} characters`}
                >
                  <Textarea rows={5} value={s.notes} maxLength={FLEET_EXPENSE_NOTES_MAX} onChange={(e) => set('notes', e.target.value)} />
                </FormField>
              </div>
            ) : (
              <Disclose onClick={() => setShowMore(true)}>Add description or notes</Disclose>
            )}
          </Group>

          {/* ------------------------------------------------------------ Location */}
          <Group title="Location" hint={rule === 'required' ? 'Parking needs the parking name and where it is.' : undefined}>
            {locationOpen ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label={s.category === 'parking' ? 'Parking name' : s.category === 'truck_wash' ? 'Wash name' : 'Place name'}
                  required={rule === 'required'}
                  error={errorFor('location.placeName')}
                >
                  <Input value={s.placeName} onChange={(e) => set('placeName', e.target.value)} placeholder={s.category === 'parking' ? 'Lot A Truck Parking' : 'Optional'} />
                </FormField>
                <FormField label="Address" required={rule === 'required'} error={errorFor('location.address')}>
                  <Input value={s.address} onChange={(e) => set('address', e.target.value)} placeholder="Street address" />
                </FormField>
                <FormField label="City" error={errorFor('location.city')}>
                  <Input value={s.city} onChange={(e) => set('city', e.target.value)} />
                </FormField>
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="State" error={errorFor('location.state')}>
                    <Input value={s.state} maxLength={40} onChange={(e) => set('state', e.target.value)} placeholder="TX" />
                  </FormField>
                  <FormField label="ZIP" error={errorFor('location.postalCode')}>
                    <Input value={s.postalCode} maxLength={20} inputMode="numeric" onChange={(e) => set('postalCode', e.target.value)} />
                  </FormField>
                </div>
                {address ? (
                  <a href={mapHref(address)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-nw-accent-ink hover:underline sm:col-span-2">
                    <MapPin aria-hidden className="size-3.5" /> Open map
                  </a>
                ) : null}
              </div>
            ) : (
              <Disclose onClick={() => setShowLocation(true)}>Add a location</Disclose>
            )}
          </Group>

          {/* ------------------------------------------------------------ Payment and charge */}
          <Group title="Payment and charge" hint="Paid by is who funded it; Charge to is who bears it in the end.">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Paid by" required error={errorFor('paidBy')}>
                <Segments
                  label="Paid by"
                  value={s.paidBy}
                  options={[{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }, { value: 'owner', label: 'Vendor' }]}
                  onChange={(v) => setPaidBy(v as FleetExpensePayer)}
                />
              </FormField>
              {s.paidBy === 'driver' ? (
                <FormField label="Which driver paid" required error={errorFor('payerDriverId')}>
                  <Combobox options={driverOptions} value={s.payerDriverId || null} onValueChange={(v) => set('payerDriverId', v ?? '')} placeholder="Choose the driver" searchPlaceholder="Driver name…" />
                </FormField>
              ) : s.paidBy === 'owner' ? (
                <FormField label="Vendor" error={errorFor('payerName')} description="The truck’s vendor - the person whose own truck it is.">
                  <Input value={s.payerName} onChange={(e) => set('payerName', e.target.value)} placeholder="Vendor name" />
                </FormField>
              ) : (
                <div className="hidden sm:block" />
              )}
              <FormField label="Payment method" error={errorFor('paymentMethod')}>
                <Select
                  options={[
                    { value: '', label: 'Not recorded' },
                    ...FLEET_PAYMENT_METHODS.filter((m) => m !== 'efs' || s.paidBy === 'company').map((m) => ({ value: m, label: FLEET_PAYMENT_METHOD_LABEL[m] })),
                  ]}
                  value={s.paymentMethod}
                  onValueChange={(v) => set('paymentMethod', v as FleetPaymentMethod | '')}
                />
              </FormField>
              {s.paidBy === 'company' && !efs ? (
                <FormField label="Already paid?" description={s.paid ? 'Accounting links the payment record.' : 'Accounting gets one vendor bill when this is posted.'}>
                  <Segments label="Already paid" value={s.paid ? 'paid' : 'unpaid'} options={[{ value: 'paid', label: 'Paid' }, { value: 'unpaid', label: 'Unpaid' }]} onChange={(v) => set('paid', v === 'paid')} />
                </FormField>
              ) : (
                <div className="hidden sm:block" />
              )}
              {s.paidBy === 'company' && s.paid && !efs ? (
                <FormField label="Payment reference" error={errorFor('paymentReference')}>
                  <Input value={s.paymentReference} onChange={(e) => set('paymentReference', e.target.value)} placeholder="Card last 4, check #, …" />
                </FormField>
              ) : null}
              <FormField label="Charge to" required error={errorFor('chargeTo')}>
                <Segments
                  label="Charge to"
                  value={s.chargeTo}
                  options={
                    s.paidBy === 'owner'
                      ? [{ value: 'owner', label: 'Vendor pays' }]
                      : s.paidBy === 'company'
                        ? [{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }, { value: 'investigation', label: 'Under investigation' }]
                        : [{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }]
                  }
                  onChange={(v) => set('chargeTo', v as FleetExpenseChargeTo)}
                />
              </FormField>
            </div>

            {charged ? (
              <div className="grid gap-4 rounded-[10px] border border-nw-border bg-nw-subtle p-4 sm:grid-cols-2">
                <FormField label="Driver" required error={errorFor('charge.driverId') ?? errorFor('charge')}>
                  <Combobox options={driverOptions} value={s.chargeDriverId || null} onValueChange={(v) => set('chargeDriverId', v ?? '')} placeholder="Choose the driver" searchPlaceholder="Driver name…" />
                </FormField>
                <FormField label="Charge amount" required error={errorFor('charge.amountCents')} description="The whole expense unless only part is the driver’s.">
                  <Input inputMode="decimal" prefix="$" placeholder={centsToField(amountCents ?? 0)} value={s.chargeAmount} onChange={(e) => set('chargeAmount', e.target.value)} />
                </FormField>
                <FormField label="Reason" required error={errorFor('charge.reason')} className="sm:col-span-2">
                  <Input value={s.chargeReason} maxLength={1000} onChange={(e) => set('chargeReason', e.target.value)} placeholder="Why the driver bears this cost" />
                </FormField>
                <div className="sm:col-span-2">
                  <Checkbox
                    label="Deduct from settlement"
                    description="Accounting approves the deduction; nothing is deducted when you save."
                    checked={s.deductFromSettlement}
                    onCheckedChange={(v) => set('deductFromSettlement', v === true)}
                  />
                </div>
              </div>
            ) : null}
            {s.paidBy === 'company' && s.chargeTo === 'investigation' ? (
              <div className="grid gap-4 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg p-4 sm:grid-cols-2" data-testid="expense-investigation">
                <p className="text-xs font-semibold text-nw-warning-text sm:col-span-2">
                  Under investigation: who bears it is not decided yet. Nothing is deducted and it is not posted to Accounting until a fleet manager or Safety decides Company or Driver.
                </p>
                <FormField label="Driver in question" description="Optional. The expense shows on this driver while it is investigated.">
                  <Combobox options={driverOptions} value={s.chargeDriverId || null} onValueChange={(v) => set('chargeDriverId', v ?? '')} placeholder="No driver named" searchPlaceholder="Driver name…" />
                </FormField>
                <FormField label="What happened" error={errorFor('charge.reason')}>
                  <Input value={s.chargeReason} maxLength={1000} onChange={(e) => set('chargeReason', e.target.value)} placeholder="Optional" />
                </FormField>
              </div>
            ) : null}
          </Group>

          {/* ------------------------------------------------------------ EFS */}
          {efs ? (
            <Group title="EFS" hint="Payment evidence for an EFS check already issued. Issuing is not spending: only the used amount counts.">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="EFS code"
                  error={errorFor('efs.code')}
                  description={s.efsCode ? `Kept as ${maskEfsCode(s.efsCode) ?? '••••'}; only the last 4 are ever shown.` : expense?.efs?.masked ? `On file: ${expense.efs.masked}. Leave empty to keep it.` : 'Only the last 4 are ever shown.'}
                >
                  <Input type="password" autoComplete="off" value={s.efsCode} onChange={(e) => set('efsCode', e.target.value)} />
                </FormField>
                <FormField label="Issued on" error={errorFor('efs.issuedOn')}>
                  <DatePicker value={s.efsIssuedOn} onIsoChange={(iso) => set('efsIssuedOn', iso)} />
                </FormField>
                <FormField label="Issued amount" required error={errorFor('efs.issuedCents')}>
                  <Input inputMode="decimal" prefix="$" value={s.efsIssued} onChange={(e) => set('efsIssued', e.target.value)} placeholder="0.00" />
                </FormField>
                <FormField label="Used amount" required error={errorFor('efs.usedCents')} description="The amount on the receipt; this is the expense.">
                  <Input inputMode="decimal" prefix="$" value={s.efsUsed} onChange={(e) => set('efsUsed', e.target.value)} placeholder="0.00" />
                </FormField>
                <FormField label="Status" error={errorFor('efs.status')}>
                  <Select options={EFS_STATUSES.map((v) => ({ value: v, label: EFS_STATUS_LABEL[v] }))} value={s.efsStatus} onValueChange={(v) => set('efsStatus', v as EfsStatus)} />
                </FormField>
                <FormField label="EFS receipt">
                  <FilePick label={efsReceiptName ? 'Replace receipt' : 'Upload receipt'} disabled={uploading} onFiles={(f) => void addFiles(f, 'efs_receipt')} />
                </FormField>
                {efsReceiptName ? <p className="text-xs text-nw-text-2 sm:col-span-2"><Paperclip aria-hidden className="mr-1 inline size-3" />{efsReceiptName}</p> : null}
              </div>
              {issued !== null && used !== null ? (
                <p className="rounded-[10px] bg-nw-subtle px-3 py-2 text-[13px] text-nw-text-2">
                  Issued {money(issued)} · Used {money(used)} ·{' '}
                  <span className="font-semibold text-nw-text">Unused {money(Math.max(0, issued - used))}</span> — unused is not spend.
                </p>
              ) : null}
            </Group>
          ) : null}

          {/* ------------------------------------------------------------ Documents */}
          <Group title="Documents" hint={editing ? 'Files added here are attached when you save. Remove files from the expense itself.' : 'Receipts and invoices; attached when you save.'}>
            <div className="flex flex-col gap-2">
              {pending.map((p, i) => (
                <div key={p.file.id} className="flex items-center gap-3 rounded-[10px] border border-nw-border px-3 py-2">
                  <FileText aria-hidden className="size-4 shrink-0 text-nw-text-3" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-nw-text">{p.file.fileName}</span>
                  <Select
                    aria-label="Kind"
                    size="sm"
                    className="w-32"
                    options={[{ value: 'receipt', label: 'Receipt' }, { value: 'invoice', label: 'Invoice' }, { value: 'other', label: 'Other' }]}
                    value={p.kind}
                    onValueChange={(v) => setPending((prev) => prev.map((x, j) => (j === i ? { ...x, kind: v as FileKind } : x)))}
                  />
                  <IconButton label={`Remove ${p.file.fileName}`} size="sm" className="ml-2 text-nw-urgent-icon" onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </IconButton>
                </div>
              ))}
              <div>
                <FilePick label={uploading ? 'Uploading…' : 'Upload files'} disabled={uploading} multiple onFiles={(f) => void addFiles(f, 'receipt')} />
              </div>
            </div>
          </Group>

          {/* ------------------------------------------------------------ Review */}
          <Group title="Review">
            <div className="rounded-[10px] border border-nw-border bg-nw-subtle p-4 text-[13px]">
              <p className="font-bold text-nw-text">{FLEET_EXPENSE_OUTCOME_LABEL[outcome]}</p>
              <p className="mt-0.5 text-nw-text-2">
                {s.category ? FLEET_EXPENSE_CATEGORY_LABEL[s.category] : 'No category yet'} · {amountCents !== null ? money(amountCents) : 'no amount yet'}
                {s.truckId ? ` · Unit ${opts.trucks.find((t) => t.id === s.truckId)?.unitNumber ?? ''}` : ''}
              </p>
              <p className="mt-3 text-xs font-bold tracking-[.06em] text-nw-text-3 uppercase">What Accounting will get</p>
              <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-nw-text">
                {outcomeLines(s, chargeShown).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-nw-text-3">A draft is not counted as spend and goes nowhere until it is saved as an expense.</p>
            </div>
          </Group>
        </div>
      )}
    </Modal>
  );
}

function outcomeLines(s: FormState, chargeCents: number): string[] {
  const efs = s.paymentMethod === 'efs';
  switch (expenseOutcome(s.paidBy, s.chargeTo)) {
    case 'company_cost':
      return [efs || s.paid ? 'Payment record' : 'One vendor bill'];
    case 'driver_charge':
      return [
        efs || s.paid ? 'Payment record' : 'One vendor bill',
        `Driver charge ${money(chargeCents)}${s.deductFromSettlement ? ', for Accounting to approve against settlements' : ''}`,
      ];
    case 'reimbursement':
      return ['Reimbursement to the driver, through Accounting'];
    case 'external':
      return ['Tracked only — no payable, no deduction'];
    case 'investigation':
      return ['Held under investigation — no posting, no deduction until someone decides'];
  }
}

// ---------------------------------------------------------------------------- pieces

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-nw-border pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-bold text-nw-text">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-nw-text-3">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Disclose({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline">
      <ChevronDown aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

/** A small segmented choice in the app's segment style. */
function Segments({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit gap-0.5 rounded-lg bg-nw-segment p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('h-8 rounded-md px-3 text-[12.5px] font-semibold text-nw-text-2', value === o.value && 'bg-nw-accent text-nw-on-accent')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilePick({ label, onFiles, disabled, multiple }: { label: string; onFiles: (files: FileList | null) => void; disabled?: boolean; multiple?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        className="hidden"
        multiple={multiple}
        accept="application/pdf,image/*"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button variant="outline" size="sm" icon={<Upload />} disabled={disabled} onClick={() => ref.current?.click()}>
        {label}
      </Button>
    </>
  );
}

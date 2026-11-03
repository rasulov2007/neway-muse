import { Calendar, Check, Gauge, Plus, Store, Truck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  PM_ODOMETER_TOLERANCE_MILES,
  PM_WORK_ITEMS,
  PM_WORK_ITEM_LABEL,
  PM_ZERO_REASONS,
  PM_ZERO_REASON_LABEL,
  completionPreview,
  odometerCheck,
  type PmBoardRow,
  type PmShop,
  type PmWorkItem,
} from '@neway/shared';
import {
  Button,
  Combobox,
  Drawer,
  Input,
  Select,
  StatusBadge,
  StatusSymbol,
  useToast,
} from '@/design-system';
import { nowIso } from '@/lib/clock';
import { formatDate, formatMoney, formatTime, parseMoney } from '@/lib/format';
import { FileDropzone } from '../components/FileDropzone';
import { uploadFile } from '@/lib/files';
import { pmKeys, useCompletePm, useReadingNear } from './api';
import { useLeaveGuard } from './useLeaveGuard';
import { apiPost } from '@/lib/api-client';
import { useQueryClient } from '@tanstack/react-query';
import type { CreatePmShopRequest } from '@neway/shared';
import { OTHER_WORK_SYSTEMS } from './board-model';
import { AutoBox, AutoLine, CheckRow, Field } from './sheet-bits';
import { useLeaseOperatorTrucks } from '../lease-operator';
import { dueWord, nowWall, shopLabel, shortDate, tzShort, zonedToIso } from './sheet-format';

const n = (v: number) => v.toLocaleString('en-US');

interface OtherLine {
  systemCode: string;
  description: string;
  amount: string;
}

interface SheetProps {
  unitId: string | null;
  rows: PmBoardRow[];
  shops: PmShop[];
  onClose: () => void;
}

/**
 * Record oil change (mockup C): from the invoice, after the service. This is the only thing that
 * resets the clock (§6.2). The odometer at the service is checked against the ELD; beyond the
 * tolerance the person says why. Only the oil-change line resets the clock - other work on the
 * same invoice is kept apart.
 */
export function RecordPmSheet(props: SheetProps) {
  const [pickedUnit, setPickedUnit] = useState<string | null>(props.unitId);
  const [useAppointment, setUseAppointment] = useState(true);
  const row = useMemo(
    () => props.rows.find((r) => r.unitId === pickedUnit) ?? null,
    [props.rows, pickedUnit],
  );
  const appointment = row?.appointment && useAppointment ? row.appointment : null;
  return (
    <RecordForm
      key={`${row?.unitId ?? 'none'}:${appointment?.workOrderId ?? 'walk-in'}`}
      {...props}
      row={row}
      appointment={appointment}
      onPickUnit={setPickedUnit}
      onToggleAppointment={row?.appointment ? () => setUseAppointment((v) => !v) : null}
    />
  );
}

function RecordForm({
  row,
  rows,
  shops,
  appointment,
  onClose,
  onPickUnit,
  onToggleAppointment,
}: SheetProps & {
  row: PmBoardRow | null;
  appointment: PmBoardRow['appointment'];
  onPickUnit: (unitId: string | null) => void;
  onToggleAppointment: (() => void) | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Adding a shop right here: the name typed into the picker, a city and a state.
  const [newShop, setNewShop] = useState<{ name: string; city: string; state: string } | null>(
    null,
  );
  const [addingShop, setAddingShop] = useState(false);
  const addShop = async () => {
    if (!newShop) return;
    setAddingShop(true);
    try {
      const body: CreatePmShopRequest = {
        name: newShop.name.trim(),
        city: newShop.city.trim() || null,
        state: newShop.state.trim() || null,
      };
      const created = await apiPost<PmShop>('/fleet/pm/shops', body);
      await queryClient.invalidateQueries({ queryKey: pmKeys.shops });
      setVendorId(created.id);
      setNewShop(null);
      toast({ tone: 'success', title: `${created.name} added as a shop` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The shop could not be added');
    } finally {
      setAddingShop(false);
    }
  };
  const complete = useCompletePm();

  const [when, setWhen] = useState(() => nowWall());
  const [odometer, setOdometer] = useState('');
  const [odometerReason, setOdometerReason] = useState('');
  const [work, setWork] = useState<PmWorkItem[]>(['oil_filter', 'fuel_filters', 'grease']);
  const [other, setOther] = useState<OtherLine[]>([]);
  const [vendorId, setVendorId] = useState(() => appointment?.vendorId ?? '');
  const [total, setTotal] = useState('');
  const [zeroReason, setZeroReason] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // A lease operator's truck (owner, 2026-11-03): the invoice and its total are optional; the
  // oil-change clock resets the same. A blank total saves as $0 covered by the lease.
  const loTrucks = useLeaseOperatorTrucks();
  const lo = row ? loTrucks.has(row.unitId) : false;
  const needsFile = !lo;

  const serviceAtIso = when ? zonedToIso(when) : null;
  const near = useReadingNear(row?.unitId ?? null, serviceAtIso);
  // "412,500" and "412 500" are miles too: a number field emptied them and the save sat greyed (2026-10-19).
  const odo = Number(odometer.replace(/[,\s]/g, ''));
  const check =
    odometer && Number.isFinite(odo)
      ? odometerCheck({
          serviceOdometer: odo,
          eldOdometer: near.data?.odometerMiles ?? null,
          eldAt: near.data?.readingAt ?? null,
        })
      : null;

  const otherTotal = other.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  // Typed as money: "$360.00" and "360" both read as 360; the field shows dollars once left.
  const totalNum = total.trim() === '' ? (lo ? 0 : null) : parseMoney(total);
  const pmAmount = totalNum === null ? null : Math.max(0, totalNum - otherTotal);
  const preview =
    row && odometer && Number.isFinite(odo) && serviceAtIso
      ? completionPreview({
          serviceOdometer: odo,
          intervalMiles: row.intervalMiles,
          previousServiceOdometer: row.lastServiceOdometer,
          avgMilesPerDay: row.avgMilesPerDay,
          serviceAt: serviceAtIso,
        })
      : null;

  const save = async () => {
    setError(null);
    if (!row) return setError('Pick a unit first');
    if (!serviceAtIso) return setError('Say when the service was');
    if (!odometer || !Number.isFinite(odo) || odo < 0)
      return setError('Enter the odometer at the service');
    if (!work.includes('oil_filter')) return setError('Oil and filter is required for a reset');
    if (!vendorId) return setError('Pick the shop');
    if (totalNum === null || !Number.isFinite(totalNum) || totalNum < 0)
      return setError('Enter the total on the invoice');
    if (totalNum === 0 && !zeroReason && !lo) return setError('Say why the invoice is $0');
    if (!file && needsFile) return setError('Attach the invoice: the record cannot be completed without it');
    if (check?.verdict === 'needs_reason' && !odometerReason.trim())
      return setError(
        `The odometer is ${n(check.gapMiles ?? 0)} miles from the ELD. Say why before saving.`,
      );
    for (const l of other)
      if (!l.systemCode || !l.description.trim() || !Number.isFinite(Number(l.amount)))
        return setError('Every other-work line needs a system, a description and an amount');
    let invoiceFileIds: string[] = [];
    if (file) {
      setUploading(true);
      try {
        const stored = await uploadFile(file);
        invoiceFileIds = [stored.id];
      } catch (e) {
        setUploading(false);
        return setError(e instanceof Error ? e.message : 'Could not upload the invoice');
      }
      setUploading(false);
    }
    complete.mutate(
      {
        unitId: row.unitId,
        serviceCode: 'OIL_CHANGE',
        workOrderId: appointment?.workOrderId ?? null,
        serviceAt: serviceAtIso,
        serviceOdometer: odo,
        odometerReason: odometerReason.trim() || null,
        work,
        otherLines: other.map((l) => ({
          systemCode: l.systemCode,
          description: l.description.trim(),
          amount: Number(l.amount) || 0,
        })),
        vendorId,
        invoiceTotal: totalNum,
        zeroReason: totalNum === 0 ? ((zeroReason || 'lease') as (typeof PM_ZERO_REASONS)[number]) : null,
        invoiceNumber: invoiceNumber.trim() || null,
        invoiceFileIds,
      },
      {
        onSuccess: ({ status, workOrder }) => {
          toast({
            tone: 'success',
            title: `${row.unitNumber} · oil change recorded`,
            description: `${workOrder.number} completed at ${n(odo)} mi. ${status.nextServiceOdometer !== null ? `Next at ${n(status.nextServiceOdometer)} mi.` : ''}`,
          });
          if (workOrder.odometerWarning) toast({ tone: 'warning', title: 'Odometer not accepted', description: `${workOrder.odometerWarning}. It is kept as a conflict and not used; correct the completion.` });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the completion'),
      },
    );
  };

  const dirty = Boolean(odometer || vendorId || total || invoiceNumber || file || other.length > 0);
  const leave = useLeaveGuard(dirty, onClose);

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) leave.requestClose();
      }}
      size="xl"
      className="md:w-180"
      title="Record oil change"
      headerExtra={<StatusBadge status="completed" label="Completed" />}
      description={
        row
          ? `${row.unitNumber} · from the invoice, after the service. This is the only thing that resets the clock.`
          : 'From the invoice, after the service. This is the only thing that resets the clock.'
      }
      footer={
        <div className="flex w-full items-center gap-2">
          {/* Say what holds the save back (owner, 2026-10-19: the button sat greyed with no reason). */}
          {!odometer || (!file && needsFile) ? (
            <span className="mr-auto text-xs font-semibold text-nw-urgent-text" role="status">
              {!odometer && !file && needsFile
                ? 'Enter the odometer and attach the invoice to save'
                : !odometer
                  ? 'Enter the odometer from the invoice (top of the form) to save'
                  : 'Attach the invoice to save'}
            </span>
          ) : (
            <span className="mr-auto text-xs text-nw-text-3">
              Only the oil-change line resets the clock — other work doesn't
            </span>
          )}
          <Button variant="secondary" onClick={leave.requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Check />}
            loading={complete.isPending || uploading}
            disabled={!odometer || (!file && needsFile)}
            onClick={() => void save()}
          >
            Save as completed
          </Button>
        </div>
      }
    >
      <div className="grid gap-2.5">
        {/* The unit and, if there is one, the appointment this completes. */}
        <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-[10px] bg-nw-subtle px-3 py-2 ring-1 ring-nw-border ring-inset">
          <span className="row-span-2 grid size-[34px] place-items-center rounded-[9px] bg-nw-accent-tint text-nw-accent">
            <Truck className="size-4" aria-hidden />
          </span>
          {row ? (
            <>
              <b className="text-sm text-nw-text">
                {row.unitNumber}
                {row.groupName ? ` · ${row.groupName}` : ''}
                {appointment
                  ? ` · appointment ${apptWhen(appointment.scheduledFor)}`
                  : ` · ${dueWord(row)}`}
              </b>
              <span className="row-span-2 flex items-center gap-3 self-center">
                {onToggleAppointment ? (
                  <button
                    type="button"
                    className="text-[12.5px] font-semibold whitespace-nowrap text-nw-accent-ink"
                    onClick={onToggleAppointment}
                  >
                    {appointment ? 'Not this visit' : 'Use the appointment'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-[12.5px] font-semibold text-nw-accent-ink"
                  onClick={() => onPickUnit(null)}
                >
                  Change
                </button>
              </span>
              <span className="truncate text-xs text-nw-text-2">
                {[
                  appointment
                    ? `${appointment.vendorName}${appointment.responsibleName ? ` · ${appointment.responsibleName}` : ''}`
                    : (row.driverName ?? 'no driver'),
                  row.intervalMiles ? `every ${n(row.intervalMiles)} mi` : 'no interval',
                  row.lastServiceAt && row.lastServiceOdometer !== null
                    ? `last PM ${shortDate(row.lastServiceAt)} at ${n(row.lastServiceOdometer)}`
                    : 'no PM on record',
                ].join(' · ')}
              </span>
            </>
          ) : (
            <div className="col-span-2">
              <Combobox
                aria-label="Unit"
                options={rows.map((r) => ({
                  value: r.unitId,
                  label: r.unitNumber,
                  description: `${dueWord(r)}${r.appointment ? ` · booked ${apptWhen(r.appointment.scheduledFor)}` : ''}`,
                }))}
                value={null}
                onValueChange={onPickUnit}
                placeholder="Pick a unit…"
                searchPlaceholder="Unit number…"
                emptyMessage="No unit matches"
              />
            </div>
          )}
        </div>

        <div className="grid gap-2.5 md:grid-cols-2">
          <Field label="Service date and time" required>
            <label className="flex h-9 items-center gap-2 rounded-lg bg-nw-field px-2.5 text-[13.5px] text-nw-text ring-1 ring-nw-border-strong ring-inset focus-within:ring-[1.5px] focus-within:ring-nw-accent">
              <Calendar className="size-[15px] text-nw-text-3" aria-hidden />
              <input
                type="datetime-local"
                aria-label="Service date and time"
                value={when}
                max={nowWall()}
                onChange={(e) => setWhen(e.target.value)}
                className="w-full bg-transparent outline-none"
              />
              <span className="rounded-[5px] bg-nw-accent-tint px-1.5 py-0.5 text-[11px] font-bold text-nw-accent-ink">
                {tzShort()}
              </span>
            </label>
          </Field>
          <Field label="Odometer at service" required small="not today's reading">
            <label className="flex h-9 items-center gap-2 rounded-lg bg-nw-field px-2.5 text-[13.5px] text-nw-text ring-1 ring-nw-border-strong ring-inset focus-within:ring-[1.5px] focus-within:ring-nw-accent">
              <Gauge className="size-[15px] text-nw-text-3" aria-hidden />
              <input
                type="text"
                inputMode="numeric"
                aria-label="Odometer at service"
                value={odometer}
                onChange={(e) => setOdometer(e.target.value)}
                placeholder="from the invoice"
                className="w-full bg-transparent outline-none"
              />
              <span className="text-nw-text-3">mi</span>
              {check?.verdict === 'trusted' ? (
                <Check className="size-[15px] text-nw-done-icon" aria-hidden />
              ) : null}
            </label>
          </Field>
        </div>

        {/* The odometer against the ELD */}
        {check?.verdict === 'trusted' && near.data ? (
          <div className="flex items-center gap-2 rounded-[9px] bg-nw-done-bg px-3 py-2 text-[12.5px] text-nw-done-text ring-1 ring-nw-done-border ring-inset">
            <StatusSymbol family="done" size={14} className="text-nw-done-icon" />
            <span>
              ELD reported <b>{n(near.data.odometerMiles)} mi</b> at{' '}
              {formatTime(near.data.readingAt)} — {n(check.gapMiles ?? 0)}{' '}
              {check.gapMiles === 1 ? 'mile' : 'miles'} apart, so this reading is trusted.
            </span>
          </div>
        ) : check?.verdict === 'needs_reason' && near.data ? (
          <div className="grid gap-2 rounded-[9px] bg-nw-warning-bg px-3 py-2 text-[12.5px] text-nw-warning-text ring-1 ring-nw-warning-border ring-inset">
            <span className="flex items-center gap-2">
              <StatusSymbol family="warning" size={14} className="text-nw-warning-icon" />
              <span>
                ELD reported <b>{n(near.data.odometerMiles)} mi</b> at{' '}
                {formatTime(near.data.readingAt)} — {n(check.gapMiles ?? 0)} miles apart, more than{' '}
                {PM_ODOMETER_TOLERANCE_MILES}. Say why.
              </span>
            </span>
            <Input
              aria-label="Why the odometer differs"
              value={odometerReason}
              onChange={(e) => setOdometerReason(e.target.value)}
              placeholder="e.g. ELD was swapped on Sep 3; invoice reading is the dash"
            />
          </div>
        ) : row && odometer && !near.isPending ? (
          <div className="flex items-center gap-2 rounded-[9px] bg-nw-subtle px-3 py-2 text-[12.5px] text-nw-text-2 ring-1 ring-nw-border ring-inset">
            <StatusSymbol family="info" size={14} className="text-nw-neutral-icon" />
            <span>
              No ELD reading within three days of the service; the invoice reading stands on its
              own.
            </span>
          </div>
        ) : null}

        {/* What was done */}
        <Field label="What was done" required small="oil and filter is required for a reset">
          <div className="grid gap-1.5">
            {PM_WORK_ITEMS.map((item) => (
              <CheckRow
                key={item}
                on={work.includes(item)}
                locked={item === 'oil_filter'}
                onToggle={() =>
                  setWork((w) => (w.includes(item) ? w.filter((k) => k !== item) : [...w, item]))
                }
                label={PM_WORK_ITEM_LABEL[item].label}
                sub={
                  item === 'oil_filter'
                    ? odometer && Number.isFinite(odo)
                      ? `resets the clock from ${n(odo)} mi`
                      : 'resets the clock from the odometer above'
                    : PM_WORK_ITEM_LABEL[item].note || undefined
                }
              />
            ))}
          </div>
        </Field>

        {/* Other work on this invoice */}
        <Field label="Other work on this invoice" optional small="kept apart from the PM">
          <div className="grid gap-1.5">
            {other.map((line, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_110px_28px] items-center gap-2 rounded-[9px] bg-nw-field px-[11px] py-2 text-[12.5px] ring-1 ring-nw-border-strong ring-inset"
              >
                <Select
                  aria-label="System"
                  size="sm"
                  options={OTHER_WORK_SYSTEMS}
                  value={line.systemCode}
                  onValueChange={(v) =>
                    setOther((o) => o.map((l, j) => (j === i ? { ...l, systemCode: v } : l)))
                  }
                  placeholder="System"
                />
                <Input
                  aria-label="Description"
                  size="sm"
                  value={line.description}
                  onChange={(e) =>
                    setOther((o) =>
                      o.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)),
                    )
                  }
                  placeholder="What was done"
                />
                <Input
                  aria-label="Amount"
                  size="sm"
                  type="number"
                  min={0}
                  step="0.01"
                  prefix="$"
                  value={line.amount}
                  onChange={(e) =>
                    setOther((o) =>
                      o.map((l, j) => (j === i ? { ...l, amount: e.target.value } : l)),
                    )
                  }
                />
                <button
                  type="button"
                  aria-label="Remove line"
                  onClick={() => setOther((o) => o.filter((_, j) => j !== i))}
                  className="grid size-7 place-items-center rounded-[7px] text-nw-text-2 hover:bg-nw-hover"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setOther((o) => [...o, { systemCode: '', description: '', amount: '' }])
              }
              className="inline-flex w-fit items-center gap-1 text-[12.5px] font-semibold text-nw-accent-ink"
            >
              <Plus className="size-3.5" aria-hidden />
              Add another line
            </button>
          </div>
        </Field>

        <div className="grid gap-2.5 md:grid-cols-2">
          <Field label="Shop" required>
            {appointment && vendorId === appointment.vendorId ? (
              <div className="flex h-9 items-center gap-2 rounded-lg bg-nw-subtle px-2.5 text-[13.5px] text-nw-text-2 ring-1 ring-nw-border-strong ring-inset">
                <Store className="size-[15px] text-nw-text-3" aria-hidden />
                <span className="truncate">{appointment.vendorName}</span>
                <button
                  type="button"
                  className="ml-auto text-xs font-semibold text-nw-accent-ink"
                  onClick={() => setVendorId('')}
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Combobox
                  aria-label="Shop"
                  options={shops.map((s) => ({ value: s.id, label: shopLabel(s) }))}
                  value={vendorId || null}
                  onValueChange={(v) => setVendorId(v ?? '')}
                  placeholder={shops.length ? 'Which shop did it' : 'No shops yet — add one'}
                  searchPlaceholder="Shop name"
                  emptyMessage="No shop matches"
                  onCreate={(typed) => setNewShop({ name: typed, city: '', state: '' })}
                  createLabel={(typed) => (typed ? `+ Add shop "${typed}"` : '+ Add a shop')}
                />
                {newShop ? (
                  <div className="grid gap-2 rounded-lg border border-nw-border bg-nw-subtle p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_auto]">
                    <Input
                      size="sm"
                      aria-label="Shop name"
                      value={newShop.name}
                      onChange={(e) => setNewShop({ ...newShop, name: e.target.value })}
                      placeholder="Shop name"
                    />
                    <Input
                      size="sm"
                      aria-label="Shop city"
                      value={newShop.city}
                      onChange={(e) => setNewShop({ ...newShop, city: e.target.value })}
                      placeholder="City"
                    />
                    <Input
                      size="sm"
                      aria-label="Shop state"
                      value={newShop.state}
                      maxLength={2}
                      onChange={(e) =>
                        setNewShop({ ...newShop, state: e.target.value.toUpperCase() })
                      }
                      placeholder="ST"
                    />
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        loading={addingShop}
                        disabled={newShop.name.trim().length < 2}
                        onClick={() => void addShop()}
                      >
                        Add
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setNewShop(null)}>
                        Cancel
                      </Button>
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </Field>
          <Field label="Total on the invoice" required>
            <label className="flex h-9 items-center gap-2 rounded-lg bg-nw-field px-2.5 text-[13.5px] text-nw-text ring-1 ring-nw-border-strong ring-inset focus-within:ring-[1.5px] focus-within:ring-nw-accent">
              <span className="text-nw-text-3">$</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Total on the invoice"
                value={total}
                onChange={(e) => setTotal(e.target.value.replace(/[^0-9.,$]/g, ''))}
                onBlur={() => {
                  const value = parseMoney(total);
                  if (value !== null && value >= 0) setTotal(formatMoney(value).replace(/^\$/, ''));
                }}
                placeholder="0.00"
                className="tabular w-full bg-transparent outline-none"
              />
              {pmAmount !== null && other.length > 0 ? (
                <span className="whitespace-nowrap text-nw-text-3">
                  PM {formatMoney(pmAmount, { compact: true })} +{' '}
                  {formatMoney(otherTotal, { compact: true })}
                </span>
              ) : null}
            </label>
          </Field>
        </div>

        {totalNum === 0 ? (
          <Field label="Why $0" required>
            <Select
              aria-label="Why $0"
              options={PM_ZERO_REASONS.map((r) => ({ value: r, label: PM_ZERO_REASON_LABEL[r] }))}
              value={zeroReason}
              onValueChange={setZeroReason}
              placeholder="Lease, warranty, goodwill or in-house"
            />
          </Field>
        ) : null}

        <Field label="Invoice #">
          <Input
            aria-label="Invoice number"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder="as printed"
            suffix={
              invoiceNumber.trim() ? (
                <Check className="size-[15px] text-nw-done-icon" aria-hidden />
              ) : undefined
            }
          />
        </Field>

        <FileDropzone
          title={lo ? 'Invoice (optional)' : 'Invoice *'}
          subtitle="The shop's invoice — a PDF or a photograph"
          hint={
            lo
              ? 'Lease operator truck: the invoice is optional. The oil-change clock resets from the odometer.'
              : 'Required: the record cannot be completed without the invoice and the odometer on it.'
          }
          actionLabel="Browse files"
          file={file}
          onFile={setFile}
        />

        {error ? <p className="text-sm text-nw-urgent-text">{error}</p> : null}

        <AutoBox>
          <AutoLine family="done">
            {preview && preview.nextServiceOdometer !== null && row?.intervalMiles ? (
              <>
                Next oil change at <b>{n(preview.nextServiceOdometer)} mi</b> — {n(odo)} +{' '}
                {n(row.intervalMiles)}.
                <small>
                  {preview.estimatedNextDate ? (
                    <>
                      Estimated <b>{formatDate(`${preview.estimatedNextDate}T12:00:00Z`)}</b> at
                      this truck's {n(Math.round(row.avgMilesPerDay ?? 0))} mi/day.{' '}
                    </>
                  ) : (
                    'No daily average yet, so no estimated date. '
                  )}
                  {row.dueStatus === 'overdue' || row.dueStatus === 'overdue_at_least'
                    ? `${row.unitNumber} clears Overdue.`
                    : `${row.unitNumber} shows OK.`}
                </small>
              </>
            ) : row && !row.intervalMiles ? (
              <>
                No interval is set for {row.unitNumber}, so no next service can be worked out.
                <small>Set one under Intervals; the completion still becomes the baseline.</small>
              </>
            ) : (
              <>
                The next oil change is worked out from the odometer above.
                <small>Enter it to see the number.</small>
              </>
            )}
          </AutoLine>
          <AutoLine family="info">
            {appointment
              ? `Work order ${appointment.workOrderNumber} is completed and the appointment closes.`
              : 'A completed work order is written for this visit.'}
            <small>
              {pmAmount !== null && totalNum !== null
                ? `${formatMoney(pmAmount)} PM${other.length ? ` + ${formatMoney(otherTotal)} other work` : ''} post once to maintenance costs. No second record.`
                : 'The invoice total posts once to maintenance costs. No second record.'}
            </small>
          </AutoLine>
          {preview && preview.milesRun !== null && row?.intervalMiles ? (
            <AutoLine family={preview.ranOverBy ? 'warning' : 'done'}>
              This interval ran <b>{n(preview.milesRun)} mi</b>
              {preview.ranOverBy
                ? ` — ${n(preview.ranOverBy)} over the ${n(row.intervalMiles)} setting.`
                : ` — inside the ${n(row.intervalMiles)} setting.`}
              <small>
                {preview.ranOverBy
                  ? 'Added to the interval review list: five in a row over means the interval or the reminders need changing.'
                  : 'Counts toward the on-time rate.'}
              </small>
            </AutoLine>
          ) : null}
          <AutoLine family="info">
            Truck overview, maintenance history and Truck Health all read this one record.
            <small>
              {preview && preview.nextServiceOdometer !== null && serviceAtIso
                ? `Oil change: current · last service ${shortDate(serviceAtIso)} · next at ${n(preview.nextServiceOdometer)}.`
                : 'One record, read everywhere.'}
            </small>
          </AutoLine>
        </AutoBox>
      </div>
      {leave.dialog}
    </Drawer>
  );
}

function apptWhen(iso: string): string {
  const day = iso.slice(0, 10);
  const todayIso = nowIso().slice(0, 10);
  return `${day === todayIso ? 'today' : shortDate(iso)} ${formatTime(iso)}`;
}

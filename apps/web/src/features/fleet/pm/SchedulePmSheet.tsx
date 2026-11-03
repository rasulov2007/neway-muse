import { Calendar, Check, MapPin, Package, Store, Truck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PM_DEFAULT_HOLD_MINUTES, type PmBoardRow, type PmShop } from '@neway/shared';
import { Button, Combobox, Drawer, Select, Textarea, cn, useToast } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatDate, formatMoney, formatRelative, formatTime } from '@/lib/format';
import { useSchedulePm, type Assignee } from './api';
import { AutoBox, AutoLine, CheckRow, Field } from './sheet-bits';
import {
  defaultSlot,
  dueWord,
  isoToZonedWall,
  shopLabel,
  shortDate,
  stopDay,
  tzShort,
  zonedToIso,
} from './sheet-format';

const n = (v: number) => v.toLocaleString('en-US');

interface SheetProps {
  unitId: string | null;
  rows: PmBoardRow[];
  shops: PmShop[];
  assignees: Assignee[];
  seesCost: boolean;
  onClose: () => void;
}

/**
 * Schedule oil change (mockup B): a sheet over the board. Book it where the truck will be, not
 * where it is now. Saving writes a work order in "Scheduled into a shop" and nothing else: the
 * due status is untouched until the service is recorded (§4.3).
 *
 * The form is keyed on the unit, so picking another unit starts it again from that row.
 */
export function SchedulePmSheet(props: SheetProps) {
  const [pickedUnit, setPickedUnit] = useState<string | null>(props.unitId);
  const row = useMemo(
    () => props.rows.find((r) => r.unitId === pickedUnit) ?? null,
    [props.rows, pickedUnit],
  );
  return (
    <ScheduleForm key={row?.unitId ?? 'none'} {...props} row={row} onPickUnit={setPickedUnit} />
  );
}

function ScheduleForm({
  row,
  rows,
  shops,
  assignees,
  seesCost,
  onClose,
  onPickUnit,
}: SheetProps & { row: PmBoardRow | null; onPickUnit: (unitId: string | null) => void }) {
  const { toast } = useToast();
  const schedule = useSchedulePm();
  const existing = row?.appointment ?? null;

  // A row's own bundle is prefilled: the inspection saves a second trip, a defect is a choice.
  const [bundle, setBundle] = useState<string[]>(() =>
    (row?.alsoDue ?? []).filter((a) => a.key === 'annual_inspection').map((a) => a.key),
  );
  const [vendorId, setVendorId] = useState<string>(() => existing?.vendorId ?? '');
  const [when, setWhen] = useState<string>(() =>
    existing ? isoToZonedWall(existing.scheduledFor) : defaultSlot(),
  );
  const [responsible, setResponsible] = useState<string>(() => existing?.responsibleUserId ?? '');
  const [estimate, setEstimate] = useState<string>(() =>
    existing?.estimatedCost !== null && existing?.estimatedCost !== undefined
      ? String(existing.estimatedCost)
      : '',
  );
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState(() => existing?.noteForShop ?? '');
  const [error, setError] = useState<string | null>(null);

  const suggested = useMemo(() => {
    const list = [...shops];
    list.sort(
      (a, b) =>
        Number(b.visits > 0) - Number(a.visits > 0) ||
        b.visits - a.visits ||
        a.name.localeCompare(b.name),
    );
    return list.slice(0, 3);
  }, [shops]);
  const shop = shops.find((s) => s.id === vendorId) ?? null;
  const responsibleName = assignees.find((a) => a.id === responsible)?.name ?? null;

  const pickShop = (s: PmShop) => {
    setVendorId(s.id);
    if (seesCost && s.lastPrice !== null && s.lastPrice !== undefined && !estimate)
      setEstimate(String(s.lastPrice));
  };

  const save = () => {
    setError(null);
    if (!row) return setError('Pick a unit first');
    if (!vendorId) return setError('Pick a shop');
    if (!when) return setError('Pick a date and time');
    if (!responsible) return setError('Pick who is responsible');
    const scheduledIso = zonedToIso(when);
    if (!scheduledIso) return setError('That date is not a date');
    const scheduledFor = new Date(scheduledIso);
    schedule.mutate(
      {
        unitId: row.unitId,
        serviceCode: 'OIL_CHANGE',
        vendorId,
        scheduledFor: scheduledFor.toISOString(),
        responsibleUserId: responsible,
        estimatedCost: seesCost && estimate.trim() ? Number(estimate) : null,
        noteForShop: note.trim() || null,
        notifyDriver: notify,
        notifyDispatcher: notify,
        holdMinutes: PM_DEFAULT_HOLD_MINUTES,
        bundle,
        moveExisting: existing !== null,
      },
      {
        onSuccess: (wo) => {
          toast({
            tone: 'success',
            title: `${row.unitNumber} booked`,
            description: `${wo.number} · ${shop?.name ?? ''} · ${formatDate(scheduledFor)} ${formatTime(scheduledFor)}. Still ${dueWord(row)} until the service is recorded.`,
          });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the appointment'),
      },
    );
  };

  const whenIso = when ? zonedToIso(when) : null;
  const holdEnd = whenIso
    ? new Date(new Date(whenIso).getTime() + PM_DEFAULT_HOLD_MINUTES * 60_000)
    : null;

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      className="md:w-180"
      title="Schedule oil change"
      description={row ? headline(row) : 'Pick the unit to book.'}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="mr-auto text-xs text-nw-text-3">
            Nothing here changes the due status
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Calendar />} loading={schedule.isPending} onClick={save}>
            {existing ? 'Move appointment' : 'Save appointment'}
          </Button>
        </div>
      }
    >
      <div className="grid gap-2.5">
        {/* The unit */}
        <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-[10px] bg-nw-subtle px-3 py-2 ring-1 ring-nw-border ring-inset">
          <span className="row-span-2 grid size-[34px] place-items-center rounded-[9px] bg-nw-accent-tint text-nw-accent">
            <Truck className="size-4" aria-hidden />
          </span>
          {row ? (
            <>
              <b className="text-sm text-nw-text">
                {row.unitNumber}
                {row.groupName ? ` · ${row.groupName}` : ''}
                {row.readingOdometer !== null ? ` · ${n(row.readingOdometer)} mi` : ''}
              </b>
              <span className="row-span-2 self-center">
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
                  row.driverName ?? 'no driver',
                  row.intervalMiles ? `every ${n(row.intervalMiles)} mi` : 'no interval',
                  row.lastServiceAt && row.lastServiceOdometer !== null
                    ? `last PM ${shortDate(row.lastServiceAt)} at ${n(row.lastServiceOdometer)}`
                    : 'no PM on record',
                  row.readingAt
                    ? `${row.readingSource === 'eld' ? 'ELD' : row.readingSource} ${formatRelative(row.readingAt)}`
                    : 'no reading',
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
                  description: `${dueWord(r)}${r.driverName ? ` · ${r.driverName}` : ''}`,
                }))}
                value={null}
                onValueChange={onPickUnit}
                placeholder="Pick a unit…"
                searchPlaceholder="Unit number or driver…"
                emptyMessage="No unit matches"
              />
            </div>
          )}
        </div>

        {existing ? (
          <p className="rounded-[9px] bg-nw-moving-bg px-3 py-2 text-[12.5px] text-nw-moving-text ring-1 ring-nw-moving-border ring-inset">
            Already booked on {existing.workOrderNumber} for {formatDate(existing.scheduledFor)}{' '}
            {formatTime(existing.scheduledFor)} at {existing.vendorName}. Saving moves that
            appointment.
          </p>
        ) : null}

        {/* What to do */}
        <Field label="What to do" required small="bundle anything else that's due">
          <div className="grid gap-1.5">
            <CheckRow
              on
              locked
              label="Oil & filter change (PM A)"
              sub="the only item that resets the oil-change clock"
            />
            {(row?.alsoDue ?? []).map((a) => (
              <CheckRow
                key={a.key}
                on={bundle.includes(a.key)}
                onToggle={() =>
                  setBundle((b) =>
                    b.includes(a.key) ? b.filter((k) => k !== a.key) : [...b, a.key],
                  )
                }
                label={a.label}
                sub={a.detail}
              />
            ))}
            {row && row.alsoDue.length === 0 ? (
              <p className="px-1 text-[11.5px] text-nw-text-3">
                Nothing else is due on this truck within 30 days.
              </p>
            ) : null}
          </div>
        </Field>

        {/* Where the truck will be */}
        <Field label="Where the truck will be" small="from Dispatch">
          <div className="flex items-center overflow-x-auto">
            <RoutePoint
              icon={<MapPin className="size-[15px]" aria-hidden />}
              head="Now"
              text={row?.location ? `${row.location.city}, ${row.location.state}` : 'unknown'}
            />
            {(row?.route ?? []).map((stop, i) => (
              <span key={`${stop.loadNumber}-${i}`} className="contents">
                <span className="h-[1.5px] min-w-3 flex-1 bg-nw-border-strong" />
                <RoutePoint
                  on={i === 0}
                  icon={<Package className="size-[15px]" aria-hidden />}
                  head={`${stopDay(stop.at)} ${formatTime(stop.at)}`}
                  text={`${stop.kind === 'delivery' ? 'Delivers' : 'Picks up'} ${stop.city}, ${stop.state}`}
                />
              </span>
            ))}
            {row && row.route.length === 0 ? (
              <>
                <span className="h-[1.5px] min-w-3 flex-1 bg-nw-border-strong" />
                <RoutePoint
                  icon={<Package className="size-[15px]" aria-hidden />}
                  head="Next"
                  text="No load assigned"
                />
              </>
            ) : null}
          </div>
        </Field>

        {/* Shop */}
        <Field
          label="Shop"
          required
          small={
            row?.nextStop
              ? `near the ${row.nextStop.city} ${row.nextStop.kind} · your prices`
              : 'your prices'
          }
        >
          <div className="grid gap-1.5">
            {suggested.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickShop(s)}
                aria-pressed={vendorId === s.id}
                className={cn(
                  'grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] bg-nw-field px-[11px] py-[9px] text-left ring-1 ring-nw-border-strong ring-inset',
                  vendorId === s.id && 'bg-nw-accent-tint ring-[1.5px] ring-nw-accent',
                )}
              >
                <span
                  className={cn(
                    'grid size-[22px] place-items-center rounded-md bg-nw-subtle text-nw-text-3',
                    vendorId === s.id && 'bg-nw-accent text-nw-on-accent',
                  )}
                >
                  {vendorId === s.id ? (
                    <Check className="size-[13px]" aria-hidden />
                  ) : (
                    <Store className="size-[13px]" aria-hidden />
                  )}
                </span>
                <span className="min-w-0">
                  <b className="block truncate text-[13px] text-nw-text">{shopLabel(s)}</b>
                  <span className="block truncate text-[11.5px] text-nw-text-3">
                    {s.visits
                      ? `${s.visits} ${s.visits === 1 ? 'visit' : 'visits'}`
                      : 'no visits yet'}
                    {seesCost && s.avgPrice !== null && s.avgPrice !== undefined
                      ? ` · avg ${formatMoney(s.avgPrice)}`
                      : ''}
                    {s.lastVisitAt ? ` · last ${shortDate(s.lastVisitAt)}` : ''}
                    {s.isOwnYard ? ' · our own yard' : ''}
                  </span>
                </span>
                <span className="text-right">
                  <b className="block text-[13px] text-nw-text">
                    {seesCost && s.lastPrice !== null && s.lastPrice !== undefined
                      ? formatMoney(s.lastPrice)
                      : s.isOwnYard
                        ? 'Own yard'
                        : ''}
                  </b>
                  <span className="text-[11.5px] text-nw-text-3">
                    {s.isOwnYard ? 'no invoice' : (s.state ?? '')}
                  </span>
                </span>
              </button>
            ))}
            <Select
              aria-label="Any shop"
              options={shops.map((s) => ({ value: s.id, label: shopLabel(s) }))}
              value={vendorId}
              onValueChange={setVendorId}
              placeholder={
                shops.length ? 'Any other shop…' : 'No shops yet — add one under Vendors'
              }
            />
          </div>
        </Field>

        <div className="grid gap-2.5 md:grid-cols-2">
          <Field label="Date and time" required>
            <label className="flex h-9 items-center gap-2 rounded-lg bg-nw-field px-2.5 text-[13.5px] text-nw-text ring-1 ring-nw-border-strong ring-inset focus-within:ring-[1.5px] focus-within:ring-nw-accent">
              <Calendar className="size-[15px] text-nw-text-3" aria-hidden />
              <input
                type="datetime-local"
                aria-label="Date and time"
                value={when}
                min={`${companyToday()}T00:00`}
                onChange={(e) => setWhen(e.target.value)}
                className="w-full bg-transparent outline-none"
              />
              <span className="rounded-[5px] bg-nw-accent-tint px-1.5 py-0.5 text-[11px] font-bold text-nw-accent-ink">
                {tzShort()}
              </span>
            </label>
          </Field>
          <Field label="Responsible" required>
            <Select
              aria-label="Responsible"
              options={assignees.map((a) => ({ value: a.id, label: a.name }))}
              value={responsible}
              onValueChange={setResponsible}
              placeholder="Who follows it up"
            />
          </Field>
        </div>

        <div className="grid gap-2.5 md:grid-cols-2">
          <Field
            label="Estimated cost"
            small={seesCost ? "shop's last price" : 'hidden for your role'}
          >
            <label
              className={cn(
                'flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13.5px] ring-1 ring-nw-border-strong ring-inset',
                seesCost ? 'bg-nw-field text-nw-text' : 'bg-nw-subtle text-nw-text-2',
              )}
            >
              <span className="text-nw-text-3">$</span>
              <input
                type="number"
                min={0}
                step="0.01"
                aria-label="Estimated cost"
                disabled={!seesCost}
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                placeholder={seesCost ? '0.00' : '—'}
                className="w-full bg-transparent outline-none disabled:opacity-60"
              />
            </label>
          </Field>
          <Field label="Notify">
            <button
              type="button"
              aria-pressed={notify}
              onClick={() => setNotify((v) => !v)}
              className="flex h-9 w-full items-center gap-2 rounded-lg bg-nw-field px-2.5 text-left text-[13.5px] text-nw-text ring-1 ring-nw-border-strong ring-inset"
            >
              <span
                className={cn(
                  'grid size-4 place-items-center rounded-xs bg-nw-field ring-[1.5px] ring-nw-border-strong ring-inset',
                  notify && 'bg-nw-accent text-nw-on-accent ring-nw-accent',
                )}
              >
                {notify ? <Check className="size-3" aria-hidden /> : null}
              </span>
              Driver + dispatcher
              <span className="ml-auto text-nw-text-3">Telegram</span>
            </button>
          </Field>
        </div>

        <Field label="Note for the shop" optional>
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Hours the driver has, what to quote on the same visit…"
          />
        </Field>

        {error ? <p className="text-sm text-nw-urgent-text">{error}</p> : null}

        <AutoBox>
          <AutoLine family="moving">
            {existing
              ? `The appointment on ${existing.workOrderNumber} moves`
              : 'Appointment goes on a new work order'}
            , status "Scheduled into a shop".
            <small>The shop, time and responsible person are on the row from now on.</small>
          </AutoLine>
          <AutoLine
            family={
              row && (row.dueStatus === 'overdue' || row.dueStatus === 'overdue_at_least')
                ? 'urgent'
                : 'info'
            }
          >
            {row ? (
              <>
                {row.unitNumber} still shows <b>{dueWord(row)}</b> until the oil change is recorded.
              </>
            ) : (
              'The unit keeps its due status until the oil change is recorded.'
            )}
            <small>
              Booking is not fixing. The due status only changes on a completed service.
            </small>
          </AutoLine>
          <AutoLine family="info">
            Dispatch sees a {PM_DEFAULT_HOLD_MINUTES / 60}-hour hold
            {holdEnd && whenIso
              ? ` at ${formatTime(whenIso)}–${formatTime(holdEnd)} ${stopDay(whenIso).toLowerCase()}`
              : ''}
            {notify
              ? `, and ${responsibleName ?? 'the responsible person'} gets the address.`
              : '.'}
            <small>
              {notify
                ? `${row?.driverName ?? 'The driver'} gets the shop location and time on Telegram.`
                : 'Nobody is notified.'}
            </small>
          </AutoLine>
        </AutoBox>
      </div>
    </Drawer>
  );
}

function RoutePoint({
  icon,
  head,
  text,
  on,
}: {
  icon: ReactNode;
  head: string;
  text: string;
  on?: boolean;
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 grid-cols-[16px_auto] items-center gap-x-[7px] rounded-[9px] bg-nw-field px-[11px] py-2 text-xs whitespace-nowrap text-nw-text-2 ring-1 ring-nw-border-strong ring-inset [&>svg]:row-span-2 [&>svg]:text-nw-text-3',
        on &&
          'bg-nw-accent-tint text-nw-accent-ink ring-[1.5px] ring-nw-accent [&>svg]:text-nw-accent-ink',
      )}
    >
      {icon}
      <b
        className={cn(
          'text-[11px] font-bold tracking-[.03em] text-nw-text-3 uppercase',
          on && 'text-nw-accent-ink',
        )}
      >
        {head}
      </b>
      <span>{text}</span>
    </span>
  );
}

function headline(row: PmBoardRow): string {
  if (row.dueStatus === 'overdue' || row.dueStatus === 'overdue_at_least')
    return `${row.unitNumber} is ${dueWord(row).replace('Overdue ', '')} over. Book it where the truck will be, not where it is now.`;
  if (row.dueStatus === 'due_soon')
    return `${row.unitNumber} has ${n(row.milesRemaining ?? 0)} mi left. Book it where the truck will be, not where it is now.`;
  return `${row.unitNumber}. Book it where the truck will be, not where it is now.`;
}

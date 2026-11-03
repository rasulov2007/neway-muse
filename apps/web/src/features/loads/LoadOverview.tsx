import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CircleCheck,
  FileText,
  MapPin,
  MapPinned,
  Package,
  Phone,
  Pin,
  Plus,
  Send,
  Upload,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  HOME_ZONE,
  LOADS_CONFIG,
  NIGHT_DESK_ZONE,
  detentionAt,
  documentExpected,
  formatInstant,
  timeInZone,
  driverRateOf,
  hasDriverRate,
} from '@neway/shared';
import {
  addLoadNote,
  confirmStopAppointment,
  loadWriteMessage,
  recordCheckCall,
  type Driver,
  type Load,
  type LoadNote,
  type Stop,
  type Truck,
} from '@/demo';
import { Badge, Button, Card, Checkbox, Input, cn, useToast } from '@/design-system';
import { formatMoney, formatPhone, formatRpm } from '@/lib/format';
import { EQUIPMENT_LABEL } from './loadUtils';
import { AssignDriverDialog } from './AssignDriverDialog';
import { useAccount } from '@/features/auth/auth-context';
import { now as clockNow } from '@/lib/clock';

/*
 * The load page, laid out the way the owner drew it (2026-09-25): the journey across the top,
 * the route and the activity on the left, the people, the instructions, the paperwork and the
 * money on the right. Every number here is read off the record; nothing is stored twice.
 */

type EventKind = 'arrived' | 'loaded' | 'departed' | 'check_call' | 'eta_changed';
export type OpenEvent = (initial: { kind?: EventKind; stopId?: string }) => void;

// ------------------------------------------------------------------ the facts and what is next

/** One line of what this load is: who, reference, route, miles, equipment, money. */
export function LoadFacts({ load }: { load: Load }) {
  const cities = load.stops.map((s) => `${s.city}, ${s.state}`);
  // What the broker is billed (owner, 2026-11-02: a $208 lumper on L-100049 still read $1,900):
  // the linehaul plus accepted billable accessorials. Drafts and dropped charges are not money yet.
  const extras = (load.charges ?? [])
    .filter((c) => c.type !== 'linehaul' && c.billable && (c.status ?? 'accepted') === 'accepted')
    .reduce((sum, c) => sum + c.amount, 0);
  const parts: ReactNode[] = [
    <span key="who" className="font-semibold text-ink">{load.customerName}</span>,
    load.brokerName ? `via ${load.brokerName}` : 'direct, no broker',
    load.brokerReference || null,
    cities.join(' → '),
    `${load.loadedMiles.toLocaleString()} loaded mi${load.emptyMiles ? ` + ${load.emptyMiles} empty` : ''}`,
    `${load.equipmentType ? (EQUIPMENT_LABEL[load.equipmentType] ?? load.equipmentType) : 'Equipment not given'}${load.pieces ? ` · ${load.pieces} pcs` : ''}${load.weightLbs ? ` · ${load.weightLbs.toLocaleString()} lb` : ''}`,
    <span key="rate" className="font-semibold text-ink" title={extras > 0 ? `Linehaul ${formatMoney(load.rate)} + accessorials ${formatMoney(extras)}` : undefined}>
      {formatMoney(load.rate + extras)}
      {extras > 0 ? <span className="font-normal text-secondary"> ({formatMoney(load.rate)} + {formatMoney(extras)})</span> : null}
    </span>,
  ].filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 ? <span aria-hidden className="size-1 rounded-full bg-line-strong" /> : null}
          {p}
        </span>
      ))}
    </p>
  );
}

interface NextAction {
  title: string;
  detail: string;
  due: string | null;
  dueZone: string | null | undefined;
  then: string | null;
  action: { label: string; initial?: { kind?: EventKind; stopId?: string }; tab?: 'documents'; board?: boolean } | null;
}

/** What has to happen next on this load, in one sentence, with the button that does it. */
function nextFor(load: Load, nowIso: string): NextAction | null {
  const pickup = load.stops.find((s) => s.kind === 'pickup') ?? null;
  const next = load.stops.find((s) => s.status !== 'completed') ?? null;
  const name = (s: Stop | null) => s?.facilityName || s?.city || 'the stop';
  const driver = load.driverName?.split(' ')[0] ?? 'The driver';
  const free = (s: Stop) => s.freeTimeMinutes ?? LOADS_CONFIG.freeTimeMinutes;
  switch (load.status) {
    case 'booked':
      return { title: 'Assign a driver and truck', detail: 'The load is booked and nobody is on it yet.', due: pickup?.appointmentStartAt ?? null, dueZone: pickup?.timezone, then: 'Dispatch', action: { label: 'Open the Daily Board', board: true } };
    case 'assigned':
      return { title: `Dispatch ${driver}`, detail: `${load.driverName ?? 'The driver'} and ${load.truckUnit ? `unit ${load.truckUnit}` : 'the truck'} are on the load; the load sheet has not gone out.`, due: pickup?.appointmentStartAt ?? null, dueZone: pickup?.timezone, then: 'Record arrival at the shipper', action: { label: 'Set DISPATCHED on the board', board: true } };
    case 'dispatched':
      // At the shipper only the departure is recorded, with its BOL (owner, 2026-10-13).
      return { title: `Record departure from ${name(pickup)} with the BOL`, detail: `${driver} is dispatched. The pickup window opens ${timeInZone(pickup?.appointmentStartAt, pickup?.timezone)}.`, due: pickup?.appointmentStartAt ?? null, dueZone: pickup?.timezone, then: `Record arrival at ${name(next?.kind === 'delivery' ? next : null)}`, action: { label: 'Record departure', initial: { kind: 'departed', stopId: pickup?.id } } };
    case 'at_pickup': {
      if (!pickup) return null;
      const onSite = pickup.arrivedAt ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(pickup.arrivedAt)) / 60_000)) : null;
      const ends = pickup.arrivedAt ? new Date(Math.max(Date.parse(pickup.arrivedAt), Date.parse(pickup.appointmentStartAt) || 0) + free(pickup) * 60_000).toISOString() : null;
      const source = pickup.freeTimeMinutes ? 'rate-con figure' : 'default';
      return {
        title: 'Record departure with the BOL',
        detail: `${driver} arrived at ${timeInZone(pickup.arrivedAt, pickup.timezone)}${onSite !== null ? ` and has been on site for ${onSite} min` : ''}. The pickup window closes at ${timeInZone(pickup.appointmentEndAt, pickup.timezone)}.${ends ? ` Free time ends at ${timeInZone(ends, pickup.timezone)}, using a ${free(pickup) / 60}-hour ${source}.` : ''}`,
        due: pickup.appointmentEndAt,
        dueZone: pickup.timezone,
        then: `Record arrival at ${name(next?.kind === 'delivery' ? next : null)}`,
        action: { label: 'Record departure', initial: { kind: 'departed', stopId: pickup.id } },
      };
    }
    case 'loaded':
      return { title: `Record departure from ${name(pickup)}`, detail: `Loaded at ${timeInZone(pickup?.loadedAt, pickup?.timezone)}. The load is In transit once it rolls; the detention clock runs until then.`, due: null, dueZone: pickup?.timezone, then: `Record arrival at ${name(next?.kind === 'delivery' ? next : null)}`, action: { label: 'Record departure', initial: { kind: 'departed', stopId: pickup?.id } } };
    case 'in_transit':
      return { title: `Record arrival at ${name(next)}`, detail: `${driver} is on the road${load.etaAt ? `, ETA ${timeInZone(load.etaAt, next?.timezone)}` : ''}. The window opens ${timeInZone(next?.appointmentStartAt, next?.timezone)}.`, due: next?.appointmentStartAt ?? null, dueZone: next?.timezone, then: 'Record departure and upload the POD', action: { label: 'Record arrival', initial: { kind: 'arrived', stopId: next?.id } } };
    case 'at_delivery':
    case 'unloading': {
      const stop = load.stops.find((s) => s.kind === 'delivery' && s.status === 'in_progress') ?? next;
      const remaining = load.stops.filter((s) => s.kind === 'delivery' && s.status !== 'completed' && s.id !== stop?.id).length;
      const more = remaining === 0 ? ' This is the last delivery.' : remaining === 1 ? ' 1 more delivery after this one.' : ` ${remaining} more deliveries after this one.`;
      return { title: 'Record departure and upload the POD', detail: `${driver} arrived at ${name(stop)} at ${timeInZone(stop?.arrivedAt, stop?.timezone)}.${more}`, due: stop?.appointmentEndAt ?? null, dueZone: stop?.timezone, then: remaining > 0 ? 'Record arrival at the next stop' : 'Review the PODs and bill', action: { label: 'Record departure', initial: { kind: 'departed', stopId: stop?.id } } };
    }
    case 'delivered':
      return { title: load.invoiceId ? 'Invoiced · close the load' : 'Review the PODs and bill', detail: `Delivered ${timeInZone(load.deliveredAt, load.stops.at(-1)?.timezone)}. Billing needs every POD reviewed and the accessorials decided.`, due: null, dueZone: null, then: null, action: { label: 'Open documents', tab: 'documents' } };
    default:
      return null;
  }
}

export function NextPanel({ load, onRecord, onDocuments }: { load: Load; onRecord: OpenEvent; onDocuments: () => void }) {
  const nowIso = clockNow().toISOString();
  const next = nextFor(load, nowIso);
  if (!next) return null;
  const owner = ownerNow(load);
  const late = next.due !== null && Date.parse(next.due) < Date.parse(nowIso);
  return (
    <section
      aria-label="Next"
      className={cn('flex flex-wrap items-center gap-4 rounded-lg border px-4 py-3', late ? 'border-danger-border bg-danger-soft' : 'border-warning-border bg-warning-soft')}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className={cn('eyebrow', late ? 'text-danger-text' : 'text-warning-text')}>{late ? 'Late' : 'Next'}</span>
          <span className="text-sm font-semibold text-ink">{next.title}</span>
        </p>
        <p className="mt-0.5 text-xs text-secondary">{next.detail}</p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
          <span>
            Owner <span className="font-semibold text-ink">{owner.name}</span>
          </span>
          {next.due ? (
            <span>
              Due <span className="font-semibold text-ink">{timeInZone(next.due, next.dueZone)}</span> · {timeInZone(next.due, HOME_ZONE)} · {timeInZone(next.due, NIGHT_DESK_ZONE)}
            </span>
          ) : null}
          {next.then ? (
            <span>
              Then <span className="font-semibold text-ink">{next.then}</span>
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {['dispatched', 'at_pickup', 'loaded', 'in_transit', 'at_delivery', 'unloading'].includes(load.status) ? (
          <Button variant="secondary" size="sm" icon={<Phone />} onClick={() => onRecord({ kind: 'check_call' })}>
            Add check call
          </Button>
        ) : null}
        {next.action?.board ? (
          <Link to="/dispatch/daily" className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-semibold text-inverse hover:opacity-90">
            {next.action.label}
          </Link>
        ) : next.action?.tab ? (
          <Button variant="primary" size="sm" onClick={onDocuments}>
            {next.action.label}
          </Button>
        ) : next.action ? (
          <Button variant="primary" size="sm" icon={<CircleCheck />} onClick={() => onRecord(next.action!.initial ?? {})}>
            {next.action.label}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ journey

interface Step {
  key: string;
  label: string;
  sub: string | null;
  state: 'done' | 'current' | 'todo';
  billing?: boolean;
}

const ORDER = ['booked', 'assigned', 'dispatched', 'at_pickup', 'loaded', 'in_transit'] as const;

function firstEventAt(load: Load, kinds: string[], stopId?: string): string | null {
  const e = load.timeline.find((t) => kinds.includes(t.kind) && (!stopId || t.stopId === stopId));
  return e?.at ?? null;
}

function when(at: string | null, zone: string | null | undefined): string | null {
  if (!at) return null;
  const f = formatInstant(at, zone ?? HOME_ZONE);
  return `${f.day} · ${f.time}`;
}

/** The steps this load walks, one per delivery, from the record. */
function stepsFor(load: Load): Step[] {
  const pickup = load.stops.find((s) => s.kind === 'pickup') ?? null;
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  // Where the load stands on the ladder. Every live status has a rung, so a load at its delivery
  // shows everything before it done (owner, 2026-10-13: the steps went grey at the receiver).
  const RUNG: Partial<Record<string, number>> = {
    booked: 0, assigned: 1, dispatched: 2, at_pickup: 3, loading: 3, loaded: 4, in_transit: 5, at_delivery: 6, unloading: 6, delivered: 7, closed: 7,
  };
  const rank = RUNG[load.status] ?? ORDER.indexOf(load.status as (typeof ORDER)[number]);
  const closed = load.status === 'closed';
  const delivered = load.status === 'delivered' || closed;
  const past = (i: number) => delivered || rank > i;
  const bol = load.documents.some((d) => d.type === 'bol' && d.status !== 'missing');
  const pods = load.documents.filter((d) => d.type === 'pod' && d.status !== 'missing').length;

  const base: Step[] = [
    { key: 'booked', label: 'Booked', sub: when(firstEventAt(load, ['booked']) ?? load.createdAt ?? null, HOME_ZONE), state: 'done' },
    {
      key: 'assigned',
      label: 'Assigned',
      sub: load.truckUnit ? `${load.truckUnit}${load.trailerUnit ? ` · ${load.trailerUnit}` : ''}` : 'no truck yet',
      state: past(1) ? 'done' : rank === 1 ? 'current' : 'todo',
    },
    { key: 'dispatched', label: 'Dispatched', sub: when(load.dispatchedAt, HOME_ZONE), state: past(2) ? 'done' : rank === 2 ? 'current' : 'todo' },
    {
      key: 'at_pickup',
      label: 'At pickup',
      sub: pickup?.arrivedAt ? `Arrived ${timeInZone(pickup.arrivedAt, pickup.timezone)}` : null,
      state: past(3) ? 'done' : rank === 3 ? 'current' : 'todo',
    },
    {
      key: 'loaded',
      label: 'Loaded',
      sub: pickup?.loadedAt ? timeInZone(pickup.loadedAt, pickup.timezone) : bol ? 'BOL on file' : 'BOL needed',
      state: past(4) ? 'done' : rank === 4 ? 'current' : 'todo',
    },
    {
      key: 'in_transit',
      label: 'In transit',
      sub: pickup?.departedAt ? `Left ${timeInZone(pickup.departedAt, pickup.timezone)}` : 'after departure',
      state: past(5) || (rank === 5 && deliveries.some((d) => d.status !== 'pending')) ? 'done' : rank === 5 ? 'current' : 'todo',
    },
  ];
  const stopSteps: Step[] = deliveries.map((d, i) => {
    const active = ['at_delivery', 'unloading'].includes(load.status) && d.status === 'in_progress';
    const done = d.status === 'completed' || delivered;
    return {
      key: d.id,
      label: `At ${d.city || d.facilityName}`,
      sub: done && d.departedAt ? `Done ${timeInZone(d.departedAt, d.timezone)}` : `stop ${i + 2} · ${formatInstant(d.appointmentStartAt, d.timezone).weekday.replace(/^(\w{3}), /, '$1 ')} ${timeInZone(d.appointmentStartAt, d.timezone)}`,
      state: done ? 'done' : active ? 'current' : 'todo',
    };
  });
  const tail: Step[] = [
    {
      key: 'delivered',
      label: 'Delivered',
      sub: load.deliveredAt ? when(load.deliveredAt, deliveries.at(-1)?.timezone) : `POD × ${deliveries.length}${pods ? ` · ${pods} on file` : ''}`,
      state: delivered ? 'done' : 'todo',
    },
    {
      key: 'billing',
      label: 'Billing',
      sub: load.invoiceId ? `Invoice ${load.invoiceId}` : closed ? 'closed' : 'review → invoice',
      state: closed || load.invoiceId ? 'done' : delivered ? 'current' : 'todo',
      billing: true,
    },
  ];
  const steps = [...base, ...stopSteps, ...tail];
  if (load.status === 'cancelled' || load.status === 'tonu') return steps.map((s) => ({ ...s, state: s.key === 'booked' ? 'done' : 'todo' }));
  return steps;
}

export function LoadJourney({ load }: { load: Load }) {
  // A cancelled load has no journey left: the word stands where the steps were (owner, 2026-10-13).
  if (load.status === 'cancelled') {
    return (
      <Card padding="sm" aria-label="Journey" data-testid="cancelled-journey">
        <div className="flex h-[92px] items-center justify-center overflow-hidden">
          <span className="text-[56px] leading-none font-extrabold tracking-[0.18em] text-nw-urgent-text opacity-25 select-none">
            CANCELLED
          </span>
        </div>
      </Card>
    );
  }
  const steps = stepsFor(load);
  return (
    <Card padding="sm" aria-label="Journey">
      <ol className="scroll-quiet flex items-start overflow-x-auto px-2 pt-1 pb-2">
        {steps.map((step, i) => (
          <li key={step.key} className={cn('flex items-start', i > 0 && 'flex-1')}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'mx-2 mt-3.5 h-0.5 min-w-6 flex-1 rounded-full',
                  step.billing ? 'border-t-2 border-dashed border-warning-border bg-transparent' : step.state === 'todo' ? 'bg-line-strong' : 'bg-success',
                )}
              />
            ) : null}
            <span className="flex w-24 shrink-0 flex-col items-center gap-1 text-center">
              {/* Where the load is now stands out (owner, 2026-10-13): filled accent with a soft,
                  breathing halo, so it never reads as a step already done. */}
              <span className="relative flex size-7 items-center justify-center" aria-current={step.state === 'current' && !step.billing ? 'step' : undefined}>
                {step.state === 'current' && !step.billing ? (
                  <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary opacity-30 motion-reduce:animate-none" />
                ) : null}
                <span
                  className={cn(
                    'relative flex size-7 items-center justify-center rounded-full text-xs font-bold',
                    step.state === 'done' && 'bg-success text-inverse',
                    step.state === 'current' && !step.billing && 'bg-primary text-inverse shadow-md ring-4 ring-primary/25',
                    step.state === 'todo' && 'bg-neutral-soft text-faint',
                    step.billing && step.state !== 'done' && 'bg-surface text-warning-text ring-2 ring-dashed ring-warning-border',
                  )}
                >
                  {step.state === 'done' ? <CircleCheck className="size-4" /> : step.billing ? '$' : i + 1}
                </span>
              </span>
              <span
                className={cn(
                  'text-xs font-semibold whitespace-nowrap',
                  step.state === 'todo' ? 'text-faint' : step.state === 'current' && !step.billing ? 'font-bold text-primary-text' : 'text-ink',
                )}
              >
                {step.label}
              </span>
              {step.sub ? <span className="text-2xs leading-tight text-muted">{step.sub}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ------------------------------------------------------------------ route

function Row({ label, children, tone }: { label: string; children: ReactNode; tone?: 'warning' | 'muted' }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className={cn('font-medium', tone === 'warning' ? 'text-warning-text' : tone === 'muted' ? 'text-muted' : 'text-ink')}>{children}</span>
    </div>
  );
}

/** The window in one clock: `12:30–2:30 PM MDT`, or the single time when there is no window. */
function windowText(stop: Stop, zone: string | null | undefined): string {
  const start = timeInZone(stop.appointmentStartAt, zone);
  if (stop.appointmentNoWindow || stop.appointmentEndAt === stop.appointmentStartAt) return start;
  return `${start.replace(/ [A-Z+\d-]+$/, '')}–${timeInZone(stop.appointmentEndAt, zone)}`;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
}

/** When free time runs out at this stop: the later of arrival and appointment, plus free time. */
function freeTimeEnds(stop: Stop): string | null {
  if (!stop.arrivedAt) return null;
  const start = Math.max(Date.parse(stop.arrivedAt), Date.parse(stop.appointmentStartAt) || 0);
  return new Date(start + (stop.freeTimeMinutes ?? LOADS_CONFIG.freeTimeMinutes) * 60_000).toISOString();
}

/** "Confirm by": the appointment minus the lead time the pinned instructions ask for. */
function confirmBy(stop: Stop, notes: LoadNote[]): string | null {
  const pinned = notes.filter((n) => n.pinned).map((n) => n.body);
  const m = pinned.map((b) => /(\d+)\s*h(?:ours?)?\s+ahead/i.exec(b)).find(Boolean);
  if (!m) return null;
  return new Date(Date.parse(stop.appointmentStartAt) - Number(m[1]) * 3_600_000).toISOString();
}

export function RoutePanel({
  load,
  onRecord,
  onTracking,
}: {
  load: Load;
  onRecord: OpenEvent;
  onTracking: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const nowIso = clockNow().toISOString();
  const live = !['cancelled', 'tonu', 'closed'].includes(load.status);
  const confirm = useMutation({
    mutationFn: (stopId: string) => confirmStopAppointment(load.id, stopId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['load'] });
      toast({ tone: 'success', title: 'Appointment confirmed' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: loadWriteMessage(e, 'Could not confirm the appointment.') }),
  });
  const pending = load.stops.find((s) => s.status !== 'completed') ?? null;
  return (
    <Card
      title="Route"
      description={`${load.stops.length} stops · times are local to each stop, with Eastern and Tashkent underneath`}
      actions={
        <Button variant="link" size="sm" icon={<MapPinned />} onClick={onTracking}>
          Map
        </Button>
      }
      padding="none"
    >
      <ol aria-label="Stops" className="divide-y divide-line-soft">
        {load.stops.map((stop, i) => {
          const isPending = pending?.id === stop.id;
          const onSite = stop.status === 'in_progress' && stop.arrivedAt && !stop.departedAt;
          const ends = onSite ? freeTimeEnds(stop) : null;
          const by = stop.kind === 'delivery' ? confirmBy(stop, load.notes) : null;
          const detention = stop.departedAt && stop.arrivedAt ? detentionAt(stop, stop.departedAt) : null;
          return (
            <li key={stop.id} className={cn('grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,2fr)_minmax(0,2fr)_auto]', isPending && live && 'bg-primary-soft/40')}>
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-md border text-xs font-bold',
                  stop.status === 'completed' ? 'border-success bg-success-soft text-success-text' : isPending && live ? 'border-primary text-primary-text' : 'border-line text-muted',
                )}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="eyebrow">
                  {stop.kind === 'pickup' ? 'Pickup' : 'Delivery'}
                  {stop.kind === 'delivery' && i === load.stops.length - 1 ? ' · final' : ''}
                  {stop.status === 'in_progress' ? ' · in progress' : stop.status === 'completed' ? ' · done' : ''}
                </p>
                <p className="text-sm font-semibold text-ink">{stop.facilityName || `${stop.city}, ${stop.state}`}</p>
                {stop.address ? <p className="text-xs text-muted">{stop.address}</p> : null}
                <p className="text-xs text-muted">
                  {stop.city}, {stop.state} · {stop.timezone ? stop.timezone.split('/').pop()?.replace(/_/g, ' ') : 'zone unknown'} time
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {/* Window and Times are the same label/value rows, so each line sits level with its neighbour. */}
                <p className="eyebrow">Window</p>
                <Row label={formatInstant(stop.appointmentStartAt, stop.timezone).weekday}>{windowText(stop, stop.timezone)}</Row>
                <Row label="Eastern" tone="muted">{windowText(stop, HOME_ZONE)}</Row>
                <Row label="Tashkent" tone="muted">{windowText(stop, NIGHT_DESK_ZONE)}</Row>
                {stop.kind === 'delivery' ? <Row label="Appt #" tone="muted">{stop.notes?.match(/appt[^\d]*(\S+)/i)?.[1] ?? '—'}</Row> : null}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {/* The same eyebrow height as Window, so Arrived sits on the window's row. */}
                <p className="eyebrow">Times</p>
                {by && !stop.appointmentConfirmedAt ? (
                  <Row label="Confirm by" tone="warning">{formatInstant(by, stop.timezone).weekday.slice(0, 3)} {timeInZone(by, stop.timezone)}</Row>
                ) : stop.appointmentConfirmedAt ? (
                  <Row label="Confirmed">{timeInZone(stop.appointmentConfirmedAt, stop.timezone)}</Row>
                ) : null}
                <Row label="Arrived" tone={stop.arrivedAt ? undefined : 'muted'}>{stop.arrivedAt ? timeInZone(stop.arrivedAt, stop.timezone) : '—'}</Row>
                {onSite ? <Row label="On site">{minutesBetween(stop.arrivedAt!, nowIso)} min</Row> : null}
                {ends ? (
                  <Row label="Free time" tone={Date.parse(ends) < Date.parse(nowIso) ? 'warning' : undefined}>
                    {Date.parse(ends) < Date.parse(nowIso) ? `ran out ${timeInZone(ends, stop.timezone)}` : `to ${timeInZone(ends, stop.timezone)}`}
                  </Row>
                ) : null}
                {stop.kind === 'pickup' ? (
                  <Row label="Loaded" tone={stop.loadedAt ? undefined : 'muted'}>{stop.loadedAt ? timeInZone(stop.loadedAt, stop.timezone) : '—'}</Row>
                ) : null}
                <Row label="Departed" tone={stop.departedAt ? undefined : 'muted'}>{stop.departedAt ? timeInZone(stop.departedAt, stop.timezone) : '—'}</Row>
                {detention && detention.minutes > 0 ? <Row label="Detention" tone="warning">{detention.minutes} min · {formatMoney(detention.amount)} draft</Row> : null}
              </div>
              <div className="flex flex-col items-stretch gap-2 md:items-end">
                {live && stop.status !== 'completed' ? (
                  <>
                    {/* At the shipper only the departure, which asks for the BOL; at the receiver the
                        arrival, then the departure, which asks for the POD (owner, 2026-10-13). */}
                    {stop.kind === 'delivery' && !stop.arrivedAt ? (
                      <Button variant={isPending ? 'primary' : 'secondary'} size="sm" onClick={() => onRecord({ kind: 'arrived', stopId: stop.id })}>
                        Record arrival
                      </Button>
                    ) : null}
                    {stop.kind === 'pickup' || stop.arrivedAt ? (
                      <Button variant={stop.kind === 'pickup' && isPending ? 'primary' : 'secondary'} size="sm" onClick={() => onRecord({ kind: 'departed', stopId: stop.id })} data-testid={`depart-${stop.id}`}>
                        Record departure
                      </Button>
                    ) : null}
                    {stop.kind === 'delivery' && !stop.arrivedAt && !stop.appointmentConfirmedAt ? (
                      <Button variant="outline" size="sm" icon={<CircleCheck />} loading={confirm.isPending && confirm.variables === stop.id} onClick={() => confirm.mutate(stop.id)}>
                        Confirm appt
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ------------------------------------------------------------------ people and equipment

function Person({ label, name, detail, href }: { label: string; name: ReactNode; detail?: ReactNode; href?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right">
        <span className="block text-sm font-semibold text-ink">{href ? <a href={href} className="hover:underline">{name}</a> : name}</span>
        {detail ? <span className="block text-xs text-muted">{detail}</span> : null}
      </span>
    </div>
  );
}

/** Who answers for the load right now (rule 1.7): the dispatcher until the truck leaves the pickup, then the updater. */
function ownerNow(load: Load): { name: string; until: string } {
  const pickup = load.stops.find((s) => s.kind === 'pickup');
  const rolling = ['in_transit', 'at_delivery', 'unloading'].includes(load.status) || Boolean(pickup?.departedAt);
  if (rolling && load.updaterName) return { name: load.updaterName, until: 'until the load is delivered' };
  return {
    name: load.dispatcherName,
    until: load.updaterName ? `until the truck departs ${pickup?.city ?? 'the shipper'} · then ${load.updaterName}` : 'no updater named',
  };
}

export function PeoplePanel({ load, driver, truck }: { load: Load; driver: Driver | null; truck: Truck | null }) {
  const owner = ownerNow(load);
  const canEdit = useAccount()?.permissions.includes('loads.edit') ?? false;
  const [assigning, setAssigning] = useState(false);
  // An unassigned load gets its driver right here (owner, 2026-10-20); a billed or finished one does not.
  const canAssign = canEdit && !load.driverId && !load.invoiceId && !['delivered', 'closed', 'cancelled'].includes(load.status);
  return (
    <Card title="People and equipment" padding="sm">
      {assigning ? <AssignDriverDialog load={load} onClose={() => setAssigning(false)} /> : null}
      <div className="divide-y divide-line-soft px-1">
        <Person
          label="Driver"
          name={
            load.driverName ?? (
              <span className="inline-flex items-center gap-2">
                Unassigned
                {canAssign ? (
                  <Button size="sm" variant="primary" onClick={() => setAssigning(true)} data-testid="assign-driver">
                    Assign
                  </Button>
                ) : null}
              </span>
            )
          }
          detail={driver?.phone ? <span className="inline-flex items-center gap-1"><Phone className="size-3" aria-hidden /> {formatPhone(driver.phone)}</span> : null}
          href={load.driverId ? `/drivers/${load.driverId}` : undefined}
        />
        <Person label="Truck" name={load.truckUnit ? `Unit ${load.truckUnit}` : '—'} detail={truck ? `${truck.year} ${truck.make} ${truck.model}` : null} href={load.truckUnit ? `/fleet/trucks?unit=${encodeURIComponent(load.truckUnit)}` : undefined} />
        <Person label="Trailer" name={load.trailerUnit ?? '—'} detail={load.equipmentType} />
        <Person label="Dispatcher" name={load.dispatcherName} />
        {load.updaterName ? <Person label="Updater" name={load.updaterName} /> : null}
        <Person label="Owner now" name={<Badge tone="info" size="sm">{owner.name}</Badge>} detail={owner.until} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ instructions

export function InstructionsPanel({ load }: { load: Load }) {
  const pinned = load.notes.filter((n) => n.pinned);
  return (
    <Card title="Instructions" description="Pinned · shown to the driver when marked" padding="sm">
      <ul className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3">
        {pinned.map((n) => (
          <li key={n.id} className="flex gap-2 text-sm text-ink">
            <Pin className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            <span>
              {n.body}
              {n.kind === 'driver' ? <span className="ml-1 text-xs text-muted">· to the driver</span> : null}
            </span>
          </li>
        ))}
        <li className="flex gap-2 text-sm text-ink">
          <Package className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <span>
            {load.commodity || 'Freight'} · {load.pieces || '—'} pieces · {load.weightLbs ? `${load.weightLbs.toLocaleString()} lb` : '— lb'} · {load.equipmentType ? (EQUIPMENT_LABEL[load.equipmentType] ?? load.equipmentType) : '—'}
            {load.hazmat ? ' · hazmat' : ''}
          </span>
        </li>
        {pinned.length === 0 ? <li className="text-xs text-muted">Pin a note below and it shows here.</li> : null}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ activity

type Filter = 'all' | 'calls' | 'stops' | 'documents' | 'notes';
const CALLS = new Set(['check_call', 'eta_changed']);
const STOPS = new Set(['arrived', 'departed', 'loaded', 'delivered', 'status_changed', 'dispatched', 'assigned', 'booked', 'cancelled', 'recovered']);
const DOCS = new Set(['document_uploaded', 'document_reviewed', 'document_verified']);
const NOTES = new Set(['note_added', 'note_pinned']);

function category(kind: string): Exclude<Filter, 'all'> | null {
  if (CALLS.has(kind)) return 'calls';
  if (NOTES.has(kind)) return 'notes';
  if (DOCS.has(kind)) return 'documents';
  if (STOPS.has(kind)) return 'stops';
  return null;
}

function iconFor(kind: string): ReactNode {
  const c = category(kind);
  if (c === 'calls') return <Phone className="size-3.5" aria-hidden />;
  if (c === 'notes') return <Pin className="size-3.5" aria-hidden />;
  if (c === 'documents') return <FileText className="size-3.5" aria-hidden />;
  if (kind === 'dispatched') return <Send className="size-3.5" aria-hidden />;
  if (kind === 'booked') return <Plus className="size-3.5" aria-hidden />;
  return <MapPin className="size-3.5" aria-hidden />;
}

export function ActivityPanel({ load, author }: { load: Load; author: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'call' | 'note'>('call');
  const [text, setText] = useState('');
  const [visible, setVisible] = useState<'internal' | 'broker' | 'driver'>('internal');
  const [pin, setPin] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const live = !['cancelled', 'tonu', 'closed', 'delivered'].includes(load.status);

  const add = useMutation({
    mutationFn: async () => {
      const body = text.trim();
      if (mode === 'call' && live) {
        return recordCheckCall(load.id, { kind: 'check_call', at: clockNow().toISOString(), note: body });
      }
      return addLoadNote(load.id, { kind: visible, body, pinned: pin });
    },
    onSuccess: async () => {
      setText('');
      setPin(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['load'] }), queryClient.invalidateQueries({ queryKey: ['loads'] }), queryClient.invalidateQueries({ queryKey: ['operations'] })]);
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: loadWriteMessage(e, 'Could not add it.') }),
  });

  const items = useMemo(() => [...load.timeline].sort((a, b) => b.at.localeCompare(a.at)), [load.timeline]);
  const counts = { all: items.length, calls: 0, stops: 0, documents: 0, notes: 0 };
  for (const e of items) {
    const c = category(e.kind);
    if (c) counts[c] += 1;
  }
  const shown = items.filter((e) => filter === 'all' || category(e.kind) === filter);
  const notesById = new Map(load.notes.map((n) => [n.id, n]));

  return (
    <Card title="Activity" description="Newest first · check calls, stop events, documents and notes in one list" padding="none">
      <div className="flex flex-col gap-2 border-b border-line-soft px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-nw-subtle p-0.5 ring-1 ring-nw-border">
            {(['call', 'note'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn('h-7 rounded-md px-2.5 text-xs font-semibold', mode === m ? 'bg-nw-panel text-nw-text shadow-nw-segment' : 'text-nw-text-3')}
                disabled={m === 'call' && !live}
              >
                {m === 'call' ? 'Check call' : 'Note'}
              </button>
            ))}
          </div>
          <Input
            className="min-w-0 flex-1"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'call' ? "Where is the truck, what's happening, new ETA?" : 'A note for the file'}
            aria-label={mode === 'call' ? 'Check call' : 'Note'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim().length > 0 && !add.isPending) add.mutate();
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {mode === 'note' ? (
            <>
              <span className="text-xs text-muted">Visible to</span>
              <div className="inline-flex rounded-lg bg-nw-subtle p-0.5 ring-1 ring-nw-border">
                {([['internal', 'Internal'], ['broker', 'Customer'], ['driver', 'Driver']] as const).map(([v, l]) => (
                  <button key={v} type="button" aria-pressed={visible === v} onClick={() => setVisible(v)} className={cn('h-6 rounded-md px-2 text-xs font-semibold', visible === v ? 'bg-nw-panel text-nw-text shadow-nw-segment' : 'text-nw-text-3')}>
                    {l}
                  </button>
                ))}
              </div>
              <Checkbox checked={pin} onCheckedChange={(v) => setPin(v === true)} label="Pin for the next shift" />
            </>
          ) : (
            <span className="text-xs text-muted">Recorded as a check call from {author}; resets the update clock.</span>
          )}
          <Button variant="primary" size="sm" className="ml-auto" disabled={text.trim().length === 0 || add.isPending} loading={add.isPending} onClick={() => add.mutate()}>
            Add
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
        {([['all', 'All'], ['calls', 'Check calls'], ['stops', 'Stop events'], ['documents', 'Documents'], ['notes', 'Notes']] as const).map(([f, l]) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-semibold ring-1', filter === f ? 'bg-primary-soft text-primary-text ring-primary/30' : 'bg-surface text-muted ring-line')}
          >
            {l} <span className="tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>
      <ul className="divide-y divide-line-soft">
        {shown.length === 0 ? <li className="px-4 py-6 text-sm text-muted">Nothing here yet.</li> : null}
        {shown.map((e) => {
          const stop = e.stopId ? load.stops.find((s) => s.id === e.stopId) : null;
          const f = formatInstant(e.at, stop?.timezone ?? HOME_ZONE);
          const note = NOTES.has(e.kind) ? [...notesById.values()].find((n) => e.detail && n.body.startsWith(e.detail.replace(/…$/, '').slice(0, 40))) : null;
          return (
            <li key={e.id} className="flex gap-3 px-4 py-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted">{iconFor(e.kind)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-ink">
                    {e.title}
                    <span className="ml-2 text-xs font-normal text-muted">{e.actorName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted" title={f.tooltip}>
                    {f.day} · {f.time}
                  </span>
                </span>
                {note?.body ?? e.detail ? <span className="mt-0.5 block text-xs text-secondary">{note?.body ?? e.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ paperwork

export function PaperworkPanel({ load, onUploadBol, onDocuments }: { load: Load; onUploadBol: () => void; onDocuments: () => void }) {
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  const rc = load.documents.find((d) => d.type === 'rate_confirmation' && d.status !== 'missing') ?? null;
  const bol = load.documents.find((d) => d.type === 'bol' && d.status !== 'missing') ?? null;
  const pods = load.documents.filter((d) => d.type === 'pod' && d.status !== 'missing');
  const receipts = load.documents.filter((d) => d.type === 'lumper_receipt' && d.status !== 'missing');
  const bolDue = documentExpected(load, 'bol');
  const podDue = documentExpected(load, 'pod');

  const row = (
    key: string,
    title: string,
    sub: string,
    state: 'done' | 'due' | 'later' | 'optional',
    action: ReactNode,
  ) => (
    <li key={key} className="flex items-center gap-3 py-2.5">
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full border',
          state === 'done' && 'border-success bg-success-soft text-success-text',
          state === 'due' && 'border-warning-border text-warning-text',
          (state === 'later' || state === 'optional') && 'border-line text-faint',
        )}
      >
        {state === 'done' ? <CircleCheck className="size-3.5" /> : state === 'due' ? <span className="size-2 rounded-full bg-warning" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      {action}
    </li>
  );

  return (
    <Card title="Paperwork" description="Colored by when each document is due" padding="sm" actions={<Button variant="link" size="sm" onClick={onDocuments}>View all</Button>}>
      <ul className="divide-y divide-line-soft px-1">
        {row(
          'rc',
          'Rate confirmation',
          rc ? `Received ${formatInstant(rc.uploadedAt, HOME_ZONE).day}${rc.review === 'verified' ? ' · verified' : rc.review === 'reviewed' ? ' · reviewed' : ' · not reviewed yet'}` : 'Due at booking',
          rc ? 'done' : 'due',
          <Button variant="link" size="sm" onClick={onDocuments}>{rc ? 'Review' : 'Upload'}</Button>,
        )}
        {row(
          'bol',
          'Bill of lading',
          bol ? `Received ${formatInstant(bol.uploadedAt, HOME_ZONE).day}` : bolDue ? 'Due now · the truck is at the shipper' : 'Due when loaded',
          bol ? 'done' : bolDue ? 'due' : 'later',
          bol ? <Button variant="link" size="sm" onClick={onDocuments}>View</Button> : <Button variant="secondary" size="sm" icon={<Upload />} onClick={onUploadBol}>Upload</Button>,
        )}
        {row(
          'pod',
          `Proof of delivery × ${deliveries.length}`,
          pods.length >= deliveries.length && deliveries.length > 0 ? `${pods.length} on file` : podDue ? `${pods.length} of ${deliveries.length} on file · due after each delivery` : 'Due after each delivery',
          pods.length >= deliveries.length && deliveries.length > 0 ? 'done' : podDue ? 'due' : 'later',
          podDue || pods.length > 0 ? <Button variant="link" size="sm" onClick={onDocuments}>{podDue ? 'Upload' : 'View'}</Button> : <span className="text-xs text-muted">Not due</span>,
        )}
        {row('lumper', 'Lumper or scale receipts', receipts.length > 0 ? `${receipts.length} on file` : 'Only if paid', receipts.length > 0 ? 'done' : 'optional', <span className="text-xs text-muted">{receipts.length > 0 ? '' : 'Optional'}</span>)}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ money and billing

export function MoneyPanel({ load, onFinancial }: { load: Load; onFinancial: () => void }) {
  const nowIso = clockNow().toISOString();
  const rate = load.charges?.find((c) => c.type === 'linehaul')?.amount ?? load.rate ?? 0;
  const total = (load.loadedMiles ?? 0) + (load.emptyMiles ?? 0);
  const allIn = total > 0 ? rate / total : null;
  const loaded = load.loadedMiles ? rate / load.loadedMiles : null;
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  const rc = load.documents.some((d) => d.type === 'rate_confirmation' && d.status !== 'missing');
  const pods = load.documents.filter((d) => d.type === 'pod' && d.status !== 'missing');
  const podsReviewed = pods.filter((d) => d.review === 'reviewed' || d.review === 'verified').length;
  const deliveriesDone = deliveries.filter((d) => d.status === 'completed').length;
  const drafts = (load.charges ?? []).filter((c) => c.status === 'draft');
  const podsOk = deliveries.length > 0 && deliveriesDone === deliveries.length && podsReviewed >= deliveries.length;
  const ready = rc && podsOk && drafts.length === 0;

  // Detention lines: a draft already on the load, or the clock still running at a stop on site.
  const detention = load.stops.flatMap((s) => {
    const draft = drafts.find((c) => c.type === 'detention' && c.stopId === s.id);
    if (draft) return [{ key: s.id, label: `Detention at ${s.city}`, value: `${formatMoney(draft.amount)} draft` }];
    if (s.status === 'in_progress' && s.arrivedAt && !s.departedAt) {
      const ends = freeTimeEnds(s);
      if (!ends) return [];
      const started = Date.parse(ends) < Date.parse(nowIso);
      return [{ key: s.id, label: `Detention at ${s.city}`, value: started ? `Running since ${timeInZone(ends, s.timezone)}` : `Draft charge if it starts at ${timeInZone(ends, s.timezone)}` }];
    }
    return [];
  });

  const line = (label: string, value: ReactNode) => (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-semibold text-ink">{value}</span>
    </div>
  );
  const check = (ok: boolean, text: string) => (
    <li className={cn('flex items-center gap-2 text-xs', ok ? 'text-success-text' : 'text-muted')}>
      {ok ? <CircleCheck className="size-3.5" aria-hidden /> : <span className="size-3.5 rounded-full border border-line" aria-hidden />}
      {text}
    </li>
  );

  return (
    <Card title="Money and billing" padding="sm" actions={<Button variant="link" size="sm" onClick={onFinancial}>P&amp;L ›</Button>}>
      <div className="divide-y divide-line-soft px-1">
        {line('Rate (all-in)', formatMoney(rate))}
        {/* Real vs For driver (owner, 2026-10-23): shown only when the driver is paid on less (or more). */}
        {hasDriverRate(load) ? line('For driver', formatMoney(driverRateOf(load))) : null}
        {line('Per mile · all-in / loaded', `${allIn !== null ? formatRpm(allIn) : '—'} / ${loaded !== null ? formatRpm(loaded) : '—'}`)}
        {detention.map((d) => line(d.label, <span className="text-warning-text">{d.value}</span>))}
        {line('Bill to', load.brokerName || load.customerName)}
      </div>
      <div className={cn('mt-3 rounded-lg border p-3', ready ? 'border-success-border bg-success-soft' : 'border-line bg-surface-muted')}>
        <p className="text-sm font-semibold text-ink">Billing: {ready ? 'ready' : 'not ready'}</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {check(rc, 'Rate confirmation on file')}
          {check(podsOk, `BOL · ${deliveries.length === 1 ? 'delivery recorded' : `both deliveries recorded`} · ${deliveries.length} POD${deliveries.length === 1 ? '' : 's'} reviewed`)}
          {check(drafts.length === 0, drafts.length === 0 ? 'Accessorial charges decided' : `${drafts.length} accessorial draft${drafts.length === 1 ? '' : 's'} to decide`)}
        </ul>
        {ready && !load.invoiceId ? (
          <Link to="/loads" search={{ view: 'ready_to_bill' }} className="mt-2 inline-block text-xs font-semibold text-primary-text underline">
            Ready to bill
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

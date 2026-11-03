import {
  BOARD_WORDS_NEEDING_A_LOAD,
  CancelLoadSchema,
  CheckCallSchema,
  FlagLoadSchema,
  HOME_ZONE,
  LOAD_PROBLEM_KINDS,
  LOAD_PROBLEM_KIND_LABELS,
  StopEventSchema,
  applyCheckCall,
  cancelRequires,
  formatInstant,
  instantFromLocal,
  localParts,
  openProblems,
  statusDef,
  timeInZone,
  transition,
  type AiCard,
  type AssignLoadInput,
  type CancelLoadInput,
  type CheckCallInput,
  type DailyBoardRow,
  type DriverRecord,
  type LoadProblemKind,
  type StopEventInput,
  type StoredLoad,
  type TransitionActor,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { isFeatureEnabled } from '../../../common/flags/flags';
import { DispatchBoardService } from '../../dispatch-board/dispatch-board.service';
import { companyToday } from '../../dispatch-board/ops.helpers';
import { PtiService } from '../../fleet/pti.service';
import { LoadProblemsService } from '../../loads/load-problems.service';
import { LoadsService } from '../../loads/loads.service';
import { DriversService } from '../../roster/drivers.service';
import { TrailersService } from '../../roster/trailers.service';
import { TrucksService } from '../../roster/trucks.service';
import { refusal, StaleActionError, type ActionContext, type ActionDef, type ActionRefusal } from './types';

/**
 * NeWay AI actions for loads and the Daily Board.
 *
 * Each one goes through the service the load page or the board uses, as the signed-in person.
 * Plans are read only: where the shared rule (`transition`, `applyCheckCall`, the cancel rule)
 * can answer, it is run on a copy of the record so the refusal comes back in the app's own
 * words; nothing is written until run(), which re-reads the record and refuses a stale plan.
 */

// ------------------------------------------------------------------------------ helpers

type Stop = StoredLoad['stops'][number];
type Doc = StoredLoad['documents'][number];

const linkTo = (loadNumber: string): AiCard => ({ kind: 'link', label: `Open ${loadNumber}`, to: `/loads/${encodeURIComponent(loadNumber)}` });

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

const words = (status: string) => status.replace(/_/g, ' ');

function serverNow(ctx: ActionContext): Date {
  return ctx.get(LoadsService).clock();
}

function actorOf(principal: Principal): TransitionActor {
  return {
    id: principal.userId,
    name: principal.userName ?? 'Signed-in user',
    isLead: hasPermission(principal, 'dispatch.manage'),
    source: 'user',
  };
}

/** A load by its number ("L-100005", "100005") or id, in this company; null when there is none. */
async function findLoad(ctx: ActionContext, principal: Principal, raw: unknown): Promise<StoredLoad | null> {
  const typed = str(raw);
  if (!typed) return null;
  const service = ctx.get(LoadsService);
  const tries = [typed, typed.toUpperCase()];
  if (/^\d+$/.test(typed)) tries.push(`L-${typed}`);
  for (const key of tries) {
    const load = await service.get(principal, key).catch(() => null);
    if (load) return load;
  }
  return null;
}

async function loadOrRefuse(ctx: ActionContext, principal: Principal, raw: unknown): Promise<StoredLoad | ActionRefusal> {
  if (!str(raw)) return refusal('Say which load, e.g. L-100005.');
  const load = await findLoad(ctx, principal, raw);
  return load ?? refusal(`There is no load ${str(raw)} in this company.`);
}

const isRefusal = (value: unknown): value is ActionRefusal =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** The plan's record, re-read; a load that moved on since the plan is never written over. */
async function freshLoad(ctx: ActionContext, principal: Principal, loadId: string, loadNumber: string, expectedUpdatedAt: string): Promise<StoredLoad> {
  const now = await ctx.get(LoadsService).get(principal, loadId);
  if (now.updatedAt !== expectedUpdatedAt) throw new StaleActionError(`${loadNumber} changed since the plan. Reload it and ask again.`);
  return now;
}

/** The invoiced lock the service applies to edits, assignments and cancels (read only here). */
function invoicedRefusal(principal: Principal, load: StoredLoad): ActionRefusal | null {
  if (!load['invoiceId'] || hasPermission(principal, 'accounting.edit')) return null;
  return refusal(`${load.loadNumber} is invoiced (${String(load['invoiceId'])}). Ask Accounting for a correction; notes can still be added.`);
}

function stopLabel(stop: Stop): string {
  return stop.facilityName?.trim() || `${stop.city}, ${stop.state}`.trim();
}

function stopName(stop: Stop): string {
  return `${stop.sequence}. ${stop.kind === 'pickup' ? 'Pickup' : 'Delivery'} · ${stopLabel(stop)}`;
}

/** Stop time in its own clock, with Eastern beside it. */
function whenText(iso: string, zone: string | null | undefined): string {
  const eastern = formatInstant(iso, HOME_ZONE).text;
  if (!zone || zone === HOME_ZONE) return `${eastern}`;
  return `${timeInZone(iso, zone)} (${eastern} Eastern)`;
}

/**
 * A time the person said. Empty = now (the server's clock). An ISO time with an offset is taken
 * as it is; a wall-clock date and time ("2026-10-20 14:30") or a bare time ("14:30") is read in
 * the given zone - the stop's own, which is the clock the load page asks for.
 */
function parseWhen(raw: unknown, zone: string, now: Date): string | null {
  const text = str(raw);
  if (!text || /^now$/i.test(text)) return now.toISOString();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) && /\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const full = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/.exec(text);
  if (full) return instantFromLocal(full[1] as string, `${(full[2] as string).padStart(2, '0')}:${full[3]}`, zone);
  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const half = clock[3]?.toLowerCase();
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const today = localParts(now.toISOString(), zone)?.date;
    if (!today || hour > 23) return null;
    return instantFromLocal(today, `${String(hour).padStart(2, '0')}:${clock[2]}`, zone);
  }
  return null;
}

/** A document that is really on file: not a placeholder, not replaced by a newer one. */
function filed(doc: Doc): boolean {
  return doc.status !== 'missing' && doc.fileName.trim() !== '' && !doc.supersededBy;
}

/** The POD for this delivery, as the Daily Board's panel asks for it (per stop when the file says). */
function podOnFile(load: StoredLoad, stopId: string): boolean {
  return load.documents.some((d) => {
    if (d.type !== 'pod' || !filed(d)) return false;
    const own = (d as { stopId?: string | null }).stopId;
    if (own) return own === stopId;
    return load.stops.filter((s) => s.kind === 'delivery').length === 1;
  });
}

/** Every pickup carries its own BOL (owner, 2026-10-13): two pickups, two BOLs. */
function bolOnFileFor(load: StoredLoad, stop: Stop): boolean {
  const position = load.stops.filter((s) => s.kind === 'pickup').findIndex((s) => s.id === stop.id) + 1;
  const bols = load.documents.filter((d) => d.type === 'bol' && filed(d)).length;
  return bols >= Math.max(1, position);
}

function pickStop(load: StoredLoad, which: string, kind: 'pickup' | 'delivery' | null): Stop | ActionRefusal {
  const stops = load.stops;
  if (stops.length === 0) return refusal(`${load.loadNumber} has no stops.`);
  const text = which.toLowerCase();
  if (/^\d+$/.test(text)) {
    const stop = stops.find((s) => s.sequence === Number(text));
    return stop ?? refusal(`${load.loadNumber} has no stop ${text}. Its stops: ${stops.map(stopName).join('; ')}.`);
  }
  const wanted: 'pickup' | 'delivery' | null = /^(pu|pickup|pick ?up|shipper)$/.test(text)
    ? 'pickup'
    : /^(del|delivery|drop|receiver|consignee)$/.test(text)
      ? 'delivery'
      : kind;
  const pool = wanted ? stops.filter((s) => s.kind === wanted) : stops;
  if (pool.length === 0) return refusal(`${load.loadNumber} has no ${wanted} stop.`);
  return pool.find((s) => s.status !== 'completed') ?? (wanted ? (pool.at(-1) as Stop) : refusal(`Every stop on ${load.loadNumber} is already done.`));
}

// ------------------------------------------------------------------------------ name lookups

function candidates(list: string[]): string {
  return list.slice(0, 5).join('; ');
}

async function resolveDriver(ctx: ActionContext, principal: Principal, raw: string): Promise<DriverRecord | ActionRefusal> {
  const drivers = ctx.get(DriversService);
  const exact = await drivers.find(principal, raw);
  if (exact && !exact.archivedAt) return exact;
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const page = await drivers.list(principal, { page: 1, pageSize: 1000, search: tokens[0] ?? raw, includeInactive: false, includeArchived: false });
  const matches = page.data.filter((d) => {
    const hay = `${d.name} ${d.driverNumber} ${d.firstName} ${d.lastName}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const whole = matches.filter((d) => d.name.toLowerCase() === raw.toLowerCase());
  const pick = whole.length === 1 ? whole : matches;
  if (pick.length === 1) return pick[0] as DriverRecord;
  if (pick.length === 0) return refusal(`No active driver matches "${raw}".`);
  return refusal(`More than one driver matches "${raw}": ${candidates(pick.map((d) => `${d.name} · ${d.driverNumber}${d.currentTruckUnit ? ` · unit ${d.currentTruckUnit}` : ''}`))}. Say which one.`);
}

async function resolveUnit(
  ctx: ActionContext,
  principal: Principal,
  kind: 'truck' | 'trailer',
  raw: string,
): Promise<{ id: string; unitNumber: string } | ActionRefusal> {
  const service = kind === 'truck' ? ctx.get(TrucksService) : ctx.get(TrailersService);
  const exact = await service.find(principal, raw);
  if (exact && exact.status !== 'archived') return { id: exact.id, unitNumber: exact.unitNumber };
  const page = await service.list(principal, { page: 1, pageSize: 1000, search: raw, includeInactive: false, includeArchived: false });
  const rows = page.data.map((r) => ({ id: r.id, unitNumber: r.unitNumber }));
  const same = rows.filter((r) => r.unitNumber.toLowerCase() === raw.toLowerCase());
  const pick = same.length === 1 ? same : rows.filter((r) => r.unitNumber.toLowerCase().includes(raw.toLowerCase()));
  if (pick.length === 1) return pick[0] as { id: string; unitNumber: string };
  if (pick.length === 0) return refusal(`No ${kind} ${raw} in this fleet.`);
  return refusal(`More than one ${kind} matches "${raw}": ${candidates(pick.map((r) => r.unitNumber))}. Say which one.`);
}

/**
 * The hold at the point of dispatch (§9.1), as the Assign dialog asks it: a truck with an open
 * out-of-service defect is not put on a load. Behind `fleet_v2`, like the route it reads. The
 * override is a named decision made on Edit load, never here.
 */
async function dispatchHold(ctx: ActionContext, principal: Principal, truck: { id: string; unitNumber: string } | null): Promise<string | null> {
  if (!truck || !isFeatureEnabled('fleet_v2')) return null;
  const { verdict } = await ctx.get(PtiService).unitStatus(principal, truck.id);
  if (!verdict.dispatchBlocked) return null;
  return `Unit ${truck.unitNumber} is out of service — ${verdict.reason ?? 'an open defect holds it'}. ${verdict.releaseCondition ?? ''}`.trim() +
    ' Use Edit load to dispatch it with an override.';
}

// ------------------------------------------------------------------------------ load_assign

interface AssignParams {
  loadId: string;
  loadNumber: string;
  expectedUpdatedAt: string;
  input: Omit<AssignLoadInput, 'expectedUpdatedAt'>;
}

const loadAssign: ActionDef<AssignParams> = {
  name: 'load_assign',
  description:
    'Assign a driver, truck and trailer to a load (the Assign / Edit load assignment). Name the driver by name or driver number; the truck and trailer by unit number. When only the driver is named, the driver\'s current truck and trailer are used, like the Assign dialog. Refuses an out-of-service truck.',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      driver: { type: 'string', description: 'Driver name or driver number.' },
      truck: { type: 'string', description: 'Truck unit number; leave out to use the driver\'s current truck.' },
      trailer: { type: 'string', description: 'Trailer unit number; leave out to use the driver\'s current trailer.' },
      note: { type: 'string' },
    },
    required: ['load_number'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const locked = invoicedRefusal(principal, load);
    if (locked) return locked;

    const driverText = str(input.driver);
    const truckText = str(input.truck);
    const trailerText = str(input.trailer);
    if (!driverText && !truckText && !trailerText) return refusal('Say which driver (and, if not their own, which truck and trailer).');

    let driverId = (load.driverId as string | null) ?? null;
    let driverName = (load['driverName'] as string | null) ?? null;
    let driver: DriverRecord | null = null;
    if (driverText) {
      const found = await resolveDriver(ctx, principal, driverText);
      if (isRefusal(found)) return found;
      driver = found;
      driverId = found.id;
      driverName = found.name;
    }
    if (!driverId) return refusal(`${load.loadNumber} has no driver yet. Say which driver.`);

    let truck: { id: string; unitNumber: string } | null = load.truckId
      ? { id: load.truckId as string, unitNumber: String(load['truckUnit'] ?? load.truckId) }
      : null;
    let trailer: { id: string; unitNumber: string } | null = load.trailerId
      ? { id: load.trailerId as string, unitNumber: String(load['trailerUnit'] ?? load.trailerId) }
      : null;
    const warnings: string[] = [];
    if (truckText) {
      const found = await resolveUnit(ctx, principal, 'truck', truckText);
      if (isRefusal(found)) return found;
      truck = found;
    } else if (driver?.currentTruckId) {
      truck = { id: driver.currentTruckId, unitNumber: driver.currentTruckUnit ?? driver.currentTruckId };
    }
    if (trailerText) {
      const found = await resolveUnit(ctx, principal, 'trailer', trailerText);
      if (isRefusal(found)) return found;
      trailer = found;
    } else if (driver?.currentTrailerId) {
      const found = await ctx.get(TrailersService).find(principal, driver.currentTrailerId);
      trailer = { id: driver.currentTrailerId, unitNumber: found?.unitNumber ?? driver.currentTrailerId };
    }
    if (!truck) warnings.push(`No truck: ${load.loadNumber} stays ${words(load.status)} until a truck is on it.`);

    const hold = await dispatchHold(ctx, principal, truck);
    if (hold) return refusal(hold);

    const assignment: Omit<AssignLoadInput, 'expectedUpdatedAt'> = {
      driverId,
      driverName,
      truckId: truck?.id ?? null,
      truckUnit: truck?.unitNumber ?? null,
      trailerId: trailer?.id ?? null,
      trailerUnit: trailer?.unitNumber ?? null,
      ...(str(input.note) ? { note: str(input.note).slice(0, 500) } : {}),
    };
    // The shared rule, on a copy: its refusal is the app's own sentence.
    const dry = transition(load, { kind: 'assignment', input: { ...assignment, expectedUpdatedAt: load.updatedAt } }, actorOf(principal), serverNow(ctx).toISOString());
    if (!dry.ok) return refusal(dry.refusal.message);

    const lines = [
      `Driver: ${driverName ?? 'nobody'}${load.driverId && load.driverId !== driverId ? ` (was ${String(load['driverName'] ?? 'another driver')})` : ''}`,
      `Truck: ${truck?.unitNumber ?? 'none'}`,
      `Trailer: ${trailer?.unitNumber ?? 'none'}`,
    ];
    if (dry.record.status !== load.status) lines.push(`${load.loadNumber} becomes ${words(dry.record.status)}.`);
    return {
      ok: true,
      title: `Assign ${load.loadNumber} to ${driverName ?? 'driver'}${truck ? ` · Unit ${truck.unitNumber}` : ''}`,
      lines,
      params: { loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, input: assignment },
      fingerprint: `load_assign:${load.id}:${driverId}:${truck?.id ?? ''}:${trailer?.id ?? ''}`,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    await freshLoad(ctx, principal, p.loadId, p.loadNumber, p.expectedUpdatedAt);
    const hold = await dispatchHold(ctx, principal, p.input.truckId ? { id: p.input.truckId, unitNumber: p.input.truckUnit ?? p.input.truckId } : null);
    if (hold) throw new StaleActionError(hold);
    const result = await ctx.get(LoadsService).assign(principal, p.loadId, { ...p.input, expectedUpdatedAt: p.expectedUpdatedAt });
    return {
      text: `${p.loadNumber} assigned to ${p.input.driverName ?? 'the driver'}${p.input.truckUnit ? ` · Unit ${p.input.truckUnit}` : ''}. Now ${words(result.load.status)}.`,
      cards: [linkTo(p.loadNumber)],
    };
  },
};

// ------------------------------------------------------------------------------ load_record_event

type EventParams =
  | { mode: 'stop_event'; loadId: string; loadNumber: string; expectedUpdatedAt: string; input: Omit<StopEventInput, 'expectedUpdatedAt'>; label: string }
  | { mode: 'loaded'; loadId: string; loadNumber: string; expectedUpdatedAt: string; stopId: string; at: string; label: string };

const EVENT_LABEL: Record<string, string> = {
  arrived: 'Arrived',
  loaded: 'Loaded',
  departed: 'Departed',
  delivered: 'Delivered',
};

const loadRecordEvent: ActionDef<EventParams> = {
  name: 'load_record_event',
  description:
    'Record an event at a stop of a load (Record an event): arrived, loaded (BOL), departed, or delivered (= departed the delivery). Pick the stop as "pickup", "delivery" or its sequence number; by default the next open stop. Time defaults to now; a typed time is read in the stop\'s own clock. Leaving a pickup needs its BOL on file and leaving a delivery its POD - upload them on the load first.',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      event: { type: 'string', enum: ['arrived', 'loaded', 'departed', 'delivered'] },
      stop: { type: 'string', description: '"pickup", "delivery" or the stop number (1, 2, ...). Leave out for the next open stop.' },
      at: { type: 'string', description: 'When it happened: "14:30", "2026-10-20 14:30" (stop\'s local time) or ISO with offset. Leave out for now.' },
      note: { type: 'string' },
    },
    required: ['load_number', 'event'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const event = str(input.event).toLowerCase();
    if (!['arrived', 'loaded', 'departed', 'delivered'].includes(event)) return refusal('Say what happened: arrived, loaded, departed or delivered.');
    const kindHint = event === 'loaded' ? 'pickup' : event === 'delivered' ? 'delivery' : null;
    const stop = pickStop(load, str(input.stop), kindHint);
    if (isRefusal(stop)) return stop;
    if (event === 'loaded' && stop.kind !== 'pickup') return refusal('Loaded belongs to a pickup. Pick the pickup the BOL is for.');
    if (event === 'delivered' && stop.kind !== 'delivery') return refusal('Delivered belongs to a delivery stop.');
    if (!stop.timezone?.trim()) return refusal(`${stopLabel(stop)} has no time zone. Add the city and state on the stop, and the zone follows.`);

    const now = serverNow(ctx);
    const at = parseWhen(input.at, stop.timezone, now);
    if (!at) return refusal('That time does not parse. Say it like "14:30" or "2026-10-20 14:30" in the stop\'s local time.');
    const note = str(input.note).slice(0, 500) || undefined;
    const actor = actorOf(principal);
    const label = EVENT_LABEL[event] as string;

    if (event === 'loaded') {
      // Recorded with its BOL, every time (owner, 2026-10-06). The AI cannot attach a file.
      if (!bolOnFileFor(load, stop)) {
        return refusal(`Loaded is recorded with its BOL attached. Upload the BOL for ${stopLabel(stop)} in ${load.loadNumber}'s Documents first, then ask again.`);
      }
      const loadedAt = stop.arrivedAt ?? at;
      const dry = transition(load, { kind: 'confirm_upload', input: { kind: 'mark_loaded', stopId: stop.id, at: loadedAt, expectedUpdatedAt: load.updatedAt } }, actor, now.toISOString());
      if (!dry.ok) return refusal(dry.refusal.message);
      const lines = [`${stopName(stop)}`, `Loaded at ${whenText(loadedAt, stop.timezone)}`];
      if (dry.record.status !== load.status) lines.push(`${load.loadNumber}: ${words(load.status)} → ${words(dry.record.status)}`);
      if (note) lines.push(`Note (not saved with this event): ${note}`);
      return {
        ok: true,
        title: `Loaded · ${load.loadNumber} at ${stopLabel(stop)}`,
        lines,
        params: { mode: 'loaded', loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, stopId: stop.id, at: loadedAt, label },
        fingerprint: `load_event:${load.id}:${stop.id}:loaded`,
        warnings: note ? ['The note is not part of the Loaded event; add it as a note if it should be kept.'] : [],
      };
    }

    const kind: StopEventInput['kind'] = event === 'arrived' ? 'arrived' : 'departed';
    if (kind === 'departed' && stop.kind === 'pickup' && !stop.loadedAt && !bolOnFileFor(load, stop)) {
      return refusal(`Attach the BOL before the truck leaves the pickup. Upload it in ${load.loadNumber}'s Documents first, then ask again.`);
    }
    if (kind === 'departed' && stop.kind === 'delivery' && !podOnFile(load, stop.id)) {
      return refusal(`Attach the POD before the truck leaves the delivery. Upload it in ${load.loadNumber}'s Documents first, then ask again.`);
    }
    const parsed = StopEventSchema.safeParse({ stopId: stop.id, kind, at, zone: stop.timezone, note, expectedUpdatedAt: load.updatedAt });
    if (!parsed.success) return refusal(parsed.error.issues[0]?.message ?? 'That event is not complete.');
    const dry = transition(load, { kind: 'stop_event', input: parsed.data }, actor, now.toISOString());
    if (!dry.ok) return refusal(dry.refusal.message);
    const { expectedUpdatedAt: _seen, ...stopInput } = parsed.data;
    const lines = [stopName(stop), `${label} at ${whenText(at, stop.timezone)}`];
    if (dry.record.status !== load.status) lines.push(`${load.loadNumber}: ${words(load.status)} → ${words(dry.record.status)}`);
    if (note) lines.push(`Note: ${note}`);
    return {
      ok: true,
      title: `${label} · ${load.loadNumber} at ${stopLabel(stop)}`,
      lines,
      params: { mode: 'stop_event', loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, input: stopInput, label },
      fingerprint: `load_event:${load.id}:${stop.id}:${kind}`,
    };
  },
  async run(ctx, principal, p) {
    await freshLoad(ctx, principal, p.loadId, p.loadNumber, p.expectedUpdatedAt);
    const service = ctx.get(LoadsService);
    const result =
      p.mode === 'loaded'
        ? await service.confirmUpload(principal, p.loadId, { kind: 'mark_loaded', stopId: p.stopId, at: p.at, expectedUpdatedAt: p.expectedUpdatedAt })
        : await service.recordStopEvent(principal, p.loadId, { ...p.input, expectedUpdatedAt: p.expectedUpdatedAt });
    return { text: `${p.label} recorded on ${p.loadNumber}. Now ${words(result.load.status)}.`, cards: [linkTo(p.loadNumber)] };
  },
};

// ------------------------------------------------------------------------------ load_check_call

interface CheckCallParams {
  loadId: string;
  loadNumber: string;
  expectedUpdatedAt: string;
  input: Omit<CheckCallInput, 'expectedUpdatedAt'>;
}

const loadCheckCall: ActionDef<CheckCallParams> = {
  name: 'load_check_call',
  description:
    'Record a check call (the driver was heard from: where the truck is, what they said) or an ETA change for the next stop on a load. Nothing moves; it resets the update clock. Times are read in the stop\'s local clock; default now.',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      kind: { type: 'string', enum: ['check_call', 'eta_changed'] },
      location: { type: 'string', description: 'Where the truck is, e.g. "I-80 near Des Moines, IA".' },
      eta: { type: 'string', description: 'New ETA for eta_changed: "17:00", "2026-10-21 08:00" (stop\'s local time) or ISO with offset.' },
      stop: { type: 'string', description: 'The stop the ETA is for ("pickup", "delivery" or its number); the next open stop when left out.' },
      at: { type: 'string', description: 'When the call happened; default now.' },
      note: { type: 'string' },
    },
    required: ['load_number'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const kind: CheckCallInput['kind'] = str(input.kind) === 'eta_changed' || (str(input.eta) && str(input.kind) !== 'check_call') ? 'eta_changed' : 'check_call';
    let stop: Stop | null = null;
    if (str(input.stop)) {
      const picked = pickStop(load, str(input.stop), null);
      if (isRefusal(picked)) return picked;
      stop = picked;
    } else {
      stop = load.stops.find((s) => s.status !== 'completed') ?? null;
    }
    const zone = stop?.timezone?.trim() || HOME_ZONE;
    const now = serverNow(ctx);
    const at = parseWhen(input.at, zone, now);
    if (!at) return refusal('That time does not parse. Say it like "14:30" or "2026-10-20 14:30".');
    let etaAt: string | undefined;
    if (kind === 'eta_changed') {
      if (!str(input.eta)) return refusal('Say what the new ETA is.');
      const parsedEta = parseWhen(input.eta, zone, now);
      if (!parsedEta) return refusal('That ETA does not parse. Say it like "17:00" or "2026-10-21 08:00" in the stop\'s local time.');
      etaAt = parsedEta;
    }
    const location = str(input.location).slice(0, 200) || undefined;
    const note = str(input.note).slice(0, 1000) || undefined;
    const parsed = CheckCallSchema.safeParse({ kind, at, location, etaAt, stopId: stop?.id, note, expectedUpdatedAt: load.updatedAt });
    if (!parsed.success) return refusal(parsed.error.issues[0]?.message ?? 'That check call is not complete.');
    const dry = applyCheckCall(load, parsed.data, actorOf(principal), now.toISOString());
    if (!dry.ok) return refusal(dry.refusal.message);
    const { expectedUpdatedAt: _seen, ...callInput } = parsed.data;
    const lines = [
      `${kind === 'check_call' ? 'Check call' : 'ETA changed'} at ${whenText(at, zone)}`,
      ...(stop ? [`${kind === 'check_call' ? 'To' : 'For'} ${stopName(stop)}`] : []),
      ...(location ? [`Truck at ${location}`] : []),
      ...(etaAt ? [`New ETA ${whenText(etaAt, zone)}`] : []),
      ...(note ? [`Note: ${note}`] : []),
    ];
    return {
      ok: true,
      title: `${kind === 'check_call' ? 'Check call' : 'ETA changed'} · ${load.loadNumber}`,
      lines,
      params: { loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, input: callInput },
      fingerprint: `load_check_call:${load.id}:${kind}:${at.slice(0, 16)}:${etaAt ?? ''}:${(location ?? '').slice(0, 40)}`,
    };
  },
  async run(ctx, principal, p) {
    await freshLoad(ctx, principal, p.loadId, p.loadNumber, p.expectedUpdatedAt);
    await ctx.get(LoadsService).checkCall(principal, p.loadId, { ...p.input, expectedUpdatedAt: p.expectedUpdatedAt });
    return {
      text: `${p.input.kind === 'check_call' ? 'Check call' : 'ETA change'} recorded on ${p.loadNumber}.`,
      cards: [linkTo(p.loadNumber)],
    };
  },
};

// ------------------------------------------------------------------------------ flags

interface FlagParams {
  loadId: string;
  loadNumber: string;
  expectedUpdatedAt: string;
  kind: LoadProblemKind;
  note: string;
}

const loadFlag: ActionDef<FlagParams> = {
  name: 'load_flag',
  description: `Flag a load ("this needs a person"): it stays on the Loads list, the Daily Board and Notifications until somebody closes it. Kinds: ${LOAD_PROBLEM_KINDS.map((k) => `${k} (${LOAD_PROBLEM_KIND_LABELS[k]})`).join(', ')}. Needs a sentence saying what the problem is.`,
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      kind: { type: 'string', enum: [...LOAD_PROBLEM_KINDS] },
      note: { type: 'string', description: 'What the problem is.' },
    },
    required: ['load_number', 'kind', 'note'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const parsed = FlagLoadSchema.safeParse({ kind: str(input.kind), note: str(input.note) });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refusal(issue?.path[0] === 'kind' ? `Say what kind of flag: ${LOAD_PROBLEM_KINDS.join(', ')}.` : (issue?.message ?? 'Say what the problem is'));
    }
    const open = openProblems(await ctx.get(LoadProblemsService).forLoad(principal, load.id));
    const same = open.find((p) => p.kind === parsed.data.kind);
    const warnings = same ? [`${load.loadNumber} already has an open ${LOAD_PROBLEM_KIND_LABELS[same.kind]} flag: "${same.note}".`] : [];
    return {
      ok: true,
      title: `Flag ${load.loadNumber} · ${LOAD_PROBLEM_KIND_LABELS[parsed.data.kind]}`,
      lines: [parsed.data.note.slice(0, 300)],
      params: { loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, kind: parsed.data.kind, note: parsed.data.note },
      fingerprint: `load_flag:${load.id}:${parsed.data.kind}:${parsed.data.note.slice(0, 80)}`,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    await freshLoad(ctx, principal, p.loadId, p.loadNumber, p.expectedUpdatedAt);
    await ctx.get(LoadProblemsService).flag(principal, p.loadId, { kind: p.kind, note: p.note });
    return { text: `${p.loadNumber} flagged: ${LOAD_PROBLEM_KIND_LABELS[p.kind]}.`, cards: [linkTo(p.loadNumber)] };
  },
};

interface CloseFlagParams {
  loadId: string;
  loadNumber: string;
  problemId: string;
  kind: LoadProblemKind;
  note: string;
}

const loadCloseFlag: ActionDef<CloseFlagParams> = {
  name: 'load_close_flag',
  description:
    'Close an open flag on a load, with a note saying what was done. Name the flag by its kind when the load has more than one open (or give its id).',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      kind: { type: 'string', enum: [...LOAD_PROBLEM_KINDS], description: 'Which flag, when there is more than one open.' },
      flag_id: { type: 'string' },
      note: { type: 'string', description: 'What was done.' },
    },
    required: ['load_number', 'note'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const note = str(input.note);
    if (note.length < 3) return refusal('Say what was done');
    const open = openProblems(await ctx.get(LoadProblemsService).forLoad(principal, load.id));
    if (open.length === 0) return refusal(`${load.loadNumber} has no open flag.`);
    const id = str(input.flag_id);
    const kind = str(input.kind);
    const pool = id ? open.filter((p) => p.id === id) : kind ? open.filter((p) => p.kind === kind) : open;
    if (pool.length === 0) return refusal(`${load.loadNumber} has no open ${id ? `flag ${id}` : `${kind} flag`}. Open flags: ${candidates(open.map((p) => `${LOAD_PROBLEM_KIND_LABELS[p.kind]} - "${p.note}"`))}.`);
    if (pool.length > 1) {
      return refusal(`${load.loadNumber} has ${pool.length} open flags: ${candidates(pool.map((p) => `${LOAD_PROBLEM_KIND_LABELS[p.kind]} (${p.id}) - "${p.note}"`))}. Say which one.`);
    }
    const flag = pool[0]!;
    return {
      ok: true,
      title: `Close the ${LOAD_PROBLEM_KIND_LABELS[flag.kind]} flag on ${load.loadNumber}`,
      lines: [`Flag: ${flag.note.slice(0, 200)} (by ${flag.openedByName})`, `What was done: ${note.slice(0, 300)}`],
      params: { loadId: load.id, loadNumber: load.loadNumber, problemId: flag.id, kind: flag.kind, note: note.slice(0, 1000) },
      fingerprint: `load_close_flag:${flag.id}`,
    };
  },
  async run(ctx, principal, p) {
    // The flag is the record here: still open, or the plan is stale.
    const flags = await ctx.get(LoadProblemsService).forLoad(principal, p.loadId);
    const flag = flags.find((f) => f.id === p.problemId);
    if (!flag) throw new StaleActionError('That flag is not on this load.');
    if (flag.closedAt) throw new StaleActionError(`That flag was already closed by ${flag.closedByName ?? 'somebody'}.`);
    await ctx.get(LoadProblemsService).close(principal, p.loadId, p.problemId, { note: p.note });
    return { text: `${LOAD_PROBLEM_KIND_LABELS[p.kind]} flag closed on ${p.loadNumber}.`, cards: [linkTo(p.loadNumber)] };
  },
};

// ------------------------------------------------------------------------------ load_cancel

interface CancelParams {
  loadId: string;
  loadNumber: string;
  expectedUpdatedAt: string;
  input: Omit<CancelLoadInput, 'expectedUpdatedAt'>;
}

const loadCancel: ActionDef<CancelParams> = {
  name: 'load_cancel',
  description:
    'Cancel a load, or mark it TONU (truck ordered not used) with the fee the broker agreed. Needs the reason, who requested it, and the broker\'s approval (who approved, by email / phone / other, and the reference). Before dispatch anybody on dispatch may; once dispatched or at the pickup it takes a dispatch lead; past the pickup it cannot be cancelled. Frees the driver, truck and trailer.',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      outcome: { type: 'string', enum: ['cancelled', 'tonu'] },
      reason: { type: 'string' },
      requested_by: { type: 'string', description: 'The broker\'s or customer\'s name, or "us".' },
      approved_by: { type: 'string', description: 'Who at the broker approved it.' },
      approval_method: { type: 'string', enum: ['email', 'phone', 'other'] },
      approval_reference: { type: 'string', description: 'Email subject, call reference or note that shows the approval.' },
      approval_at: { type: 'string', description: 'When the approval came (Eastern, e.g. "2026-10-20 14:30"); default now.' },
      fee: { type: 'number', description: 'TONU fee in dollars (required for TONU, even if 0).' },
    },
    required: ['load_number', 'outcome', 'reason', 'requested_by', 'approved_by', 'approval_method'],
  },
  permission: 'loads.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const load = await loadOrRefuse(ctx, principal, input.load_number);
    if (isRefusal(load)) return load;
    const requirement = cancelRequires(load.status);
    if (requirement === 'forbidden') {
      return refusal(`${load.loadNumber} is ${words(load.status)}; a load past the pickup is delivered or claimed, not cancelled.`);
    }
    const isLead = hasPermission(principal, 'dispatch.manage');
    const mayCancel = load.dispatcherId === principal.userId || (load['updaterId'] as string | null | undefined) === principal.userId || isLead;
    if (!mayCancel) return refusal(`Only ${load.loadNumber}'s dispatcher or updater, or an administrator, may cancel it.`);
    const locked = invoicedRefusal(principal, load);
    if (locked) return locked;

    const now = serverNow(ctx);
    const approvalAt = parseWhen(input.approval_at, HOME_ZONE, now);
    if (!approvalAt) return refusal('Say when the approval came, e.g. "2026-10-20 14:30" Eastern.');
    const outcome = str(input.outcome) === 'tonu' ? 'tonu' : str(input.outcome) === 'cancelled' ? 'cancelled' : null;
    if (!outcome) return refusal('Say whether it is cancelled or a TONU.');
    const feeRaw = input.fee;
    const fee = typeof feeRaw === 'number' && Number.isFinite(feeRaw) ? feeRaw : typeof feeRaw === 'string' && feeRaw.trim() !== '' ? Number(feeRaw.replace(/[$,]/g, '')) : null;
    const parsed = CancelLoadSchema.safeParse({
      outcome,
      reason: str(input.reason),
      requestedBy: str(input.requested_by),
      approval: {
        by: str(input.approved_by),
        method: str(input.approval_method),
        reference: str(input.approval_reference) || null,
        at: approvalAt,
      },
      fee: outcome === 'tonu' ? (fee !== null && Number.isFinite(fee) ? fee : null) : null,
      expectedUpdatedAt: load.updatedAt,
    });
    if (!parsed.success) return refusal(parsed.error.issues[0]?.message ?? 'The cancellation is not complete.');
    // The shared rule on a copy: lead approval, TONU fee - in its own words.
    const dry = transition(load, { kind: 'cancel', input: parsed.data }, actorOf(principal), now.toISOString());
    if (!dry.ok) return refusal(dry.refusal.message);

    const { expectedUpdatedAt: _seen, ...cancelInput } = parsed.data;
    const freed = [
      load['driverName'] ? `driver ${String(load['driverName'])}` : null,
      load['truckUnit'] ? `unit ${String(load['truckUnit'])}` : null,
      load['trailerUnit'] ? `trailer ${String(load['trailerUnit'])}` : null,
    ].filter((x): x is string => x !== null);
    const lines = [
      `${load.loadNumber}: ${words(load.status)} → ${outcome === 'tonu' ? 'TONU' : 'cancelled'}`,
      `Reason: ${cancelInput.reason}`,
      `Requested by ${cancelInput.requestedBy}`,
      `Approved by ${cancelInput.approval.by} by ${cancelInput.approval.method}${cancelInput.approval.reference ? ` · ${cancelInput.approval.reference}` : ''} · ${formatInstant(approvalAt, HOME_ZONE).text}`,
      ...(outcome === 'tonu' ? [`TONU fee $${(cancelInput.fee ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (billed to the broker; the linehaul is dropped)`] : ['Nothing is billed.']),
      ...(freed.length > 0 ? [`Releases ${freed.join(', ')}`] : []),
    ];
    return {
      ok: true,
      title: `${outcome === 'tonu' ? 'TONU' : 'Cancel'} ${load.loadNumber}`,
      lines,
      params: { loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: load.updatedAt, input: cancelInput },
      fingerprint: `load_cancel:${load.id}:${outcome}`,
      totalCents: outcome === 'tonu' ? Math.round((cancelInput.fee ?? 0) * 100) : null,
      warnings: requirement === 'lead' ? [`${load.loadNumber} is already ${words(load.status)}: cancelling it is a dispatch lead's decision.`] : [],
    };
  },
  async run(ctx, principal, p) {
    await freshLoad(ctx, principal, p.loadId, p.loadNumber, p.expectedUpdatedAt);
    const result = await ctx.get(LoadsService).cancel(principal, p.loadId, { ...p.input, expectedUpdatedAt: p.expectedUpdatedAt });
    return {
      text: `${p.loadNumber} ${result.load.status === 'tonu' ? 'marked TONU' : 'cancelled'}.`,
      cards: [linkTo(p.loadNumber)],
    };
  },
};

// ------------------------------------------------------------------------------ dispatch_set_driver_status

/** The board words that are also statements about the freight: on the board they open the panel. */
const LOAD_STATUSES_ON_BOARD = new Set(['DISPATCHED', 'AT PU', 'ENROUTE', 'UNLOADING', 'READY']);

/**
 * Whether the board's side panel would ask the load to move for this word (the web's
 * `planFor`, as a yes/no). When it would, the word is not only a word, and this action refuses
 * rather than writing a row that disagrees with its load.
 */
function wordMovesLoad(status: string, load: StoredLoad): boolean {
  const pickups = load.stops.filter((s) => s.kind === 'pickup');
  const openDeliveries = load.stops.filter((s) => s.kind === 'delivery' && s.status !== 'completed');
  const unloadingNow = openDeliveries.find((s) => s.status === 'in_progress') ?? null;
  if (status === 'DISPATCHED') return true;
  if (status === 'ENROUTE') return pickups.some((s) => s.status !== 'completed') || unloadingNow !== null;
  if (status === 'UNLOADING') return openDeliveries.some((s) => s.status !== 'in_progress');
  if (status === 'READY') return openDeliveries.length > 0;
  return false;
}

interface BoardParams {
  rowId: string;
  driverName: string;
  day: string;
  word: string;
  expectedVersion: number | null;
}

async function boardRows(ctx: ActionContext, principal: Principal): Promise<{ day: string; rows: DailyBoardRow[] }> {
  const day = companyToday(principal, serverNow(ctx));
  const board = await ctx.get(DispatchBoardService).daily(principal, day);
  return { day: board.day, rows: board.rows };
}

/** The status cell's version on this very day, or null when nothing is typed today (a carried word is yesterday's). */
function statusVersion(row: DailyBoardRow, day: string): number | null {
  const cell = row.cells['status'];
  return cell && cell.day === day ? cell.version : null;
}

const dispatchSetDriverStatus: ActionDef<BoardParams> = {
  name: 'dispatch_set_driver_status',
  description:
    'Set a driver\'s status word on today\'s Daily Board (e.g. READY, COVERED, RESERVED, HOLD FOR LOAD, REST, HOME, VACATION, SHOP, INACTIVE, NO ANSWER, STOP, RE-UPDATE, NEW DRIVER). Name the driver by name, driver number or truck unit. Words that move the load (DISPATCHED, ENROUTE, UNLOADING, READY after a delivery) are recorded on the load instead - use load_record_event.',
  input_schema: {
    type: 'object',
    properties: {
      driver: { type: 'string', description: 'Driver name, driver number or truck unit.' },
      status: { type: 'string', description: 'The board word, e.g. HOME.' },
    },
    required: ['driver', 'status'],
  },
  permission: 'dispatch.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const who = str(input.driver);
    if (!who) return refusal('Say which driver.');
    const def = statusDef(str(input.status));
    if (!def) return refusal(`"${str(input.status)}" is not a status on the palette`);
    const word = def.code;
    const { day, rows } = await boardRows(ctx, principal);
    const needle = who.toLowerCase();
    const tokens = needle.split(/\s+/).filter(Boolean);
    const exact = rows.filter((r) => r.driverNumber.toLowerCase() === needle || (r.truckUnit ?? '').toLowerCase() === needle || r.driverName.toLowerCase() === needle);
    const loose = rows.filter((r) => tokens.every((t) => `${r.driverName} ${r.coDriver ?? ''}`.toLowerCase().includes(t)));
    const pick = exact.length > 0 ? exact : loose;
    if (pick.length === 0) return refusal(`No row on today's Daily Board matches "${who}".`);
    if (pick.length > 1) {
      return refusal(`More than one row matches "${who}": ${candidates(pick.map((r) => `${r.driverName}${r.truckUnit ? ` · unit ${r.truckUnit}` : ''} · ${r.dispatcherName}`))}. Say which one.`);
    }
    const row = pick[0]!;
    if ((row.status ?? '') === word) return refusal(`${row.driverName} already reads ${word} today.`);

    const about = row.primaryLoad ?? (word === 'DISPATCHED' ? (row.queuedLoads[0] ?? null) : null);
    if (BOARD_WORDS_NEEDING_A_LOAD.has(word) && !about) {
      return refusal(`${row.driverName} has no load. Assign a load first; the row turns DISPATCHED by itself. Until then it stays READY.`);
    }
    if (LOAD_STATUSES_ON_BOARD.has(word) && about) {
      const load = await findLoad(ctx, principal, about.id);
      if (!load) return refusal(`${about.loadNumber} could not be read. Nothing has been changed.`);
      if (wordMovesLoad(word, load)) {
        return refusal(
          `${word} on ${row.driverName} is a statement about ${load.loadNumber} (now ${words(load.status)}): the load and the row move together. Record it on the load instead (arrived / loaded / departed / delivered), or set it from the Daily Board's panel.`,
        );
      }
    }
    return {
      ok: true,
      title: `${row.driverName} · ${word} on today's Daily Board`,
      lines: [`${row.status ?? 'No status'} → ${word}`, `Day ${day}${row.truckUnit ? ` · unit ${row.truckUnit}` : ''} · ${row.dispatcherName}`],
      params: { rowId: row.driverId, driverName: row.driverName, day, word, expectedVersion: statusVersion(row, day) },
      fingerprint: `dispatch_status:${row.driverId}:${day}:${word}`,
    };
  },
  async run(ctx, principal, p) {
    const { day, rows } = await boardRows(ctx, principal);
    if (day !== p.day) throw new StaleActionError(`The board moved on to ${day}. Ask again for today.`);
    const row = rows.find((r) => r.driverId === p.rowId);
    if (!row) throw new StaleActionError(`${p.driverName} is no longer on the Daily Board.`);
    if (statusVersion(row, day) !== p.expectedVersion) throw new StaleActionError(`${p.driverName}'s status changed since the plan. Reload the board and ask again.`);
    // The service checks the version again inside its transaction and refuses a stale write.
    await ctx.get(DispatchBoardService).writeCells(principal, {
      cells: [{ driverId: p.rowId, day: p.day, column: 'status', value: p.word, expectedVersion: p.expectedVersion }],
    });
    const cards: AiCard[] = [{ kind: 'link', label: 'Open the Daily Board', to: '/dispatch/daily' }];
    return { text: `${p.driverName} reads ${p.word} on today's Daily Board.`, cards };
  },
};

// ------------------------------------------------------------------------------ the set

/** NeWay AI actions for loads and the Daily Board. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LOAD_ACTIONS: ActionDef<any>[] = [
  loadAssign,
  loadRecordEvent,
  loadCheckCall,
  loadFlag,
  loadCloseFlag,
  loadCancel,
  dispatchSetDriverStatus,
];


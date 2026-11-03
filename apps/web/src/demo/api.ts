import { splitLoadForRecovery, type LoadSegment } from './recovery-split';
/**
 * The application's data API.
 *
 * Trucks and drivers are read from and written to PostgreSQL through `roster-api.ts`; they are the
 * records a user creates and expects to find again in a new session. Everything else is still
 * generated per session and served from memory, and each of those functions resolves after a
 * realistic latency (120–350 ms) and accepts an optional `simulate` option so the UI can
 * demonstrate loading, empty and error states:
 * - `error`: rejects with `Error('Simulated failure')` after the latency
 * - `empty`: returns no rows
 * - `slow`: takes 2.5 s
 */
import {
  duplicateWarning,
  isArchivedTruck,
  planRoute,
  resolveStopZone,
  routeLabel,
  stopHandlingOf,
  suggestionForUpload,
  type DuplicateWarning,
  type StopEdit,
  type StopHandling,
  type UploadSuggestion,
} from '@neway/shared';
import { STATUS, getStatus, type StatusCode } from '@/design-system/status';
import {
  createDriverRecord,
  ensureRoster,
  setDriverStatusRecord,
  setTrailerStatusRecord,
  setTruckStatusRecord,
} from './roster-api';
import {
  demoCompany,
  demoCurrentUser,
  demoData,
  demoMemberships,
  demoUsers,
  isActiveStatus,
} from './data';
import { getInvoiceFromServer, listInvoicesFromServer } from './accounting-server';
import {
  appendFleetAudit,
  cloneValue,
  fleetRespond,
  nowIsoString,
  type SimulateOptions,
} from './internals';
import type {
  ActivityItem,
  AiInsight,
  Broker,
  Company,
  ComplianceAuditEntry,
  Customer,
  DashboardSeries,
  Driver,
  EntityRef,
  FuelTransaction,
  Invoice,
  IsoDateTime,
  IsoDate,
  KpiSnapshot,
  Load,
  LoadDocument,
  MaintenanceItem,
  Membership,
  Notification,
  RepairOrder,
  SafetyEvent,
  ServiceRecord,
  Task,
  Trailer,
  Truck,
  User,
} from './types';
import { markCreated } from '@/lib/recent-creates';
import {
  isServerNotification,
  markAllServerNotificationsRead,
  markServerNotificationRead,
  serverNotifications,
} from './server-notifications';
import { pendingHydration, saveSoon } from './state-persist';
import {
  assignLoadRecord,
  attachLoadDocumentRecord,
  createLoadRecord,
  ensureLoads,
  highestLoadNumberUsed,
  fetchLoad,
  patchLoadRecord,
} from './loads-api';
import { decideLoadCharge } from './loads-server';
import { assertDispatchAllowed, type DispatchOverride } from './dispatch-guard';
import { StopEventsLossError } from './route-guard';
import { paperworkRefusal } from './load-paperwork';

export type { Simulate, SimulateOptions } from './internals';
export { setDemoLatency } from './internals';

export interface ListQuery<TSort extends string = string> extends SimulateOptions {
  search?: string;
  status?: StatusCode | StatusCode[];
  sort?: TSort;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export { demoCompany, demoCurrentUser, demoMemberships, demoUsers };

const respond = fleetRespond;
const clone = cloneValue;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = normalize(needle);
  if (!q) return true;
  return haystack.some(
    (value) => value !== null && value !== undefined && normalize(value).includes(q),
  );
}

function statusFilter<T extends { status: StatusCode }>(
  rows: T[],
  status: ListQuery['status'],
): T[] {
  if (!status) return rows;
  const set = new Set(Array.isArray(status) ? status : [status]);
  return rows.filter((row) => set.has(row.status));
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function sortRows<T extends object>(
  rows: T[],
  sort: string | undefined,
  dir: 'asc' | 'desc' = 'asc',
): T[] {
  if (!sort) return rows;
  const key = sort as keyof T;
  const sorted = [...rows].sort((a, b) => compareValues(a[key], b[key]));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

import { MAX_PAGE_SIZE } from './internals';
export { ALL_ROWS, MAX_PAGE_SIZE } from './internals';

function paginate<T>(rows: T[], query: ListQuery): ListResult<T> {
  const page = Math.max(1, query.page ?? 1);
  /*
   * The cap used to be 200. Every "load everything" read in the app asked for exactly 200 and
   * was quietly handed the first 200 - which is how a workspace with 851 brokers showed a
   * register of 200 and the Brokers page said EVE and Traffix did not exist. The limit guards
   * against a runaway page size, not against the data; a client-side store of a few thousand
   * rows is nothing.
   */
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, query.pageSize ?? 25));
  const start = (page - 1) * pageSize;
  return { data: clone(rows.slice(start, start + pageSize)), total: rows.length, page, pageSize };
}

function emptyList<T>(query: ListQuery): ListResult<T> {
  return { data: [], total: 0, page: Math.max(1, query.page ?? 1), pageSize: query.pageSize ?? 25 };
}

function list<T extends { status: StatusCode }>(
  rows: T[],
  query: ListQuery,
  searchable: (row: T) => Array<string | null | undefined>,
  extraFilter?: (row: T) => boolean,
): Promise<ListResult<T>> {
  return respond(
    query,
    () => {
      let result = statusFilter(rows, query.status);
      if (extraFilter) result = result.filter(extraFilter);
      if (query.search)
        result = result.filter((row) => matches(searchable(row), query.search ?? ''));
      result = sortRows(result, query.sort, query.sortDir);
      return paginate(result, query);
    },
    () => emptyList<T>(query),
  );
}

function one<T>(
  options: SimulateOptions | undefined,
  find: () => T | undefined,
): Promise<T | null> {
  return respond(
    options,
    () => (find() === undefined ? null : clone(find() as T)),
    () => null,
  );
}

// ---------------------------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------------------------

export type TruckSort =
  | 'unitNumber'
  | 'year'
  | 'make'
  | 'status'
  | 'odometer'
  | 'nextServiceOdometer'
  | 'currentDriverName';

/**
 * The trucks of the current fleet. Archived trucks (owner, 2026-10-05) are left out unless the
 * query asks for them by status or with `includeArchived`; `getTruck` still finds them, so their
 * page and every old record that names them keep working.
 */
export async function listTrucks(
  query: ListQuery<TruckSort> & { includeArchived?: boolean } = {},
): Promise<ListResult<Truck>> {
  await ensureRoster();
  const askedForArchived =
    query.includeArchived === true ||
    (Array.isArray(query.status) ? query.status.includes('archived') : query.status === 'archived');
  const rows = askedForArchived ? demoData.trucks : demoData.trucks.filter((t) => !isArchivedTruck(t));
  return list(rows, query, (t) => [
    t.unitNumber,
    t.vin,
    t.make,
    t.model,
    t.plate,
    t.currentDriverName,
    t.location?.city,
  ]);
}

export async function getTruck(idOrUnit: string, options?: SimulateOptions): Promise<Truck | null> {
  await ensureRoster();
  return one(options, () =>
    demoData.trucks.find((t) => t.id === idOrUnit || t.unitNumber === idOrUnit),
  );
}

export type TrailerSort = 'unitNumber' | 'type' | 'status' | 'year' | 'currentTruckUnit';

export async function listTrailers(
  query: ListQuery<TrailerSort> & { type?: Trailer['type'] } = {},
): Promise<ListResult<Trailer>> {
  await ensureRoster();
  return list(
    demoData.trailers,
    query,
    (t) => [t.unitNumber, t.vin, t.make, t.currentTruckUnit],
    (t) => !query.type || t.type === query.type,
  );
}

export async function getTrailer(
  idOrUnit: string,
  options?: SimulateOptions,
): Promise<Trailer | null> {
  await ensureRoster();
  return one(options, () =>
    demoData.trailers.find((t) => t.id === idOrUnit || t.unitNumber === idOrUnit),
  );
}

export type DriverSort =
  | 'name'
  | 'driverNumber'
  | 'status'
  | 'safetyScore'
  | 'currentTruckUnit'
  | 'medicalCardExpiresOn'
  | 'cdlExpiresOn';

export async function listDrivers(
  query: ListQuery<DriverSort> & { dispatcherId?: string; includeArchived?: boolean } = {},
): Promise<ListResult<Driver>> {
  await ensureRoster();
  return list(
    demoData.drivers,
    query,
    (d) => [d.name, d.driverNumber, d.phone, d.email, d.currentTruckUnit],
    // Archived drivers (owner, 2026-10-02) are left out of every list and picker unless asked for.
    (d) =>
      (!query.dispatcherId || d.dispatcherId === query.dispatcherId) &&
      (query.includeArchived === true || !d.archivedAt),
  );
}

export async function getDriver(
  idOrNumber: string,
  options?: SimulateOptions,
): Promise<Driver | null> {
  await ensureRoster();
  return one(options, () =>
    demoData.drivers.find((d) => d.id === idOrNumber || d.driverNumber === idOrNumber),
  );
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export type LoadSort =
  | 'loadNumber'
  | 'status'
  | 'pickupAt'
  | 'deliveryAt'
  | 'rate'
  | 'loadedMiles'
  | 'rpm'
  | 'customerName'
  | 'brokerName'
  | 'driverName';

export interface LoadQuery extends ListQuery<LoadSort> {
  /** Only loads that are not delivered/closed/cancelled/tonu. */
  activeOnly?: boolean;
  /** Only loads with an exception (`at_risk`, `delayed`, `problem`). */
  exceptionsOnly?: boolean;
  driverId?: string;
  truckId?: string;
  customerId?: string;
  brokerId?: string;
}

export async function listLoads(query: LoadQuery = {}): Promise<ListResult<Load>> {
  await ensureLoads();
  return list(
    demoData.loads,
    query,
    (l) => [
      l.loadNumber,
      l.brokerReference,
      l.customerName,
      l.brokerName,
      l.driverName,
      l.truckUnit,
      l.origin.city,
      l.destination.city,
      l.commodity,
    ],
    (l) =>
      (!query.activeOnly || isActiveStatus(l.status)) &&
      (!query.exceptionsOnly || l.exception !== null) &&
      (!query.driverId || l.driverId === query.driverId) &&
      (!query.truckId || l.truckId === query.truckId) &&
      (!query.customerId || l.customerId === query.customerId) &&
      (!query.brokerId || l.brokerId === query.brokerId),
  );
}

export async function getLoad(idOrNumber: string, options?: SimulateOptions): Promise<Load | null> {
  // The server's copy, every time: the board, a colleague or an upload may have moved it.
  const fresh = await fetchLoad(idOrNumber);
  return one(options, () => fresh ?? undefined);
}

/** What a dispatcher supplies when booking a load. Everything else is derived. */
export interface CreateLoadInput {
  customerId: string;
  brokerId: string | null;
  brokerReference: string;
  commodity: string;
  weightLbs: number;
  equipmentType: Load['equipmentType'];
  hazmat: boolean;
  rate: number;
  /** The For driver rate when it differs from the rate (owner, 2026-10-23); null = the same. */
  driverRate?: number | null;
  loadedMiles: number;
  emptyMiles: number;
  origin: { city: string; state: string; zip?: string | null; facilityName?: string; address?: string | null; handling?: StopHandling | null };
  destination: { city: string; state: string; zip?: string | null; facilityName?: string; address?: string | null; handling?: StopHandling | null };
  pickupAt: IsoDateTime;
  /** End of the pickup window; absent means the customer gave one time (P0.4). */
  pickupEndAt?: IsoDateTime | null;
  deliveryAt: IsoDateTime;
  deliveryEndAt?: IsoDateTime | null;
  /** Stops between the first pickup and the final delivery, in running order. */
  extraStops?: {
    kind: 'pickup' | 'delivery';
    city: string;
    state: string;
    zip?: string | null;
    facilityName?: string;
    address?: string | null;
    at: IsoDateTime;
    endAt?: IsoDateTime | null;
    handling?: StopHandling | null;
  }[];
  dispatcherId: string;
  /**
   * The dispatcher's name, when the id is an account rather than one of the seeded users.
   *
   * The person booking the load *is* the dispatcher on it, and a signed-in account is not part of
   * the demo user list — without this the load would be stamped with somebody else's name.
   */
  dispatcherName?: string;
  updaterId?: string | null;
  updaterName?: string | null;
  notes: string | null;
  /** Optional load/trip number from the rate confirmation; the sequence is used when absent. */
  loadNumber?: string;
  /** Optional assignment at booking time, exactly as the old TMS allowed. */
  driverId?: string | null;
  truckId?: string | null;
  trailerId?: string | null;
  /** Only the two states a load can be booked into; anything later is a dispatch event. */
  status?: 'booked' | 'assigned' | 'dispatched';
  /** The reason for putting a held unit on this load (§9.1). Logged on the defect; never silent. */
  dispatchOverride?: DispatchOverride | null;
}

/**
 * A truck going onto a load is asked about first (§9.1): the server's verdict on the unit, at the
 * moment of the write. The same truck staying on the load is not a new assignment and is not
 * asked again; a load that is being taken off a truck has nothing to ask.
 */
/** The workspace, once it has landed; a lookup before that would answer from the wrong dataset. */
async function whenHydrated(): Promise<void> {
  const hydration = pendingHydration();
  if (hydration) await hydration;
}

async function guardTruckAssignment(
  truckId: string | null,
  currentTruckId: string | null,
  loadRef: string,
  override: DispatchOverride | null | undefined,
): Promise<void> {
  if (!truckId || truckId === currentTruckId) return;
  await whenHydrated();
  const truck = demoData.trucks.find((t) => t.id === truckId);
  if (!truck) return; // the write itself answers "Truck not found"
  await assertDispatchAllowed(
    { id: truck.id, unitNumber: truck.unitNumber },
    { ref: loadRef },
    override,
  );
}

/** Next load number in the existing `L-1000xx` sequence, so new work sorts with the rest. */
/** The number the next booked load will get: shown on the form, assigned on save. */
export function peekNextLoadNumber(): string {
  return nextLoadNumber();
}

/** The same, once the loads and the highest number used (hidden loads included) have arrived. */
export async function loadNextLoadNumber(): Promise<string> {
  await ensureLoads();
  return nextLoadNumber();
}

function nextLoadNumber(): string {
  const highest = demoData.loads.reduce((max, load) => {
    const value = Number.parseInt(load.loadNumber.replace(/^L-/, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, Math.max(100000, highestLoadNumberUsed()));
  return `L-${highest + 1}`;
}

/**
 * Books a load and persists it to the in-memory store, so it shows up immediately in the loads
 * register, in the dispatch "no driver or unit" count and in customer and broker performance.
 *
 * `financials` is deliberately left null: a load booked seconds ago has a rate and miles but no
 * fuel, driver pay or maintenance yet. The cost engine reports that as unknown rather than as a
 * zero cost, which would make every new load look perfectly profitable.
 */
export async function createLoad(input: CreateLoadInput, options?: SimulateOptions): Promise<Load> {
  // The hold is checked before the write, against the truck as the store knows it now.
  await guardTruckAssignment(
    input.truckId ?? null,
    null,
    input.loadNumber?.trim() || 'new load',
    input.dispatchOverride,
  );
  await ensureLoads();
  const draft = respond(
    options,
    () => {
      const customer = demoData.customers.find((c) => c.id === input.customerId);
      const broker = input.brokerId
        ? (demoData.brokers.find((b) => b.id === input.brokerId) ?? null)
        : null;
      const dispatcher = demoUsers.find((u) => u.id === input.dispatcherId);
      const driver = input.driverId
        ? (demoData.drivers.find((d) => d.id === input.driverId) ?? null)
        : null;
      const truck = input.truckId
        ? (demoData.trucks.find((t) => t.id === input.truckId) ?? null)
        : null;
      const trailer = input.trailerId
        ? (demoData.trailers.find((t) => t.id === input.trailerId) ?? null)
        : null;
      const requested = input.loadNumber?.trim();
      if (requested && demoData.loads.some((l) => l.loadNumber === requested)) {
        throw new Error(`Load ${requested} already exists`);
      }
      const loadNumber = requested || nextLoadNumber();
      const suffix = loadNumber.replace(/[^A-Za-z0-9]/g, '').slice(-6);
      const now = new Date().toISOString();
      const totalMiles = input.loadedMiles + input.emptyMiles;

      const load: Load = {
        id: `ld_${suffix}`,
        loadNumber,
        status: input.status ?? (driver && truck ? 'assigned' : 'booked'),
        exception: null,
        customerId: input.customerId,
        // Booked without a customer (the form no longer asks), the load carries the broker's name.
        customerName: customer?.name ?? broker?.name ?? 'Direct',
        brokerId: broker?.id ?? null,
        brokerName: broker?.name ?? null,
        brokerReference: input.brokerReference,
        commodity: input.commodity,
        weightLbs: input.weightLbs,
        pieces: 0,
        equipmentType: input.equipmentType,
        temperatureF: null,
        hazmat: input.hazmat,
        dispatcherId: input.dispatcherId,
        dispatcherName: dispatcher?.name ?? input.dispatcherName ?? 'Unassigned',
        updaterId: input.updaterId ?? null,
        updaterName: input.updaterId ? (input.updaterName ?? demoUsers.find((u) => u.id === input.updaterId)?.name ?? null) : null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        truckId: truck?.id ?? null,
        truckUnit: truck?.unitNumber ?? null,
        trailerId: trailer?.id ?? null,
        trailerUnit: trailer?.unitNumber ?? null,
        origin: input.origin,
        destination: input.destination,
        stops: (() => {
          const middles = input.extraStops ?? [];
          /*
           * The stop's clock is the place's (P0.4): ZIP, then city and state. A place nobody can
           * put on the map is left with no zone and shown that way - never stamped with the
           * company's clock, which is how a Newark appointment used to read an hour early.
           */
          const mkStop = (
            seq: number,
            kind: 'pickup' | 'delivery',
            place: { city: string; state: string; zip?: string | null; facilityName?: string; address?: string | null; handling?: StopHandling | null },
            at: IsoDateTime,
            endAt: IsoDateTime | null | undefined,
          ) => {
            const zone = resolveStopZone(place).zone ?? '';
            const window = endAt && Date.parse(endAt) > Date.parse(at) ? endAt : null;
            return {
              id: `stp_${suffix}_${seq}`,
              sequence: seq,
              kind,
              facilityId: '',
              facilityName: place.facilityName?.trim() || `${place.city} ${kind}`,
              address: place.address?.trim() || null,
              city: place.city,
              state: place.state,
              zip: place.zip ?? null,
              timezone: zone,
              appointmentStartAt: at,
              appointmentEndAt: window ?? at,
              appointmentNoWindow: window === null,
              // Live unless the dispatcher said drop (owner, 2026-10-25).
              handling: place.handling === 'drop' ? ('drop' as const) : ('live' as const),
              status: 'pending' as const,
              arrivedAt: null,
              departedAt: null,
              detentionMinutes: 0,
              notes: null,
            };
          };
          return [
            mkStop(1, 'pickup', input.origin, input.pickupAt, input.pickupEndAt),
            ...middles.map((m, k) => mkStop(k + 2, m.kind, m, m.at, m.endAt)),
            mkStop(
              middles.length + 2,
              'delivery',
              input.destination,
              input.deliveryAt,
              input.deliveryEndAt,
            ),
          ];
        })(),
        rate: input.rate,
        driverRate: input.driverRate ?? null,
        loadedMiles: input.loadedMiles,
        emptyMiles: input.emptyMiles,
        rpm: input.loadedMiles > 0 ? Math.round((input.rate / input.loadedMiles) * 100) / 100 : 0,
        charges: [
          {
            id: `chg_${suffix}_1`,
            type: 'linehaul',
            description: 'Linehaul',
            amount: input.rate,
            billable: true,
            payableToDriver: false,
          },
        ],
        expenses: [],
        // No costs booked yet; see the note above.
        financials: null,
        timeline: [
          {
            id: `evt_${suffix}_1`,
            at: now,
            kind: 'booked',
            actorType: 'user',
            actorName: dispatcher?.name ?? 'Dispatcher',
            title: `Load booked${broker ? ` with ${broker.name}` : ''}`,
            detail: `${input.origin.city}, ${input.origin.state} to ${input.destination.city}, ${input.destination.state} · ${totalMiles.toLocaleString('en-US')} total miles`,
            stopId: null,
          },
          // Booked with a driver: assigned and dispatched in the same moment (owner, 2026-10-13).
          ...(driver && (input.status === 'assigned' || input.status === 'dispatched')
            ? [
                {
                  id: `evt_${suffix}_2`,
                  at: now,
                  kind: 'assigned' as const,
                  actorType: 'user' as const,
                  actorName: dispatcher?.name ?? 'Dispatcher',
                  title: `Assigned to ${driver.firstName} ${driver.lastName}${truck ? ` · ${truck.unitNumber}` : ''}`,
                  detail: null,
                  stopId: null,
                },
              ]
            : []),
          ...(driver && input.status === 'dispatched'
            ? [
                {
                  id: `evt_${suffix}_3`,
                  at: now,
                  kind: 'dispatched' as const,
                  actorType: 'user' as const,
                  actorName: dispatcher?.name ?? 'Dispatcher',
                  title: 'Dispatched',
                  detail: null,
                  stopId: null,
                },
              ]
            : []),
        ],
        notes: input.notes
          ? [
              {
                id: `nte_${suffix}_1`,
                kind: 'internal',
                body: input.notes,
                authorName: dispatcher?.name ?? 'Dispatcher',
                at: now,
                pinned: false,
              },
            ]
          : [],
        documents: [],
        pickupAt: input.pickupAt,
        deliveryAt: input.deliveryAt,
        etaAt: null,
        milesRemaining: null,
        bookedAt: now,
        dispatchedAt: input.status === 'dispatched' && driver ? now : null,
        deliveredAt: null,
        invoiceId: null,
        createdAt: now,
        updatedAt: now,
      };

      return load;
    },
    () => {
      throw new Error('Load could not be created');
    },
  );
  /*
   * The document is built here the way it always was; the write is the server's. The number is
   * checked for a twin there, the id and the time are stamped there, and the row comes back as
   * the server holds it.
   */
  const built = await draft;
  return createLoadRecord(built);
}

/**
 * Moves a load onto somebody else mid-run.
 *
 * A truck breaks down, a driver runs out of hours, and the freight still has to move. The
 * original assignment is not edited away: it happened, the miles under it happened, and the
 * recovery is a second fact about the same load. Both end up on the timeline, which is what lets
 * pay and miles be split between the two later.
 */
export interface UpdateLoadInput {
  /** Load id or load number. */
  loadId: string;
  /** Only the fields being changed. Anything left out is untouched. */
  status?: Load['status'];
  /**
   * Why the status moved, in the dispatcher's words.
   *
   * Optional, and only read when `status` actually changes the load: a note on a status that did
   * not move would be history of something that never happened. It rides on the same timeline
   * entry as the change itself rather than becoming a second event.
   */
  statusNote?: string;
  /**
   * The status the caller believed the load was in.
   *
   * Optional, for callers that cannot be stale. A dialog can sit open while the load moves — the
   * driver calls it in, somebody else records it — and a transition chosen against the old status
   * would quietly rewrite that. When this is given and no longer matches, nothing is written.
   */
  expectedStatus?: Load['status'];
  driverId?: string | null;
  truckId?: string | null;
  trailerId?: string | null;
  /** The reason for putting a held unit on this load (§9.1). Logged on the defect; never silent. */
  dispatchOverride?: DispatchOverride | null;
  dispatcherId?: string;
  /** The second owner (rule 1.7); null clears it. */
  updaterId?: string | null;
  updaterName?: string | null;
  customerId?: string;
  brokerId?: string | null;
  brokerReference?: string;
  commodity?: string;
  weightLbs?: number;
  equipmentType?: Load['equipmentType'];
  hazmat?: boolean;
  rate?: number;
  /** The For driver rate; null clears it back to "the same as the rate". */
  driverRate?: number | null;
  loadedMiles?: number;
  emptyMiles?: number;
  /**
   * The whole route, in running order, when it is being changed. Stops are replaced rather than
   * patched: a route is a sequence, and merging two sequences by index is how a delivery ends up
   * in the middle of somebody's run.
   */
  stops?: Array<{
    kind: 'pickup' | 'delivery';
    city: string;
    state: string;
    zip?: string | null;
    /** Appointment start, ISO. */
    at: string;
    /** Appointment end, ISO. Absent keeps the stop's window length; `noWindow` says there is none. */
    endAt?: string | null;
    noWindow?: boolean;
    facilityName?: string;
    address?: string | null;
    /** A zone chosen by hand; otherwise the place's own (P0.4). */
    timezone?: string | null;
    /** Live or drop (owner, 2026-10-25); absent keeps what the stop had. */
    handling?: StopHandling | null;
  }>;
  /**
   * The person has seen which stops would lose their arrival or departure and said yes. Without
   * it a route change that would clear those times is refused with `StopEventsLossError`.
   */
  confirmClearEvents?: boolean;
}

/**
 * A drafted accessorial (a detention the clock wrote) accepted onto the bill or dropped (owner,
 * 2026-10-30). An edit of the load's charges; the server writes the timeline line.
 */
export async function decideDraftCharge(loadId: string, chargeId: string, decision: 'accepted' | 'dropped'): Promise<Load> {
  const stored = await fetchLoad(loadId);
  if (!stored) throw new Error('Load not found');
  const charge = (stored.charges ?? []).find((c) => c.id === chargeId);
  if (!charge || charge.status !== 'draft') throw new Error('That charge is no longer a draft. Reload and try again.');
  // Its own server door (owner, 2026-11-02): Accounting decides charges without loads.edit.
  return decideLoadCharge(stored.id, chargeId, { decision });
}

/**
 * Changes a load in place.
 *
 * The register is where a dispatcher corrects the small things — the wrong unit typed at booking,
 * a rate the broker moved, the status the driver just called in — and making them walk into the
 * load, edit, and walk back out is why those corrections did not get made. Every change is named
 * on the timeline: a rate that moved with no record of who moved it is the thing an audit cannot
 * answer.
 */
export async function updateLoad(input: UpdateLoadInput, options?: SimulateOptions): Promise<Load> {
  /*
   * Retired paths (P1).
   *
   * Status, driver, truck and trailer moved to the server: they carry a rule, a permission, an
   * audit entry and the driver's board row, and none of that can be true if a browser tab can
   * write them straight into the collection. The endpoints are POST /loads/:id/status and
   * POST /loads/:id/assignment; stop times are POST /loads/:id/stop-event.
   */
  if (input.status !== undefined || input.expectedStatus !== undefined) {
    throw new Error('A load status is changed through the server now: POST /loads/:id/status.');
  }
  if (input.driverId !== undefined || input.truckId !== undefined || input.trailerId !== undefined) {
    throw new Error('A load assignment is changed through the server now: POST /loads/:id/assignment.');
  }

  if (input.truckId) {
    await whenHydrated();
    const current = demoData.loads.find(
      (l) => l.id === input.loadId || l.loadNumber === input.loadId,
    );
    await guardTruckAssignment(
      input.truckId,
      current?.truckId ?? null,
      current?.loadNumber ?? input.loadId,
      input.dispatchOverride,
    );
  }
  await ensureLoads();
  /*
   * The edit is worked out on a copy and only the fields that came out different are sent
   * (rule 1.3): opening Edit and changing the reference cannot rewrite the miles, the dispatcher
   * or the times, because those fields are never in the request.
   */
  const edited = await respond(
    options,
    () => {
      const stored = demoData.loads.find(
        (l) => l.id === input.loadId || l.loadNumber === input.loadId,
      );
      if (!stored) throw new Error('Load not found');
      const load = clone(stored);
      if (load.status === 'closed') throw new Error('A closed load cannot be edited');
      // Checked before any field is touched, so a refused change leaves the load exactly as it was.
      if (input.expectedStatus !== undefined && input.expectedStatus !== load.status) {
        throw new Error(
          `${load.loadNumber} is ${load.status.replace(/_/g, ' ')} now, not ${input.expectedStatus.replace(/_/g, ' ')}. Reopen it and try again.`,
        );
      }
      /*
       * The paperwork rule, enforced where the write happens.
       *
       * The dialog disables its button, but a disabled button is a courtesy: this function is the
       * only way a load's status moves, so this is the only place the rule cannot be walked
       * around. It runs before any field is touched, and only on a status that is actually
       * moving — a load already delivered without a POD is history, not a write to refuse.
       */
      if (input.status !== undefined && input.status !== load.status) {
        const refusal = paperworkRefusal(load, input.status, getStatus(input.status).label);
        if (refusal) throw new Error(refusal);
      }

      const now = new Date().toISOString();
      const changes: string[] = [];

      if (input.driverId !== undefined) {
        const driver = input.driverId
          ? demoData.drivers.find((d) => d.id === input.driverId)
          : undefined;
        if (input.driverId && !driver) throw new Error('Driver not found');
        if ((driver?.id ?? null) !== load.driverId) {
          changes.push(
            `Driver ${load.driverName ?? 'unassigned'} → ${driver?.name ?? 'unassigned'}`,
          );
          load.driverId = driver?.id ?? null;
          load.driverName = driver?.name ?? null;
        }
      }

      if (input.truckId !== undefined) {
        const truck = input.truckId
          ? demoData.trucks.find((t) => t.id === input.truckId)
          : undefined;
        if (input.truckId && !truck) throw new Error('Truck not found');
        if ((truck?.id ?? null) !== load.truckId) {
          changes.push(`Unit ${load.truckUnit ?? 'none'} → ${truck?.unitNumber ?? 'none'}`);
          load.truckId = truck?.id ?? null;
          load.truckUnit = truck?.unitNumber ?? null;
        }
      }

      if (input.rate !== undefined && input.rate !== load.rate) {
        if (!Number.isFinite(input.rate) || input.rate < 0)
          throw new Error('That rate is not a number');
        changes.push(`Rate $${load.rate.toFixed(2)} → $${input.rate.toFixed(2)}`);
        load.rate = input.rate;
        const linehaul = load.charges?.find((c) => c.type === 'linehaul');
        // The linehaul charge is what the rate *is*; leaving it behind makes the load disagree
        // with its own invoice.
        if (linehaul) linehaul.amount = input.rate;
      }

      // The For driver rate (owner, 2026-10-23): the same as the rate is stored as null, so it
      // keeps following the rate; billing never reads it.
      if (input.driverRate !== undefined) {
        const next =
          input.driverRate === null || Math.round(input.driverRate * 100) === Math.round(load.rate * 100)
            ? null
            : input.driverRate;
        if (next !== null && (!Number.isFinite(next) || next < 0)) throw new Error('That For driver rate is not a number');
        if (next !== (load.driverRate ?? null)) {
          changes.push(`For driver ${load.driverRate != null ? `$${load.driverRate.toFixed(2)}` : 'same as rate'} → ${next !== null ? `$${next.toFixed(2)}` : 'same as rate'}`);
          load.driverRate = next;
        }
      }

      if (input.trailerId !== undefined) {
        const trailer = input.trailerId
          ? demoData.trailers.find((t) => t.id === input.trailerId)
          : undefined;
        if (input.trailerId && !trailer) throw new Error('Trailer not found');
        if ((trailer?.id ?? null) !== load.trailerId) {
          changes.push(`Trailer ${load.trailerUnit ?? 'none'} → ${trailer?.unitNumber ?? 'none'}`);
          load.trailerId = trailer?.id ?? null;
          load.trailerUnit = trailer?.unitNumber ?? null;
        }
      }

      if (input.customerId !== undefined && input.customerId !== load.customerId) {
        const customer = demoData.customers.find((c) => c.id === input.customerId);
        if (!customer) throw new Error('Customer not found');
        changes.push(`Customer ${load.customerName} → ${customer.name}`);
        load.customerId = customer.id;
        load.customerName = customer.name;
      }

      if (input.brokerId !== undefined) {
        const broker = input.brokerId
          ? demoData.brokers.find((b) => b.id === input.brokerId)
          : undefined;
        if (input.brokerId && !broker) throw new Error('Broker not found');
        if ((broker?.id ?? null) !== load.brokerId) {
          changes.push(`Broker ${load.brokerName ?? 'none'} → ${broker?.name ?? 'none'}`);
          load.brokerId = broker?.id ?? null;
          load.brokerName = broker?.name ?? null;
        }
      }

      if (input.dispatcherId !== undefined && input.dispatcherId !== load.dispatcherId) {
        const dispatcher = demoUsers.find((u) => u.id === input.dispatcherId);
        if (!dispatcher) throw new Error('Dispatcher not found');
        load.dispatcherId = dispatcher.id;
        load.dispatcherName = dispatcher.name;
        changes.push(`Dispatcher → ${load.dispatcherName}`);
      }

      if (input.updaterId !== undefined && (input.updaterId ?? null) !== (load.updaterId ?? null)) {
        load.updaterId = input.updaterId ?? null;
        load.updaterName = input.updaterId ? (input.updaterName ?? demoUsers.find((u) => u.id === input.updaterId)?.name ?? null) : null;
        changes.push(`Updater → ${load.updaterName ?? 'none'}`);
      }

      if (input.brokerReference !== undefined && input.brokerReference !== load.brokerReference) {
        changes.push(
          `Reference ${load.brokerReference || 'none'} → ${input.brokerReference || 'none'}`,
        );
        load.brokerReference = input.brokerReference;
      }
      if (input.commodity !== undefined && input.commodity !== load.commodity) {
        changes.push(`Commodity ${load.commodity} → ${input.commodity}`);
        load.commodity = input.commodity;
      }
      if (input.weightLbs !== undefined && input.weightLbs !== load.weightLbs) {
        changes.push(`Weight ${load.weightLbs} → ${input.weightLbs} lb`);
        load.weightLbs = input.weightLbs;
      }
      if (input.equipmentType !== undefined && input.equipmentType !== load.equipmentType) {
        changes.push(`Equipment ${load.equipmentType} → ${input.equipmentType}`);
        load.equipmentType = input.equipmentType;
      }
      if (input.hazmat !== undefined && input.hazmat !== load.hazmat) {
        changes.push(`Hazmat ${load.hazmat ? 'yes' : 'no'} → ${input.hazmat ? 'yes' : 'no'}`);
        load.hazmat = input.hazmat;
      }
      if (input.loadedMiles !== undefined && input.loadedMiles !== load.loadedMiles) {
        changes.push(`Loaded miles ${load.loadedMiles} → ${input.loadedMiles}`);
        load.loadedMiles = input.loadedMiles;
      }
      if (input.emptyMiles !== undefined && input.emptyMiles !== load.emptyMiles) {
        changes.push(`Empty miles ${load.emptyMiles} → ${input.emptyMiles}`);
        load.emptyMiles = input.emptyMiles;
      }

      if (input.stops && input.stops.length >= 2) {
        /*
         * The route rule is the shared one (P0.2, P0.4): a stop still where it was keeps its
         * record - arrival, departure, detention, notes - because those things happened; a stop
         * whose city changed is a different place and gets that place's own clock, never the
         * old city's; and a change that would clear a recorded arrival or departure is refused
         * until the person has seen it and said yes.
         */
        const edits: StopEdit[] = input.stops.map((stop) => ({
          kind: stop.kind,
          city: stop.city,
          state: stop.state,
          zip: stop.zip ?? undefined,
          at: stop.at,
          endAt: stop.endAt ?? undefined,
          noWindow: stop.noWindow,
          facilityName: stop.facilityName,
          timezone: stop.timezone ?? undefined,
          handling: stop.handling,
        }));
        const plan = planRoute(load.stops, edits, {
          confirmClearEvents: input.confirmClearEvents === true,
          newId: (index) =>
            `stop_${load.loadNumber.replace(/^L-/, '')}_${index + 1}_${Date.now().toString(36)}`,
          make: (base, index) => {
            const existing = load.stops[index];
            // Detention and stop notes belong to the place; a stop that moved city starts clean.
            const moved =
              !existing ||
              existing.city.trim().toLowerCase() !== base.city.toLowerCase() ||
              existing.state.trim().toUpperCase() !== base.state ||
              existing.kind !== base.kind;
            const kept = !moved && existing !== undefined;
            return {
              ...base,
              facilityId: base.facilityId ?? '',
              zip: base.zip,
              // The street line apart from the facility (owner, 2026-10-13); a stop never given
              // one keeps having none, so an unchanged route stays unchanged.
              ...(() => {
                const given = input.stops?.[index]?.address;
                if (given !== undefined && given !== null) return { address: given };
                if (kept && existing.address !== undefined) return { address: existing.address };
                return {};
              })(),
              status: base.status as Load['stops'][number]['status'],
              detentionMinutes: kept ? existing.detentionMinutes : 0,
              notes: kept ? existing.notes : null,
            };
          },
        });
        if (plan.losses.length > 0 && input.confirmClearEvents !== true) {
          throw new StopEventsLossError(plan.losses);
        }
        if (plan.changed) {
          const before = routeLabel(load.stops);
          const zonesBefore = load.stops.map((stop) => stop.timezone);
          const handlingBefore = load.stops.map((stop) => stopHandlingOf(stop));
          load.stops = plan.stops;
          const after = routeLabel(load.stops);
          if (after !== before) changes.push(`Route ${before} → ${after}`);
          load.stops.forEach((stop, index) => {
            const was = zonesBefore[index];
            if (was !== undefined && was !== stop.timezone) {
              changes.push(
                `Stop ${index + 1} clock ${was || 'unknown'} → ${stop.timezone || 'unknown'}`,
              );
            }
            const handlingWas = handlingBefore[index];
            if (handlingWas !== undefined && handlingWas !== stopHandlingOf(stop)) {
              changes.push(`Stop ${index + 1} ${handlingWas === 'drop' ? 'Drop' : 'Live'} → ${stopHandlingOf(stop) === 'drop' ? 'Drop' : 'Live'}`);
            }
          });
          for (const loss of plan.losses) {
            changes.push(
              `Stop ${loss.index + 1} arrival and departure cleared (${loss.from} → ${loss.to})`,
            );
          }
          if (
            after === before &&
            plan.losses.length === 0 &&
            !changes.some((c) => c.startsWith('Stop '))
          ) {
            changes.push('Appointments changed');
          }
        }

        const first = load.stops[0];
        const last = load.stops[load.stops.length - 1];
        if (first && last) {
          load.origin = { city: first.city, state: first.state };
          load.destination = { city: last.city, state: last.state };
          load.pickupAt = first.appointmentStartAt;
          load.deliveryAt = last.appointmentStartAt;
        }
      }

      if (input.status !== undefined && input.status !== load.status) {
        const from = load.status;
        load.status = input.status;
        const statusNote = input.statusNote?.trim();
        changes.push(
          `Status ${from.replace(/_/g, ' ')} -> ${input.status.replace(/_/g, ' ')}` +
            (statusNote ? ` — ${statusNote}` : ''),
        );
        if (input.status === 'delivered') {
          load.deliveredAt = load.deliveredAt ?? now;
          // A delivered load with a stop still pending is what makes the route card contradict
          // the status line above it.
          for (const stop of load.stops) {
            if (stop.status !== 'completed') stop.status = 'completed';
          }
          load.exception = null;
        }
        if (input.status === 'in_transit' && !load.dispatchedAt) load.dispatchedAt = now;
      }

      // Rate per mile is derived, so it follows whichever of the two moved.
      load.rpm =
        load.loadedMiles > 0 ? Math.round((load.rate / load.loadedMiles) * 100) / 100 : load.rpm;

      if (changes.length === 0) return { stored, draft: load, summary: '' };

      load.updatedAt = now;
      load.timeline.push({
        id: `evt_${load.loadNumber.slice(2)}_${load.timeline.length + 1}`,
        at: now,
        kind: 'note_added',
        actorType: 'user',
        actorName: demoCurrentUser.name,
        title: 'Load edited',
        detail: changes.join(' · '),
        stopId: null,
      });

      // The write is what earns the save. A no-op returned above, and a refusal threw, so neither
      // reaches this line; the persistence layer still decides whether the snapshot is accepted.
      saveSoon();

      return { stored, draft: load, summary: changes.join(' · ') };
    },
    () => {
      throw new Error('The load could not be saved');
    },
  );
  return patchLoadRecord(edited.stored, edited.draft, edited.summary || undefined);
}

export interface RecoverLoadInput {
  /** Load id or load number. */
  loadId: string;
  /** Who takes the freight from here. */
  driverId: string | null;
  /** The truck it moves onto. */
  truckId: string | null;
  /** The reason for putting a held unit on this load (§9.1). Logged on the defect; never silent. */
  dispatchOverride?: DispatchOverride | null;
  /** Why it left the driver who had it. Recorded on the load and on both settlements. */
  reason: string;
  /** How far into the run the outgoing driver got, measured from the start of the load. */
  milesCompleted: number;
}

export async function recoverLoad(
  input: RecoverLoadInput,
  options?: SimulateOptions,
): Promise<Load> {
  if (input.truckId) {
    await whenHydrated();
    const current = demoData.loads.find(
      (l) => l.id === input.loadId || l.loadNumber === input.loadId,
    );
    await guardTruckAssignment(
      input.truckId,
      current?.truckId ?? null,
      current?.loadNumber ?? input.loadId,
      input.dispatchOverride,
    );
  }
  await ensureLoads();
  const recovered = await respond(
    options,
    () => {
      const stored = demoData.loads.find(
        (l) => l.id === input.loadId || l.loadNumber === input.loadId,
      );
      if (!stored) throw new Error('Load not found');
      const load = clone(stored);
      if (load.status === 'delivered' || load.status === 'closed') {
        throw new Error('A delivered load cannot be recovered');
      }
      if (input.driverId && input.driverId === load.driverId) {
        throw new Error('That driver already has this load');
      }

      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;
      if (input.driverId && !driver) throw new Error('Driver not found');
      const truck = input.truckId ? demoData.trucks.find((t) => t.id === input.truckId) : undefined;
      if (input.truckId && !truck) throw new Error('Truck not found');

      const fromDriver = load.driverName ?? 'nobody';
      const fromUnit = load.truckUnit ?? 'no unit';
      const now = new Date().toISOString();

      /*
       * The linehaul is what gets divided. Accessorials are earned by whoever did the work they
       * pay for — a detention hour belongs to the driver who sat through it, not to a share.
       */
      const linehaul = load.charges?.find((c) => c.type === 'linehaul')?.amount ?? load.rate ?? 0;

      const segments = splitLoadForRecovery({
        loadedMiles: load.loadedMiles,
        emptyMiles: load.emptyMiles,
        linehaul,
        milesCompleted: input.milesCompleted,
        outgoing: {
          driverId: load.driverId,
          driverName: load.driverName,
          truckId: load.truckId,
          unitNumber: load.truckUnit,
        },
        incoming: {
          driverId: driver?.id ?? null,
          driverName: driver?.name ?? null,
          truckId: truck?.id ?? null,
          unitNumber: truck?.unitNumber ?? null,
        },
        reason: input.reason,
        at: now,
        existing: load.segments,
      });

      load.segments = segments;
      load.driverId = driver?.id ?? null;
      load.driverName = driver?.name ?? null;
      load.truckId = truck?.id ?? null;
      load.truckUnit = truck?.unitNumber ?? null;
      load.milesRemaining = segments[segments.length - 1]?.loadedMiles ?? load.milesRemaining;
      load.updatedAt = now;

      const handed = segments[segments.length - 2];
      const taken = segments[segments.length - 1];

      /*
       * The event is the server's: it goes with the assignment, titled "Recovered from", with the
       * split in its detail. Kept here on the draft so the caller reads it before the refetch.
       */
      load.recoveryEvent = {
        fromDriverName: fromDriver,
        fromUnit,
        summary:
          `${fromDriver} keeps ${(handed?.loadedMiles ?? 0).toLocaleString('en-US')} mi ` +
          `($${(handed?.linehaulRevenue ?? 0).toFixed(2)}), ` +
          `${taken?.driverName ?? 'unassigned'} takes ${(taken?.loadedMiles ?? 0).toLocaleString('en-US')} mi ` +
          `($${(taken?.linehaulRevenue ?? 0).toFixed(2)}).`,
      };

      // Both drivers are owed their share now, not whenever somebody remembers to tell payroll.
      for (const segment of [handed, taken]) {
        if (segment) postRecoveryPay(load, segment);
      }

      return { stored, draft: load };
    },
    () => {
      throw new Error('The load could not be recovered');
    },
  );
  /*
   * Two writes, in the order the server's own rules need them: who has the freight now goes
   * through the assignment route, which moves the driver's board row; the split of the run
   * between the two drivers is an edit of the load's own fields.
   */
  const { stored, draft } = recovered;
  const reassigned = await assignLoadRecord(stored, {
    driverId: draft.driverId,
    driverName: draft.driverName,
    truckId: draft.truckId,
    truckUnit: draft.truckUnit,
    note: input.reason,
    recovery: draft.recoveryEvent,
  });
  const merged = { ...reassigned, segments: draft.segments, milesRemaining: draft.milesRemaining };
  return patchLoadRecord(reassigned, merged);
}

/**
 * Puts one segment's pay in front of accounting.
 *
 * It lands on the driver's open draft settlement, opening one for the current week if they have
 * none. A draft is the right home: the money is owed and visible on the settlement the driver
 * will be paid from, and a human still approves it before anybody is paid.
 */
function postRecoveryPay(load: Load, segment: LoadSegment): void {
  if (!segment.driverId) return;

  const day = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const periodEnd = new Date(nowMs).toISOString().slice(0, 10);
  const periodStart = new Date(nowMs - 6 * day).toISOString().slice(0, 10);

  let settlement = demoData.settlements.find(
    (s) => s.driverId === segment.driverId && s.status === 'draft',
  );
  if (!settlement) {
    const driver = demoData.drivers.find((d) => d.id === segment.driverId);
    settlement = {
      id: `set_rec_${segment.driverId}_${demoData.settlements.length + 1}`,
      settlementNumber: `S-${String(9000 + demoData.settlements.length + 1)}`,
      driverId: segment.driverId,
      driverName: segment.driverName ?? driver?.name ?? 'Unknown driver',
      truckId: segment.truckId,
      unitNumber: segment.unitNumber,
      periodStart,
      periodEnd,
      status: 'draft',
      payPlanKind: driver?.payPlan.kind ?? 'percent_of_linehaul',
      payPlanRate: driver?.payPlan.rate ?? 0,
      gross: 0,
      deductions: 0,
      escrow: 0,
      adjustments: 0,
      net: 0,
      loadCount: 0,
      totalMiles: 0,
      lines: [],
      excluded: [],
      shortfall: null,
      finalizedAt: null,
      finalizedBy: null,
      paidAt: null,
      paymentId: null,
      notes: 'Opened by a load recovery.',
    };
    demoData.settlements.unshift(settlement);
  }

  /*
   * One line per segment, addressed by id. Recovering the same load again re-states this
   * driver's share instead of paying the same miles a second time.
   */
  const lineId = `sl_${load.id}_${segment.id}`;
  const at = settlement.lines.findIndex((line) => line.id === lineId);
  const line = {
    id: lineId,
    settlementId: settlement.id,
    kind: 'load_pay' as const,
    loadId: load.id,
    loadNumber: load.loadNumber,
    description: `${load.loadNumber} — ${segment.handoffReason ? 'run until handover' : 'recovered run'}`,
    amount: segment.linehaulRevenue,
    basis:
      `${segment.loadedMiles.toLocaleString('en-US')} of ` +
      `${load.loadedMiles.toLocaleString('en-US')} loaded mi on ${load.loadNumber}` +
      (segment.handoffReason ? ` — handed over: ${segment.handoffReason}` : ''),
  };
  const milesDelta = at >= 0 ? 0 : segment.loadedMiles + segment.emptyMiles;
  if (at >= 0) settlement.lines[at] = line;
  else settlement.lines.push(line);

  settlement.gross = Math.round(settlement.lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  settlement.net =
    Math.round(
      (settlement.gross - settlement.deductions - settlement.escrow + settlement.adjustments) * 100,
    ) / 100;
  settlement.loadCount = new Set(settlement.lines.map((l) => l.loadId).filter(Boolean)).size;
  settlement.totalMiles += milesDelta;
}

export interface UploadLoadDocumentInput {
  /** Load id or load number. */
  loadId: string;
  type: LoadDocument['type'];
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  /** From `uploadFile`: the bytes are already in the file store. */
  fileUrl: string;
  fileId: string;
  uploadedBy: string;
  /** SHA-256 of the bytes when the browser computed one; used to catch the same file filed twice. */
  fileHash?: string | null;
  /** A title of the person's choosing; the type's own name when left out. */
  title?: string;
  /** Kept on the timeline entry, beside the filename. */
  note?: string;
  /** A lumper receipt's amount: the charge is added with the receipt (owner, 2026-11-02). */
  chargeAmount?: number | null;
}

/**
 * What filing `type` on this load would suggest (P0.5): "Mark loaded at 8:10 AM CDT?" for a
 * BOL, "Delivered at …?" for a POD, nothing for the rest. A suggestion is a question for the
 * person; `confirmUploadSuggestion` in `loads-server` is the answer, and the only thing that
 * moves the load.
 */
export function suggestionForLoadDocument(
  load: Pick<Load, 'status' | 'stops'>,
  type: LoadDocument['type'],
): UploadSuggestion | null {
  return suggestionForUpload(load, type, nowIsoString());
}

/** The same file already filed under another type on this load, if it is (P0.5). */
export function duplicateDocumentWarning(
  load: Pick<Load, 'documents'>,
  candidate: { type: LoadDocument['type']; fileName: string; fileHash?: string | null },
): DuplicateWarning | null {
  return duplicateWarning(
    load.documents.filter((doc) => doc.status !== 'missing'),
    candidate,
  );
}

const DOCUMENT_TITLES: Record<LoadDocument['type'], string> = {
  rate_confirmation: 'Rate confirmation',
  bol: 'Bill of lading',
  pod: 'Proof of delivery',
  invoice: 'Invoice',
  lumper_receipt: 'Lumper receipt',
  detention: 'Detention paperwork',
  tonu: 'TONU paperwork',
  layover: 'Layover paperwork',
  other: 'Other paperwork',
};

/**
 * Attaches a real file to a load's paperwork. A missing slot becomes the uploaded document;
 * re-uploading replaces the file. The event lands on the load's timeline, so billing can see
 * when the POD actually arrived.
 *
 * Filing changes nothing else (P0.5). The document arrives as *received* - no person has
 * verified it, so it is not marked verified - and the load's status, stops, problems and
 * dispatch time are exactly what they were. What the document suggests is asked through
 * `suggestionForLoadDocument`, and a person's yes goes through the server.
 */
export async function uploadLoadDocument(input: UploadLoadDocumentInput): Promise<Load> {
  await ensureLoads();
  const stored = demoData.loads.find((l) => l.id === input.loadId || l.loadNumber === input.loadId);
  if (!stored) throw new Error('Load not found');
  /*
   * Filed by the server (P0.5): the document arrives as *received*, no person has verified it,
   * and the load's status, stops, problems and dispatch time are exactly what they were. What
   * the document suggests is asked through `suggestionForLoadDocument`, and a person's yes goes
   * through the server as its own write.
   */
  return attachLoadDocumentRecord(stored, {
    type: input.type,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    fileUrl: input.fileUrl,
    fileId: input.fileId,
    fileHash: input.fileHash ?? null,
    title: input.title?.trim() || DOCUMENT_TITLES[input.type],
    chargeAmount: input.type === 'lumper_receipt' ? (input.chargeAmount ?? null) : null,
    note: input.note?.trim() || null,
  });
}

/** What a recruiter supplies when adding a driver. Everything else is derived. */
export interface CreateDriverInput {
  /** A second number and what it is; optional. */
  secondaryPhone?: string | null;
  secondaryPhoneLabel?: 'cell' | 'home' | 'spouse' | 'dispatch_only' | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  driverType: Driver['driverType'];
  cdlState: string;
  cdlClass: Driver['cdlClass'];
  cdlEndorsements: string[];
  cdlExpiresOn: IsoDate;
  medicalCardExpiresOn: IsoDate | null;
  /** Optional (owner, 2026-10-25); the API refuses a future date and an age outside 18–100. */
  dateOfBirth?: IsoDate | null;
  hireDate: IsoDate;
  homeCity: string;
  homeState: string;
  dispatcherId: string;
  payPlan: Driver['payPlan'];
  preferredLanguage: Driver['preferredLanguage'];
  /** The unit they take, when one is free. The server pairs both sides. */
  truckId?: string | null;
  /** The Daily board row this driver file is made for; the server links the two (owner, 2026-10-26). */
  boardRowId?: string | null;
}

/**
 * Adds a driver and opens their qualification file in the same write.
 *
 * The file is the point. A driver record on its own would show up in Operations as dispatchable,
 * which is wrong: nobody may drive before safety has their credentials. Creating the CDL and
 * medical-card items from the dates entered, and leaving every other requirement with nothing on
 * file, makes the compliance engine report the new hire as non-compliant and non-dispatchable from
 * the first second — which is the truth until the documents are collected and verified.
 *
 * The driver starts `off_duty` rather than `available` for the same reason.
 */
/**
 * Adds a driver, and opens their qualification file in the same write.
 *
 * The record itself is written to the database, which is the whole point: a driver a recruiter
 * enters on Tuesday has to be on the roster on Wednesday. The qualification file is still session
 * state, because the compliance tables do not exist yet — a new driver therefore comes back after
 * a refresh with nothing on file, which is the correct standing for someone whose documents have
 * not been collected, and the dispatch hold that follows from it is the correct hold.
 */
export async function createDriver(
  input: CreateDriverInput,
  options?: SimulateOptions,
): Promise<Driver> {
  if (options?.simulate === 'error') {
    await respond(
      options,
      () => null,
      () => null,
    ).catch(() => undefined);
    throw new Error('Simulated failure');
  }

  const driver = await createDriverRecord({
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    secondaryPhone: input.secondaryPhone ?? null,
    secondaryPhoneLabel: input.secondaryPhoneLabel ?? null,
    email: input.email,
    driverType: input.driverType,
    cdlState: input.cdlState,
    cdlClass: input.cdlClass,
    cdlEndorsements: input.cdlEndorsements,
    cdlExpiresOn: input.cdlExpiresOn,
    medicalCardExpiresOn: input.medicalCardExpiresOn,
    dateOfBirth: input.dateOfBirth ?? null,
    hireDate: input.hireDate,
    dispatcherId: input.dispatcherId,
    homeCity: input.homeCity,
    homeState: input.homeState,
    truckId: input.truckId ?? null,
    payPlan: input.payPlan,
    preferredLanguage: input.preferredLanguage,
    ...(input.boardRowId ? { boardRowId: input.boardRowId } : {}),
  });

  appendAudit({
    by: demoCurrentUser.name,
    action: 'item_updated',
    entity: { type: 'driver', id: driver.id, label: driver.name },
    subject: 'Driver qualification file',
    before: null,
    after: 'Opened with CDL and medical certificate pending verification',
    reason: 'New driver added',
  });

  return clone(driver);
}

/** What is needed to set a broker up. Everything else starts empty because it has to be earned. */
export interface CreateBrokerInput {
  name: string;
  mcNumber: string;
  usdot: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  paymentTermsDays: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** Set when the carrier already knows not to haul for them. */
  doNotUse: boolean;
  doNotUseReason: string | null;
}

/**
 * Adds a broker.
 *
 * Everything a broker has to earn starts at nothing: no rating, no loads, no revenue, no
 * outstanding balance. Those are real zeroes for a relationship that has not started, not unknowns
 * — except the rating, which is null, because a brand-new broker is unrated rather than rated zero.
 *
 * The risk engine will report `insufficient_data` for them until they have settled enough loads to
 * be graded, which is the correct answer and needs no special casing here.
 */
export function createBroker(input: CreateBrokerInput, options?: SimulateOptions): Promise<Broker> {
  return respond(
    options,
    () => {
      const mc = input.mcNumber.trim().toUpperCase();
      if (mc && demoData.brokers.some((b) => b.mcNumber.toUpperCase() === mc)) {
        throw new Error(`A broker with MC ${mc} already exists`);
      }
      const id = `brk_${String(demoData.brokers.length + 1).padStart(2, '0')}`;
      const broker: Broker = {
        id,
        name: input.name.trim(),
        mcNumber: mc,
        usdot: input.usdot.trim(),
        address: {
          line1: input.addressLine1.trim(),
          city: input.city.trim(),
          state: input.state.trim().toUpperCase(),
          zip: input.zip.trim(),
        },
        paymentTermsDays: input.paymentTermsDays,
        rating: null,
        doNotUse: input.doNotUse,
        doNotUseReason: input.doNotUse ? input.doNotUseReason : null,
        status: input.doNotUse ? 'on_hold' : 'active',
        primaryContact: {
          name: input.contactName.trim(),
          email: input.contactEmail.trim(),
          phone: input.contactPhone.trim(),
        },
        loadsLast90d: 0,
        revenueLast90d: 0,
        outstandingBalance: 0,
      };

      demoData.brokers.unshift(broker);
      markCreated(broker.id);

      appendAudit({
        by: demoCurrentUser.name,
        action: 'status_changed',
        entity: { type: 'broker', id, label: broker.name },
        subject: 'Broker record',
        before: null,
        after: getStatus(broker.status).label,
        reason: input.doNotUse
          ? `Added flagged do-not-use: ${input.doNotUseReason ?? 'no reason recorded'}`
          : 'Broker added',
      });

      return clone(broker);
    },
    () => {
      throw new Error('Broker could not be created');
    },
  );
}

export function listCustomers(
  query: ListQuery<'name' | 'loadsLast90d' | 'revenueLast90d'> = {},
): Promise<ListResult<Customer>> {
  return list(demoData.customers, query, (c) => [c.name, c.mcNumber, c.primaryContact.name]);
}

export function listBrokers(
  query: ListQuery<
    'name' | 'rating' | 'loadsLast90d' | 'revenueLast90d' | 'outstandingBalance'
  > = {},
): Promise<ListResult<Broker>> {
  return list(demoData.brokers, query, (b) => [b.name, b.mcNumber, b.primaryContact.name]);
}

// ---------------------------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------------------------

export type MaintenanceSort =
  'unitNumber' | 'type' | 'status' | 'milesUntilDue' | 'daysUntilDue' | 'nextDueAt';

export function listMaintenance(
  query: ListQuery<MaintenanceSort> & { truckId?: string } = {},
): Promise<ListResult<MaintenanceItem>> {
  return list(
    demoData.maintenance,
    query,
    (m) => [m.unitNumber, m.typeLabel, m.vendorName],
    (m) => !query.truckId || m.truckId === query.truckId,
  );
}

export type RepairOrderSort =
  'roNumber' | 'unitNumber' | 'status' | 'openedAt' | 'total' | 'priority';

export function listRepairOrders(
  query: ListQuery<RepairOrderSort> & { truckId?: string } = {},
): Promise<ListResult<RepairOrder>> {
  return list(
    demoData.repairOrders,
    query,
    (r) => [r.roNumber, r.unitNumber, r.summary, r.vendorName],
    (r) => !query.truckId || r.truckId === query.truckId,
  );
}

export function getRepairOrder(
  idOrNumber: string,
  options?: SimulateOptions,
): Promise<RepairOrder | null> {
  return one(options, () =>
    demoData.repairOrders.find((r) => r.id === idOrNumber || r.roNumber === idOrNumber),
  );
}

export interface ServiceRecordQuery extends SimulateOptions {
  truckId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listServiceRecords(
  query: ServiceRecordQuery = {},
): Promise<ListResult<ServiceRecord>> {
  return respond(
    query,
    () => {
      let rows = demoData.serviceRecords.filter(
        (r) => !query.truckId || r.truckId === query.truckId,
      );
      if (query.search)
        rows = rows.filter((r) =>
          matches([r.unitNumber, r.description, r.vendorName, r.typeLabel], query.search ?? ''),
        );
      return paginate(rows, query);
    },
    () => emptyList<ServiceRecord>(query),
  );
}

// ---------------------------------------------------------------------------------------------
// Fuel & safety
// ---------------------------------------------------------------------------------------------

export type FuelSort = 'at' | 'unitNumber' | 'gallons' | 'amount' | 'pricePerGallon' | 'status';

export function listFuelTransactions(
  query: ListQuery<FuelSort> & {
    truckId?: string;
    driverId?: string;
    anomaliesOnly?: boolean;
  } = {},
): Promise<ListResult<FuelTransaction>> {
  return list(
    demoData.fuelTransactions,
    query,
    (f) => [
      f.unitNumber,
      f.driverName,
      f.station.name,
      f.station.city,
      f.station.state,
      f.cardLast4,
    ],
    (f) =>
      (!query.truckId || f.truckId === query.truckId) &&
      (!query.driverId || f.driverId === query.driverId) &&
      (!query.anomaliesOnly || f.anomalyFlags.length > 0),
  );
}

export type SafetySort = 'at' | 'driverName' | 'kind' | 'severity' | 'unitNumber';

export function listSafetyEvents(
  query: ListQuery<SafetySort> & {
    driverId?: string;
    truckId?: string;
    kind?: SafetyEvent['kind'];
  } = {},
): Promise<ListResult<SafetyEvent>> {
  return list(
    demoData.safetyEvents,
    query,
    (e) => [e.driverName, e.unitNumber, e.kind, e.location.city],
    (e) =>
      (!query.driverId || e.driverId === query.driverId) &&
      (!query.truckId || e.truckId === query.truckId) &&
      (!query.kind || e.kind === query.kind),
  );
}

// ---------------------------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------------------------

export type InvoiceSort =
  | 'invoiceNumber'
  | 'billToName'
  | 'issuedOn'
  | 'dueOn'
  | 'total'
  | 'balance'
  | 'status'
  | 'agingDays';

/** Invoices live on the server since 2026-09-27; see `accounting-server.ts`. */
export function listInvoices(
  query: ListQuery<InvoiceSort> & { billToId?: string; agingBucket?: Invoice['agingBucket'] } = {},
): Promise<ListResult<Invoice>> {
  return listInvoicesFromServer({ ...query, sort: query.sort as string | undefined });
}

export function getInvoice(idOrNumber: string): Promise<Invoice | null> {
  return getInvoiceFromServer(idOrNumber);
}

// ---------------------------------------------------------------------------------------------
// Notifications, tasks, activity, AI
// ---------------------------------------------------------------------------------------------

export interface NotificationQuery extends SimulateOptions {
  unreadOnly?: boolean;
  severity?: Notification['severity'];
  department?: Notification['department'];
}

export async function listNotifications(
  query: NotificationQuery = {},
): Promise<{ data: Notification[]; total: number; unread: number }> {
  const [local, server] = await Promise.all([listWorkspaceNotifications(query), serverNotifications(query)]);
  if (server.length === 0) return local;
  const data = [...server, ...local.data].sort((a, b) => b.at.localeCompare(a.at));
  return { data, total: data.length, unread: local.unread + server.filter((n) => n.readAt === null).length };
}

function listWorkspaceNotifications(
  query: NotificationQuery = {},
): Promise<{ data: Notification[]; total: number; unread: number }> {
  return respond(
    query,
    () => {
      /*
       * A late or action-required item about a load that is delivered or closed is over (rule
       * 1.10): it is dropped rather than left ringing. A flag somebody opened is served by the
       * notification centre from the flags themselves, so a done load with an open flag still
       * shows.
       */
      const done = new Set(
        demoData.loads.filter((l) => ['delivered', 'closed', 'cancelled', 'tonu'].includes(l.status)).map((l) => l.id),
      );
      const stale = (n: Notification) =>
        n.entity?.type === 'load' && done.has(n.entity.id) && (n.actionRequired || n.severity === 'warning' || n.severity === 'critical');
      const rows = demoData.notifications.filter(
        (n) =>
          !stale(n) &&
          (!query.unreadOnly || n.readAt === null) &&
          (!query.severity || n.severity === query.severity) &&
          (!query.department || n.department === query.department),
      );
      return {
        data: clone(rows),
        total: rows.length,
        unread: demoData.notifications.filter((n) => n.readAt === null).length,
      };
    },
    () => ({ data: [], total: 0, unread: 0 }),
  );
}

export async function markNotificationRead(
  id: string,
  options?: SimulateOptions,
): Promise<Notification | null> {
  if (isServerNotification(id)) {
    await markServerNotificationRead(id);
    return null;
  }
  return respond(
    options,
    () => {
      const notification = demoData.notifications.find((n) => n.id === id);
      if (!notification) return null;
      if (notification.readAt === null) notification.readAt = new Date().toISOString();
      return clone(notification);
    },
    () => null,
  );
}

/** Inverse of `markNotificationRead`, so the row menu's "Mark as unread" is a real mutation. */
export function markNotificationUnread(
  id: string,
  options?: SimulateOptions,
): Promise<Notification | null> {
  return respond(
    options,
    () => {
      const notification = demoData.notifications.find((n) => n.id === id);
      if (!notification) return null;
      notification.readAt = null;
      return clone(notification);
    },
    () => null,
  );
}

/** Removes one notification from the store. Returns false when the id is already gone. */
export function deleteNotification(id: string, options?: SimulateOptions): Promise<boolean> {
  return respond(
    options,
    () => {
      const index = demoData.notifications.findIndex((n) => n.id === id);
      if (index === -1) return false;
      demoData.notifications.splice(index, 1);
      return true;
    },
    () => false,
  );
}

export async function markAllNotificationsRead(options?: SimulateOptions): Promise<number> {
  await markAllServerNotificationsRead();
  return respond(
    options,
    () => {
      const now = new Date().toISOString();
      let count = 0;
      for (const n of demoData.notifications) {
        if (n.readAt === null) {
          n.readAt = now;
          count += 1;
        }
      }
      return count;
    },
    () => 0,
  );
}

export type TaskSort = 'dueAt' | 'priority' | 'status' | 'assigneeName' | 'title';

export function listTasks(
  query: ListQuery<TaskSort> & {
    assigneeId?: string;
    department?: Task['department'];
    openOnly?: boolean;
  } = {},
): Promise<ListResult<Task>> {
  return list(
    demoData.tasks,
    query,
    (t) => [t.title, t.description, t.assigneeName],
    (t) =>
      (!query.assigneeId || t.assigneeId === query.assigneeId) &&
      (!query.department || t.department === query.department) &&
      (!query.openOnly || t.status === 'open' || t.status === 'in_progress'),
  );
}

export function listActivity(
  query: SimulateOptions & { limit?: number; department?: ActivityItem['department'] } = {},
): Promise<ActivityItem[]> {
  return respond(
    query,
    () =>
      clone(
        demoData.activity
          .filter((a) => !query.department || a.department === query.department)
          .slice(0, query.limit ?? 40),
      ),
    () => [],
  );
}

export function listAiInsights(
  query: SimulateOptions & {
    severity?: AiInsight['severity'];
    department?: AiInsight['department'];
  } = {},
): Promise<AiInsight[]> {
  return respond(
    query,
    () =>
      clone(
        demoData.aiInsights.filter(
          (i) =>
            (!query.severity || i.severity === query.severity) &&
            (!query.department || i.department === query.department),
        ),
      ),
    () => [],
  );
}

export function getAiInsight(id: string, options?: SimulateOptions): Promise<AiInsight | null> {
  return one(options, () => demoData.aiInsights.find((i) => i.id === id));
}

const nowIso = nowIsoString;

/** The demo-side audit stream for the modules not yet persisted (fleet, brokers, status changes). */
const appendAudit = appendFleetAudit;

// ---------------------------------------------------------------------------------------------
// Entity lifecycle
// ---------------------------------------------------------------------------------------------

/** The collections a lifecycle status change can touch. */
const STATUS_TARGETS = {
  customer: () => demoData.customers,
  broker: () => demoData.brokers,
  driver: () => demoData.drivers,
  truck: () => demoData.trucks,
  trailer: () => demoData.trailers,
  load: () => demoData.loads,
} as const;

export type StatusTargetEntity = keyof typeof STATUS_TARGETS;

export interface ChangeStatusInput {
  entity: StatusTargetEntity;
  id: string;
  toStatus: string;
  /** Why, when the operator gave a reason. Recorded on the audit row. */
  reason?: string | null;
  by?: string;
}

export interface ChangeStatusResult {
  id: string;
  entity: StatusTargetEntity;
  from: string;
  to: string;
  label: string;
  audit: ComplianceAuditEntry;
}

/** Display name for an audit row and a toast, taken from the record itself. */
function entityLabel(entity: StatusTargetEntity, row: Record<string, unknown>): string {
  if (entity === 'truck' || entity === 'trailer') return `Unit ${String(row.unitNumber)}`;
  if (entity === 'load') return String(row.loadNumber);
  return String(row.name ?? row.id);
}

/**
 * Moves an entity to a new status and records who did it, from what, to what and why.
 *
 * This is the only write path for a lifecycle change, so every one of them lands in the audit
 * trail. Nothing is deleted: deactivating and archiving are status changes, which is what keeps a
 * carrier's history intact for an audit.
 *
 * The caller is expected to have run `decideTransition` first; this repeats the cheap checks (the
 * record exists, the status differs) but does not re-derive business rules.
 */
export async function changeEntityStatus(
  input: ChangeStatusInput,
  options?: SimulateOptions,
): Promise<ChangeStatusResult> {
  // Trucks, drivers and trailers are stored records, so their status moves in the database.
  // Everything else is still session state. Without this the deactivation of a unit looked
  // identical to a saved one and came back active on the next refresh.
  if (input.entity === 'truck' || input.entity === 'driver' || input.entity === 'trailer') {
    await ensureRoster();
    const before = STATUS_TARGETS[input.entity]().find((row) => row.id === input.id);
    if (!before) throw new Error(`No ${input.entity} with id ${input.id}`);
    if (before.status === input.toStatus) {
      throw new Error(`Already ${getStatus(input.toStatus as StatusCode).label.toLowerCase()}`);
    }
    const from = before.status;
    const label = entityLabel(input.entity, before as unknown as Record<string, unknown>);
    const saved =
      input.entity === 'truck'
        ? await setTruckStatusRecord(input.id, input.toStatus)
        : input.entity === 'trailer'
          ? await setTrailerStatusRecord(input.id, input.toStatus)
          : await setDriverStatusRecord(input.id, input.toStatus, input.reason ?? null);
    const audit = appendAudit({
      by: input.by ?? demoCurrentUser.name,
      action: 'status_changed',
      entity: { type: input.entity as EntityRef['type'], id: input.id, label },
      subject: 'Status',
      before: getStatus(from as StatusCode).label,
      after: getStatus(saved.status as StatusCode).label,
      reason: input.reason ?? null,
    });
    return { id: input.id, entity: input.entity, from, to: saved.status, label, audit };
  }

  return respond(
    options,
    () => {
      const collection = STATUS_TARGETS[input.entity]() as unknown as Array<
        Record<string, unknown>
      >;
      const row = collection.find((r) => r.id === input.id);
      if (!row) throw new Error(`No ${input.entity} with id ${input.id}`);

      const from = String(row.status);
      if (from === input.toStatus) {
        throw new Error(`Already ${getStatus(input.toStatus as StatusCode).label.toLowerCase()}`);
      }

      // A load's lifecycle actions only cancel or restore today, neither of which needs paperwork
      // — but this is a second door into a load's status, and a second door with no lock is how
      // the rule gets lost the next time an action is added to the lifecycle table.
      if (input.entity === 'load') {
        const refusal = paperworkRefusal(
          row as unknown as Load,
          input.toStatus as Load['status'],
          getStatus(input.toStatus as StatusCode).label,
        );
        if (refusal) throw new Error(refusal);
      }

      row.status = input.toStatus;
      if ('updatedAt' in row) row.updatedAt = nowIso();

      const label = entityLabel(input.entity, row);
      const audit = appendAudit({
        by: input.by ?? demoCurrentUser.name,
        action: 'status_changed',
        entity: { type: input.entity as EntityRef['type'], id: input.id, label },
        subject: 'Status',
        before: getStatus(from as StatusCode).label,
        after: getStatus(input.toStatus as StatusCode).label,
        reason: input.reason ?? null,
      });

      return { id: input.id, entity: input.entity, from, to: input.toStatus, label, audit };
    },
    () => {
      throw new Error('Status could not be changed');
    },
  );
}

/**
 * What is attached to an entity right now, so a status change can be judged before it runs.
 * Counted from live records rather than stored, because a stored count goes stale.
 */
export function countEntityDependencies(
  entity: StatusTargetEntity,
  id: string,
  options?: SimulateOptions,
): Promise<Array<{ key: string; count: number }>> {
  return respond(
    options,
    () => {
      const activeLoads = demoData.loads.filter((l) => isActiveStatus(l.status));
      switch (entity) {
        case 'customer':
          return [
            { key: 'active_loads', count: activeLoads.filter((l) => l.customerId === id).length },
          ];
        case 'broker':
          return [
            { key: 'active_loads', count: activeLoads.filter((l) => l.brokerId === id).length },
          ];
        case 'driver': {
          const driver = demoData.drivers.find((d) => d.id === id);
          return [
            { key: 'active_loads', count: activeLoads.filter((l) => l.driverId === id).length },
            { key: 'assigned_truck', count: driver?.currentTruckId ? 1 : 0 },
          ];
        }
        case 'truck': {
          const truck = demoData.trucks.find((t) => t.id === id);
          return [
            { key: 'active_loads', count: activeLoads.filter((l) => l.truckId === id).length },
            { key: 'assigned_driver', count: truck?.currentDriverId ? 1 : 0 },
          ];
        }
        default:
          return [];
      }
    },
    () => [],
  );
}

// ---------------------------------------------------------------------------------------------
// Dashboard & search
// ---------------------------------------------------------------------------------------------

export interface Dashboard {
  kpis: KpiSnapshot;
  series: DashboardSeries;
  atRiskLoads: Load[];
  upcomingMaintenance: MaintenanceItem[];
  safetyAlerts: SafetyEvent[];
  pendingTasks: Task[];
  recentLoads: Load[];
  activity: ActivityItem[];
  criticalAlerts: Notification[];
  insights: AiInsight[];
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const MAINTENANCE_RANK: Record<MaintenanceItem['status'], number> = {
  overdue: 0,
  in_shop: 1,
  due_soon: 2,
  scheduled: 3,
  ok: 4,
};

export function getDashboard(options?: SimulateOptions): Promise<Dashboard> {
  return respond(
    options,
    () => {
      const atRiskLoads = demoData.loads
        .filter((l) => l.exception !== null && isActiveStatus(l.status))
        .slice(0, 8);
      const upcomingMaintenance = [...demoData.maintenance]
        .filter((m) => m.status !== 'ok')
        .sort(
          (a, b) =>
            MAINTENANCE_RANK[a.status] - MAINTENANCE_RANK[b.status] ||
            a.milesUntilDue - b.milesUntilDue,
        )
        .slice(0, 8);
      const safetyAlerts = demoData.safetyEvents
        .filter((e) => e.status === 'open' && e.severity !== 'low')
        .slice(0, 8);
      const pendingTasks = demoData.tasks
        .filter((t) => t.status === 'open' || t.status === 'in_progress')
        .sort(
          (a, b) =>
            PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.dueAt.localeCompare(b.dueAt),
        )
        .slice(0, 8);
      const recentLoads = [...demoData.loads]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8);
      const criticalAlerts = demoData.notifications
        .filter((n) => n.severity === 'critical' && n.readAt === null)
        .slice(0, 8);
      return clone({
        kpis: demoData.kpis,
        series: demoData.series,
        atRiskLoads,
        upcomingMaintenance,
        safetyAlerts,
        pendingTasks,
        recentLoads,
        activity: demoData.activity.slice(0, 10),
        criticalAlerts,
        insights: demoData.aiInsights.slice(0, 5),
      });
    },
    () => ({
      kpis: {
        ...demoData.kpis,
        totalTrucks: zeroKpi(),
        activeTrucks: zeroKpi(),
        activeLoads: zeroKpi(),
        revenueMtd: zeroKpi(),
        profitMtd: zeroKpi(),
        criticalAlerts: zeroKpi(),
      },
      series: { dailyRevenueProfit: [], weeklyFuelCost: [], fleetHealth: [], loadStatus: [] },
      atRiskLoads: [],
      upcomingMaintenance: [],
      safetyAlerts: [],
      pendingTasks: [],
      recentLoads: [],
      activity: [],
      criticalAlerts: [],
      insights: [],
    }),
  );
}

function zeroKpi(): KpiSnapshot['totalTrucks'] {
  return { value: 0, previous: 0, deltaPercent: 0 };
}

export interface SearchHit {
  id: string;
  label: string;
  secondary: string;
  status: StatusCode | null;
  href: string;
}

export interface GlobalSearchResult {
  query: string;
  total: number;
  trucks: SearchHit[];
  trailers: SearchHit[];
  drivers: SearchHit[];
  loads: SearchHit[];
  customers: SearchHit[];
  brokers: SearchHit[];
  invoices: SearchHit[];
  employees: SearchHit[];
}

const GROUP_LIMIT = 5;

function take<T>(
  rows: T[],
  predicate: (row: T) => boolean,
  toHit: (row: T) => SearchHit,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (predicate(row)) {
      hits.push(toHit(row));
      if (hits.length === GROUP_LIMIT) break;
    }
  }
  return hits;
}

export function globalSearch(
  query: string,
  options?: SimulateOptions,
): Promise<GlobalSearchResult> {
  const empty = (): GlobalSearchResult => ({
    query,
    total: 0,
    trucks: [],
    trailers: [],
    drivers: [],
    loads: [],
    customers: [],
    brokers: [],
    invoices: [],
    employees: [],
  });
  return respond(
    options,
    () => {
      const q = normalize(query);
      if (q.length < 1) return empty();
      const result: GlobalSearchResult = {
        ...empty(),
        trucks: take(
          demoData.trucks.filter((t) => !isArchivedTruck(t)),
          (t) => matches([t.unitNumber, t.vin, t.plate, t.currentDriverName], q),
          (t) => ({
            id: t.id,
            label: `Unit ${t.unitNumber}`,
            secondary: `${t.year} ${t.make} ${t.model} · ${t.currentDriverName ?? 'Unassigned'}`,
            status: t.status,
            href: `/fleet/trucks/${t.id}`,
          }),
        ),
        trailers: take(
          demoData.trailers,
          (t) => matches([t.unitNumber, t.vin], q),
          (t) => ({
            id: t.id,
            label: t.unitNumber,
            secondary: `${t.make} ${t.type.replace('_', ' ')} · ${t.currentTruckUnit ? `Unit ${t.currentTruckUnit}` : 'Unassigned'}`,
            status: t.status,
            href: `/fleet/trailers/${t.id}`,
          }),
        ),
        drivers: take(
          demoData.drivers,
          (d) => matches([d.name, d.driverNumber, d.phone], q),
          (d) => ({
            id: d.id,
            label: d.name,
            secondary: `${d.driverNumber} · ${d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : 'No unit'}`,
            status: d.status,
            href: `/drivers/${d.id}`,
          }),
        ),
        loads: take(
          demoData.loads,
          (l) => matches([l.loadNumber, l.brokerReference, l.customerName, l.brokerName], q),
          (l) => ({
            id: l.id,
            label: l.loadNumber,
            secondary: `${l.origin.city}, ${l.origin.state} → ${l.destination.city}, ${l.destination.state}`,
            status: l.status,
            href: `/dispatch/loads/${l.id}`,
          }),
        ),
        customers: take(
          demoData.customers,
          (c) => matches([c.name, c.mcNumber], q),
          (c) => ({
            id: c.id,
            label: c.name,
            secondary: `${c.address.city}, ${c.address.state}`,
            status: c.status,
            href: `/customers/${c.id}`,
          }),
        ),
        brokers: take(
          demoData.brokers,
          (b) => matches([b.name, b.mcNumber], q),
          (b) => ({
            id: b.id,
            label: b.name,
            secondary: `${b.mcNumber} · Net ${b.paymentTermsDays}`,
            status: b.status,
            href: `/brokers/${b.id}`,
          }),
        ),
        invoices: take(
          demoData.invoices,
          (i) => matches([i.invoiceNumber, i.loadNumber, i.billToName], q),
          (i) => ({
            id: i.id,
            label: i.invoiceNumber,
            secondary: `${i.billToName} · $${i.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
            status: i.status,
            href: `/accounting/invoices/${i.id}`,
          }),
        ),
        employees: take(
          demoUsers,
          (u) => matches([u.name, u.email, u.title], q),
          (u) => ({
            id: u.id,
            label: u.name,
            secondary: u.title,
            status: u.status,
            href: `/staff/${u.id}`,
          }),
        ),
      };
      result.total =
        result.trucks.length +
        result.trailers.length +
        result.drivers.length +
        result.loads.length +
        result.customers.length +
        result.brokers.length +
        result.invoices.length +
        result.employees.length;
      return result;
    },
    empty,
  );
}

// ---------------------------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------------------------

export function getCurrentUser(options?: SimulateOptions): Promise<User> {
  return respond(
    options,
    () => clone(demoCurrentUser),
    () => clone(demoCurrentUser),
  );
}

export function getCompany(options?: SimulateOptions): Promise<Company> {
  return respond(
    options,
    () => clone(demoCompany),
    () => clone(demoCompany),
  );
}

export function listMemberships(options?: SimulateOptions): Promise<Membership[]> {
  return respond(
    options,
    () => clone(demoMemberships),
    () => [],
  );
}

/** Label for a status code, for callers that only have the code. */
export function statusLabel(code: StatusCode): string {
  return STATUS[code].label;
}

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  buildFleetExceptions,
  isActiveUnit,
  isArchivedTruck,
  maintenanceDue,
  summarizeFuel,
  summarizeUnitEconomics,
  summarizeUnitFuel,
  trackingFreshness,
  unitAvailability,
  type FleetExceptionQueue,
  type MaintenanceDue,
  type TrackingFreshness,
  type UnitEconomics,
  type UnitFuelSummary,
  type UnitStatusResult,
} from '@neway/shared';
import type { ComplianceDocument, ExpiryTone } from '@neway/shared';
import { apiGet } from '@/lib/api-client';
import { flushPersistedState } from '@/demo/state-persist';
import { listComplianceDocuments } from '@/features/safety/compliance-api';
import { unitDocumentIssues, worstExpiryTone, type UnitDocumentIssues } from './unit-documents';
import { nextTrailerInspection, type NextTrailerInspection } from './trailer-inspection';
import {
  listFuelTransactions,
  listLoads,
  listMaintenance,
  listRepairOrders,
  listTrailers,
  listTrucks,
  type FuelTransaction,
  type Load,
  type MaintenanceItem,
  type RepairOrder,
  type Trailer,
  type Truck,
  unitDocumentRules,
} from '@/demo';
import { nowIso as clockNowIso, today as companyToday } from '@/lib/clock';

/** The annual inspection, on a truck and on a trailer. Its lapse is a legal stop, not a reminder. */
const ANNUAL_INSPECTION_CODES = new Set(['annual_inspection', 'trailer_annual_inspection']);

/**
 * The demo API caps a page at 200 rows, and the fleet has more PM rows and more fuel fills than
 * that. Asking for a bigger page silently truncates — which is how unit 2758 ended up with an empty
 * service schedule while its neighbours had one — so every list is drained a page at a time.
 * The real API pages and filters server-side; this loop is what a paged client does anyway.
 */
const PAGE = 200;

async function drain<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ data: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(1, PAGE);
  const rows = [...first.data];
  const pages = Math.ceil(first.total / PAGE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchPage(page, PAGE);
    rows.push(...next.data);
  }
  return rows;
}

/** How far back the fuel window looks. Two of these run, so the change is measured, not guessed. */
const FUEL_WINDOW_DAYS = 30;

/** A truck with every derived judgement the Fleet workspace needs, computed once. */
/**
 * Cached for the length of a working session.
 *
 * These bundles are what a module's list pages render from, so the cache decides what "back"
 * feels like. The defaults (30 s stale, 5 min garbage collection) meant a detail page visited for
 * six minutes threw the list's data away, and returning to it showed a skeleton while the whole
 * nested bundle was fetched again. Keeping it an hour costs memory that is already allocated and
 * turns the return trip into a repaint; `refetchOnMount` still brings it up to date in the
 * background, and every mutation invalidates it explicitly.
 */
const BUNDLE_CACHE = { staleTime: 60_000, gcTime: 60 * 60_000 } as const;

export interface FleetTruck {
  truck: Truck;
  availability: UnitStatusResult;
  service: MaintenanceDue;
  tracking: TrackingFreshness;
  /** What this unit's freight earned on the miles it actually turned. */
  economics: UnitEconomics;
  fuel: UnitFuelSummary;
  /** Open work orders against this unit, newest first. */
  /** Work orders still in the shop; what makes a unit unavailable. */
  openWorkOrders: RepairOrder[];
  /**
   * Every work order this unit has ever had, newest first.
   *
   * Separate from the open ones on purpose: availability turns on what is open, but the unit's
   * maintenance record is the whole history — a completed order that vanished from the page is
   * the work somebody did and then could not find.
   */
  allWorkOrders: RepairOrder[];
  /** Every PM row for the unit, worst first. */
  schedule: MaintenanceItem[];
  currentLoad: Load | null;
  trailer: Trailer | null;
  /** The unit's paperwork judged today: what has expired, what is about to, and whether it holds. */
  documents: UnitDocumentIssues;
}

export interface FleetTrailer {
  trailer: Trailer;
  availability: UnitStatusResult;
  truck: Truck | null;
  currentLoad: Load | null;
  /** Work orders opened against the trailer itself, newest first; the open ones hold it. */
  openWorkOrders: RepairOrder[];
  allWorkOrders: RepairOrder[];
  /** The trailer's paperwork judged today. */
  documents: UnitDocumentIssues;
  /**
   * When the next annual inspection is due: the later of the trailer's own date and the expiry of
   * its annual inspection certificate on file (`nextTrailerInspection`).
   */
  nextInspection: NextTrailerInspection;
}

export interface FleetBundle {
  nowIso: string;
  today: string;
  /** The current fleet: every truck except the archived ones. Every list and count reads this. */
  trucks: FleetTruck[];
  /**
   * Archived trucks (owner, 2026-10-05), only for the Trucks page's Archived filter. They are still
   * in `byTruckId` / `byUnitNumber`, so the truck's own page and old records naming it resolve.
   */
  archivedTrucks: FleetTruck[];
  trailers: FleetTrailer[];
  workOrders: RepairOrder[];
  maintenance: MaintenanceItem[];
  fuel: FuelTransaction[];
  loads: Load[];
  exceptions: FleetExceptionQueue;
  /** Fleet fuel economics for the current window and the one before it. */
  fuelSummary: ReturnType<typeof summarizeFuel>;
  priorFuelSummary: ReturnType<typeof summarizeFuel>;
  byTruckId: Map<string, FleetTruck>;
  byUnitNumber: Map<string, FleetTruck>;
  byTrailerId: Map<string, FleetTrailer>;
}

export const FLEET_QUERY_KEY = ['fleet', 'bundle'] as const;

const OPEN_WORK_ORDER = new Set(['open', 'scheduled', 'in_shop']);
const MS_PER_DAY = 86_400_000;

/** A read the account is not allowed to make answers "none"; an outage still throws. */
async function refusedAsEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 401 || status === 403) return [];
    throw error;
  }
}

/**
 * Everything the Fleet workspace knows, derived once.
 *
 * Trucks, trailers, maintenance and fuel are one system, not four pages: the same unit appears in
 * all of them and must carry the same answer in each. Fetching and deriving here — rather than in
 * each page — is what makes that structurally true instead of merely intended.
 */
export async function loadFleetBundle(): Promise<FleetBundle> {
  const [trucks, trailers, maintenance, workOrders, fuel, loads, documents, shopOrders] = await Promise.all([
    drain((page, pageSize) => listTrucks({ page, pageSize, includeArchived: true })),
    drain((page, pageSize) => listTrailers({ page, pageSize })),
    drain((page, pageSize) => listMaintenance({ page, pageSize })),
    drain((page, pageSize) => listRepairOrders({ page, pageSize })),
    drain((page, pageSize) => listFuelTransactions({ page, pageSize })),
    // Loads only add each unit's current load and revenue. A shop account (Maintenance) may not
    // see loads; its refusal must leave the trucks on screen, not blank the whole fleet
    // (Dalton Mattox, 2026-09-30). Any other failure still fails the page.
    refusedAsEmpty(drain((page, pageSize) => listLoads({ page, pageSize }))),
    loadUnitDocuments(),
    // The server's work orders set to "In the shop" hold the unit too (owner, 2026-10-14: unit
    // 334639 was in the shop on RO-2026-1345 but read Available). Voided orders are not listed.
    // Units only, so an account without maintenance.view (Safety) counts the same as Fleet (owner, 2026-11-02).
    refusedAsEmpty(apiGet<{ assetType: string; unitId: string }[]>('/fleet/work-orders/in-shop-units')).catch(
      () => [] as { assetType: string; unitId: string }[],
    ),
  ]);
  const inShop = new Set(shopOrders.map((o) => `${o.assetType}:${o.unitId}`));

  const nowIso = clockNowIso();
  const today = companyToday();
  const nowMs = Date.parse(nowIso);

  const loadById = new Map(loads.map((load) => [load.id, load]));
  const trailerById = new Map(trailers.map((trailer) => [trailer.id, trailer]));
  const truckById = new Map(trucks.map((truck) => [truck.id, truck]));

  const workOrdersByTruck = new Map<string, RepairOrder[]>();
  const workOrdersByTrailer = new Map<string, RepairOrder[]>();
  for (const order of workOrders) {
    // A trailer order is a fact about the trailer; it must not land on a truck's page.
    const byUnit = order.unitType === 'trailer' ? workOrdersByTrailer : workOrdersByTruck;
    const key = order.unitType === 'trailer' ? (order.trailerId ?? '') : order.truckId;
    const bucket = byUnit.get(key);
    if (bucket) bucket.push(order);
    else byUnit.set(key, [order]);
  }

  const maintenanceByTruck = new Map<string, MaintenanceItem[]>();
  for (const item of maintenance) {
    const bucket = maintenanceByTruck.get(item.truckId);
    if (bucket) bucket.push(item);
    else maintenanceByTruck.set(item.truckId, [item]);
  }

  const loadsByTruck = new Map<string, Load[]>();
  for (const load of loads) {
    if (!load.truckId) continue;
    const bucket = loadsByTruck.get(load.truckId);
    if (bucket) bucket.push(load);
    else loadsByTruck.set(load.truckId, [load]);
  }

  // Two equal windows, so a change in cost per mile is a measured difference rather than a feeling.
  const windowStart = nowMs - FUEL_WINDOW_DAYS * MS_PER_DAY;
  const priorStart = windowStart - FUEL_WINDOW_DAYS * MS_PER_DAY;
  const currentFills = fuel.filter((f) => Date.parse(f.at) >= windowStart);
  const priorFills = fuel.filter((f) => {
    const at = Date.parse(f.at);
    return at >= priorStart && at < windowStart;
  });

  const fuelByTruck = new Map<string, FuelTransaction[]>();
  for (const fill of currentFills) {
    const bucket = fuelByTruck.get(fill.truckId);
    if (bucket) bucket.push(fill);
    else fuelByTruck.set(fill.truckId, [fill]);
  }

  const documentsByUnit = new Map<string, ComplianceDocument[]>();
  for (const doc of documents ?? []) {
    const key = `${doc.ownerType}:${doc.ownerId}`;
    const bucket = documentsByUnit.get(key);
    if (bucket) bucket.push(doc);
    else documentsByUnit.set(key, [doc]);
  }
  const rules = unitDocumentRules();
  const documentsFor = (kind: 'truck' | 'trailer', id: string): UnitDocumentIssues =>
    unitDocumentIssues(documentsByUnit.get(`${kind}:${id}`) ?? [], kind, rules, today);

  const fleetTrucks: FleetTruck[] = trucks.map((truck) => {
    const orders = [...(workOrdersByTruck.get(truck.id) ?? [])].sort((a, b) =>
      a.openedAt < b.openedAt ? 1 : -1,
    );
    const open = orders.filter((o) => OPEN_WORK_ORDER.has(o.status));
    const schedule = [...(maintenanceByTruck.get(truck.id) ?? [])];
    const truckLoads = loadsByTruck.get(truck.id) ?? [];
    const unitDocuments = documentsFor('truck', truck.id);

    return {
      truck,
      availability: unitAvailability({
        status: truck.status,
        currentLoadId: truck.currentLoadId,
        speedMph: truck.location?.speedMph ?? null,
        inOpenWorkOrder: open.length > 0 || inShop.has(`truck:${truck.id}`),
        documentHold: unitDocuments.hold,
        // The open driver assignment (owner, 2026-10-22): the server keeps `currentDriverId` in
        // step with the open truck_driver_assignments row in the same transaction, and it is what
        // the Driver column shows - so status and driver can never tell two stories.
        driverAssigned: Boolean(truck.currentDriverId),
      }),
      service: maintenanceDue(
        {
          nextDueOdometer: truck.nextServiceOdometer,
          nextDueAt: truck.nextServiceDate,
          currentOdometer: truck.odometer,
          scheduledFor: schedule.find((m) => m.scheduledFor)?.scheduledFor ?? null,
        },
        today,
      ),
      tracking: trackingFreshness(truck.location?.updatedAt ?? null, nowIso),
      economics: summarizeUnitEconomics(
        truckLoads.map((load) => ({
          id: load.id,
          status: load.status,
          revenue: load.financials?.revenue ?? null,
          loadedMiles: load.loadedMiles,
          emptyMiles: load.emptyMiles,
          costs: load.financials
            ? {
                fuel: load.financials.fuel,
                driverPay: load.financials.driverPay,
                tolls: load.financials.tolls,
                maintenanceAllocation: load.financials.maintenanceAllocation,
                other: load.financials.other,
              }
            : null,
        })),
      ),
      fuel: summarizeUnitFuel(truck.id, fuelByTruck.get(truck.id) ?? []),
      openWorkOrders: open,
      allWorkOrders: orders,
      schedule,
      currentLoad: truck.currentLoadId ? (loadById.get(truck.currentLoadId) ?? null) : null,
      trailer: truck.currentTrailerId ? (trailerById.get(truck.currentTrailerId) ?? null) : null,
      documents: unitDocuments,
    };
  });

  const fleetTrailers: FleetTrailer[] = trailers.map((trailer) => {
    const truck = trailer.currentTruckId ? (truckById.get(trailer.currentTruckId) ?? null) : null;
    const orders = [...(workOrdersByTrailer.get(trailer.id) ?? [])].sort((a, b) =>
      a.openedAt < b.openedAt ? 1 : -1,
    );
    const open = orders.filter((o) => OPEN_WORK_ORDER.has(o.status));
    const unitDocuments = documentsFor('trailer', trailer.id);
    return {
      trailer,
      availability: unitAvailability({
        status: trailer.status,
        currentLoadId: truck?.currentLoadId ?? null,
        speedMph: truck?.location?.speedMph ?? null,
        inOpenWorkOrder: open.length > 0 || inShop.has(`trailer:${trailer.id}`),
        documentHold: unitDocuments.hold,
      }),
      truck,
      currentLoad: truck?.currentLoadId ? (loadById.get(truck.currentLoadId) ?? null) : null,
      openWorkOrders: open,
      allWorkOrders: orders,
      documents: unitDocuments,
      nextInspection: nextTrailerInspection(
        trailer.nextInspectionDate,
        documentsByUnit.get(`trailer:${trailer.id}`) ?? [],
      ),
    };
  });

  // Archived trucks are history: kept for lookups, out of every list, finding and count.
  const archivedTrucks = fleetTrucks.filter((row) => isArchivedTruck(row.truck));
  const currentTrucks = fleetTrucks.filter((row) => !isArchivedTruck(row.truck));

  const allUnits = [
    ...currentTrucks.map((row) => ({
      id: row.truck.id,
      status: row.truck.status,
      documents: row.documents,
    })),
    ...fleetTrailers.map((row) => ({
      id: row.trailer.id,
      status: row.trailer.status,
      documents: row.documents,
    })),
  ];

  // The band of a unit's soonest-expiring (not yet expired) document; a unit with an expired
  // document is listed under expired, never again here.
  const expiringIn = (band: ExpiryTone): string[] =>
    allUnits
      .filter(
        (u) =>
          u.documents.expired.length === 0 &&
          u.documents.expiring.length > 0 &&
          worstExpiryTone(u.documents.expiring.map((i) => i.expiry.tone)) === band,
      )
      .map((u) => u.id);

  const fuelSummary = summarizeFuel(currentFills);
  const priorFuelSummary = summarizeFuel(priorFills);

  const exceptions = buildFleetExceptions(
    {
      trucks: currentTrucks.map((row) => ({
        id: row.truck.id,
        unitNumber: row.truck.unitNumber,
        status: row.truck.status,
        currentLoadId: row.truck.currentLoadId,
        odometer: row.truck.odometer,
        nextServiceOdometer: row.truck.nextServiceOdometer,
        nextServiceDate: row.truck.nextServiceDate,
        // The booking travels with the unit, so the panel judges the same service position the
        // Trucks list does. Without it the panel counted trucks the list then would not show.
        scheduledFor: row.schedule.find((m) => m.scheduledFor)?.scheduledFor ?? null,
        speedMph: row.truck.location?.speedMph ?? null,
        inOpenWorkOrder: row.openWorkOrders.length > 0,
        telematicsStatus: row.truck.telematicsStatus,
      })),
      trailers: fleetTrailers.map(({ trailer, nextInspection }) => ({
        id: trailer.id,
        unitNumber: trailer.unitNumber,
        status: trailer.status,
        currentTruckId: trailer.currentTruckId,
        nextInspectionDate: nextInspection.date,
      })),
      workOrders: workOrders.map((order) => ({
        id: order.id,
        roNumber: order.roNumber,
        status: order.status,
        promisedAt: order.promisedAt,
        completedAt: order.completedAt,
      })),
      costPerMile: fuelSummary.costPerMile,
      priorCostPerMile: priorFuelSummary.costPerMile,
      unitDocuments: documents
        ? {
            expiredUnitIds: allUnits.filter((u) => u.documents.expired.length > 0).map((u) => u.id),
            // Each unit once, in the band of its soonest-expiring document (the shared bands).
            expiringUnitIds: expiringIn('danger'),
            expiringSoonUnitIds: expiringIn('warning'),
            expiringLaterUnitIds: expiringIn('info'),
            // A lapsed annual inspection is its own finding: the unit may not be driven at all.
            // Only units still in service are asked - a sold truck owes nobody an inspection.
            inspectionLapsedUnitIds: allUnits
              .filter(
                (u) =>
                  isActiveUnit(u.status) &&
                  u.documents.expired.some((issue) =>
                    ANNUAL_INSPECTION_CODES.has(issue.document.requirementCode),
                  ),
              )
              .map((u) => u.id),
          }
        : undefined,
    },
    today,
  );

  return {
    nowIso,
    today,
    trucks: currentTrucks,
    archivedTrucks,
    trailers: fleetTrailers,
    workOrders,
    maintenance,
    fuel,
    loads,
    exceptions,
    fuelSummary,
    priorFuelSummary,
    byTruckId: new Map(fleetTrucks.map((row) => [row.truck.id, row])),
    byUnitNumber: new Map(fleetTrucks.map((row) => [row.truck.unitNumber, row])),
    byTrailerId: new Map(fleetTrailers.map((row) => [row.trailer.id, row])),
  };
}

/**
 * Every truck and trailer document in one read. Null when the caller may not see the compliance
 * store (or it is unreachable), so the bundle can say "not loaded" rather than "none expired".
 */
async function loadUnitDocuments(): Promise<ComplianceDocument[] | null> {
  const results = await Promise.allSettled([
    listComplianceDocuments({ ownerType: 'truck' }),
    listComplianceDocuments({ ownerType: 'trailer' }),
  ]);
  if (results.some((r) => r.status === 'rejected')) return null;
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

export function useFleet(): UseQueryResult<FleetBundle> {
  return useQuery({ queryKey: FLEET_QUERY_KEY, queryFn: loadFleetBundle, ...BUNDLE_CACHE });
}

/**
 * Invalidates everything a fleet write can change.
 *
 * A work order moves a truck's status, a fill moves its odometer and an assignment moves a
 * trailer — so a fleet write is never local to one list, and pretending otherwise is how a stale
 * count survives on screen.
 */
export function useInvalidateFleet(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    // The expense summary is computed on the server from the saved workspace; save first, or the
    // refetch below answers from the copy saved before this write.
    await flushPersistedState();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      queryClient.invalidateQueries({ queryKey: ['trucks'] }),
      queryClient.invalidateQueries({ queryKey: ['trailers'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
    ]);
  };
}

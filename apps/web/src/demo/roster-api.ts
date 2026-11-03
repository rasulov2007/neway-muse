import type {
  CreateDriverRequest,
  ChangeTruckVendorPercentRequest,
  CreateTruckRequest,
  EndTruckVendorRequest,
  MoveTruckToVendorRequest,
  DriverRecord,
  CreateTrailerRequest,
  RosterPage,
  TrailerRecord,
  TruckRecord,
  UpdateTrailerRequest,
  UpdateDriverRequest,
  UpdateTruckRequest,
} from '@neway/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { demoData } from './data';
import type { Driver, Trailer, Truck } from './types';
import { markCreated } from '@/lib/recent-creates';

/**
 * The roster, served from the database.
 *
 * Trucks and drivers are the two records in this application that a user creates and expects to
 * find again tomorrow, so they are the two that live in PostgreSQL rather than in this module.
 * Everything else here is still generated per session; the roster is not.
 *
 * `demoData.trucks` and `demoData.drivers` are kept in step with what the server returns, because
 * the generated operational records — loads, work orders, fuel fills, settlements — reference units
 * by id and resolve them through those arrays. Replacing the contents in place rather than
 * reassigning keeps every existing holder of the array pointing at the same, now-authoritative,
 * list.
 */

const PAGE = 200;

async function drain<T>(path: string): Promise<T[]> {
  // Archived drivers and archived trucks come too: names and unit numbers on old records still
  // resolve, and the Archived tab / filter lists them. Every list and picker leaves them out
  // (listTrucks, the fleet bundle), so holding them here shows them nowhere new.
  const first = await apiGet<RosterPage<T>>(path, {
    page: 1,
    pageSize: PAGE,
    includeInactive: true,
    includeArchived: true,
  });
  const rows = [...first.data];
  const pages = Math.ceil(first.total / PAGE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await apiGet<RosterPage<T>>(path, {
      page,
      pageSize: PAGE,
      includeInactive: true,
      includeArchived: true,
    });
    rows.push(...next.data);
  }
  return rows;
}

function replaceInPlace<T>(target: T[], rows: T[]): void {
  target.length = 0;
  target.push(...rows);
}

let hydration: Promise<void> | null = null;

/**
 * Loads the roster once per session. Every roster read awaits this, so a page that renders before
 * the fetch lands shows a loading state rather than an empty fleet — an empty list and a list that
 * has not arrived yet are different answers and must not look the same.
 */
export function ensureRoster(): Promise<void> {
  hydration ??= (async () => {
    const [trucks, drivers, trailers] = await Promise.all([
      drain<TruckRecord>('/trucks'),
      drain<DriverRecord>('/drivers'),
      drain<TrailerRecord>('/trailers'),
    ]);
    replaceInPlace(demoData.trucks, trucks as unknown as Truck[]);
    replaceInPlace(demoData.drivers, drivers as unknown as Driver[]);
    replaceInPlace(demoData.trailers, trailers.map(toTrailer));
  })().catch((error: unknown) => {
    // A failed hydration must not be cached as success, or the app spends the rest of the session
    // showing an empty fleet it will never retry.
    hydration = null;
    throw error;
  });
  return hydration;
}

/** Drops the cached hydration so the next read refetches. Used after a write. */
export function invalidateRoster(): void {
  hydration = null;
}

/**
 * A trailer as the pages hold it.
 *
 * The record and the page agree on every field but two: the page carries a location, which comes
 * from the truck pulling the trailer and not from the trailer itself, and it has no source. The
 * cast the trucks and drivers use would quietly drop those, so this one is written out.
 */
function toTrailer(row: TrailerRecord): Trailer {
  return {
    id: row.id,
    unitNumber: row.unitNumber,
    vin: row.vin,
    year: row.year,
    make: row.make,
    model: row.model,
    type: row.type,
    lengthFt: row.lengthFt,
    plate: row.plate,
    plateState: row.plateState,
    status: row.status,
    ownership: row.ownership,
    currentTruckId: row.currentTruckId,
    currentTruckUnit: row.currentTruckUnit,
    // A trailer reports no position of its own; the unit pulling it does.
    location: null,
    nextInspectionDate: row.nextInspectionDate,
  };
}

export async function createTrailerRecord(input: CreateTrailerRequest): Promise<Trailer> {
  const trailer = await apiPost<TrailerRecord>('/trailers', input);
  await refreshRoster();
  markCreated(trailer.id);
  return toTrailer(trailer);
}

export async function updateTrailerRecord(
  id: string,
  patch: UpdateTrailerRequest,
): Promise<Trailer> {
  const trailer = await apiPatch<TrailerRecord>(`/trailers/${encodeURIComponent(id)}`, patch);
  await refreshRoster();
  return toTrailer(trailer);
}

export async function setTrailerStatusRecord(id: string, status: string): Promise<Trailer> {
  const trailer = await apiPost<TrailerRecord>(`/trailers/${encodeURIComponent(id)}/status`, {
    status,
  });
  await refreshRoster();
  return toTrailer(trailer);
}

export async function createTruckRecord(input: CreateTruckRequest): Promise<Truck> {
  const truck = await apiPost<TruckRecord>('/trucks', input);
  await refreshRoster();
  markCreated(truck.id);
  return truck as unknown as Truck;
}

export async function updateTruckRecord(id: string, patch: UpdateTruckRequest): Promise<Truck> {
  const truck = await apiPatch<TruckRecord>(`/trucks/${encodeURIComponent(id)}`, patch);
  await refreshRoster();
  return truck as unknown as Truck;
}

export async function setTruckStatusRecord(id: string, status: string): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/status`, { status });
  await refreshRoster();
  return truck as unknown as Truck;
}

/**
 * Archives a truck (owner, 2026-10-05): off every list, picker and count, kept, reversible,
 * audited with the reason. The truck's `updatedAt` the page read is the version check; a truck
 * somebody else changed meanwhile is refused with a conflict, not overwritten.
 */
export async function archiveTruckRecord(
  id: string,
  reason: string,
  expectedUpdatedAt: string,
): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/archive`, {
    reason,
    expectedUpdatedAt,
  });
  await refreshRoster();
  return truck as unknown as Truck;
}

/**
 * Move to vendor (owner, 2026-10-28): from a day on the truck runs for a vendor and the company
 * keeps a percentage of its gross. A new vendor's name adds the vendor.
 */
export async function moveTruckToVendor(id: string, input: MoveTruckToVendorRequest): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/vendor`, input);
  await refreshRoster();
  return truck as unknown as Truck;
}

/** Edit percentage: what the company keeps of a vendor truck's gross, from a day on. */
export async function changeTruckVendorPercent(id: string, input: ChangeTruckVendorPercentRequest): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/vendor/percent`, input);
  await refreshRoster();
  return truck as unknown as Truck;
}

/** A truck owner's name corrected (owner, 2026-10-30): every truck it owns reads the new name. */
export async function renameTruckVendor(vendorId: string, input: { name: string; expectedName: string }): Promise<{ id: string; name: string }> {
  const out = await apiPost<{ id: string; name: string }>(`/truck-vendors/${encodeURIComponent(vendorId)}/rename`, input);
  await refreshRoster();
  return out;
}

/** Move back to the company: the vendor arrangement ends on the day given. */
export async function endTruckVendor(id: string, input: EndTruckVendorRequest): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/vendor/end`, input);
  await refreshRoster();
  return truck as unknown as Truck;
}

/** The truck owners on file, for the vendor picker. */
export function fetchTruckVendors(): Promise<Array<{ id: string; name: string }>> {
  return apiGet<Array<{ id: string; name: string }>>('/truck-vendors');
}

/** Brings an archived truck back as `available`, with the same version check. */
export async function restoreTruckRecord(
  id: string,
  expectedUpdatedAt: string,
  reason?: string,
): Promise<Truck> {
  const truck = await apiPost<TruckRecord>(`/trucks/${encodeURIComponent(id)}/restore`, {
    expectedUpdatedAt,
    ...(reason ? { reason } : {}),
  });
  await refreshRoster();
  return truck as unknown as Truck;
}

export async function createDriverRecord(input: CreateDriverRequest): Promise<Driver> {
  const driver = await apiPost<DriverRecord>('/drivers', input);
  await refreshRoster();
  markCreated(driver.id);
  return driver as unknown as Driver;
}

export async function updateDriverRecord(id: string, patch: UpdateDriverRequest): Promise<Driver> {
  const driver = await apiPatch<DriverRecord>(`/drivers/${encodeURIComponent(id)}`, patch);
  await refreshRoster();
  return driver as unknown as Driver;
}

/**
 * Puts a driver in a truck, or takes them out of one.
 *
 * The server moves both sides of the pairing in one transaction and hands back the driver as it
 * now stands, so the roster here is re-read rather than guessed at.
 */
export async function assignDriverTruckRecord(
  driverId: string,
  truckId: string | null,
): Promise<Driver> {
  const driver = await apiPost<DriverRecord>(`/drivers/${encodeURIComponent(driverId)}/truck`, {
    truckId,
  });
  await refreshRoster();
  return driver as unknown as Driver;
}

export async function setDriverStatusRecord(id: string, status: string, reason: string | null = null): Promise<Driver> {
  const driver = await apiPost<DriverRecord>(`/drivers/${encodeURIComponent(id)}/status`, {
    status,
    reason,
  });
  await refreshRoster();
  return driver as unknown as Driver;
}

/**
 * Brings an archived driver back. The archive time the page showed is the version check: a driver
 * somebody else already restored (or archived again) is refused with a conflict, not overwritten.
 */
export async function restoreDriverRecord(id: string, expectedArchivedAt: string): Promise<Driver> {
  const driver = await apiPost<DriverRecord>(`/drivers/${encodeURIComponent(id)}/restore`, {
    expectedArchivedAt,
  });
  await refreshRoster();
  return driver as unknown as Driver;
}

/**
 * Re-reads the roster after a write, so the local arrays reflect what the database now holds rather
 * than what the client guessed it would hold. Both sides of a truck/driver pairing move in one
 * server transaction, and re-reading is the only way the client sees both halves.
 */
async function refreshRoster(): Promise<void> {
  invalidateRoster();
  await ensureRoster();
}

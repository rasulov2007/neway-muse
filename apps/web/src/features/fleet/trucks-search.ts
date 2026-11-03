import { z } from 'zod';
import type { MaintenanceUrgency, UnitAvailability } from '@neway/shared';
import { searchPage, searchText } from './search-fields';
import type { FleetTruck } from './useFleet';

/**
 * The Trucks list URL.
 *
 * Every filter lives in the URL so a fleet manager can send "the four units overdue for service"
 * to a shop foreman as a link, and so the exception panel can hand the list a filter rather than a
 * re-derived predicate.
 */
export const trucksSearchSchema = z.object({
  /** Which register is on screen: the fleet, or the units that have left it. */
  tab: z.enum(['fleet', 'off_road', 'archived']).optional().catch(undefined),
  q: searchText,
  /** Derived availability, not the stored status: this is the question the yard actually asks. */
  availability: searchText,
  status: searchText,
  make: searchText,
  state: searchText,
  /** `assigned` | `unassigned` — whether a driver is on the unit. */
  driver: searchText,
  /** A `MaintenanceUrgency`. */
  maintenance: searchText,
  /** `down` narrows to units whose telematics feed is disconnected or erroring. */
  telematics: searchText,
  /** `issue` narrows to units with a PTI defect not yet fixed (owner, 2026-10-21). */
  pti: searchText,
  /** Ids handed over by an exception tile, so the list shows exactly what the count counted. */
  ids: searchText,
  sort: searchText,
  page: searchPage,
  simulate: z.enum(['error', 'empty', 'slow']).optional().catch(undefined),
});

export type TrucksSearch = z.infer<typeof trucksSearchSchema>;

export function parseIds(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

export interface TruckFilterInput {
  q?: string;
  availability?: string;
  status?: string;
  make?: string;
  state?: string;
  driver?: string;
  maintenance?: string;
  telematics?: string;
  pti?: string;
  ids?: string;
}

/**
 * The one predicate the table filters on **and** the summary strip counts with.
 *
 * Deriving the counts separately from the rows is how a tile that says 12 opens a list of 9.
 * `ptiIssueUnits` is the server's set of units with a PTI issue; until it arrives the `pti`
 * filter matches nothing, and the page shows "Loading…" rather than that empty answer.
 */
export function matchesTruckFilters(
  row: FleetTruck,
  filters: TruckFilterInput,
  ptiIssueUnits?: ReadonlySet<string> | null,
): boolean {
  const ids = parseIds(filters.ids);
  if (ids.length > 0 && !ids.includes(row.truck.id)) return false;
  if (filters.pti === 'issue' && !ptiIssueUnits?.has(row.truck.id)) return false;

  if (
    filters.availability &&
    row.availability.availability !== (filters.availability as UnitAvailability)
  ) {
    return false;
  }
  // Assigned is the company's own trucks (owner, 2026-10-30): a vendor truck counts under Vendor only.
  if (filters.availability === 'assigned' && row.truck.vendor) return false;
  if (filters.status && row.truck.status !== filters.status) return false;
  if (filters.make && row.truck.make !== filters.make) return false;
  if (filters.state && row.truck.location?.state !== filters.state) return false;
  if (filters.maintenance && row.service.urgency !== (filters.maintenance as MaintenanceUrgency)) {
    return false;
  }
  if (filters.driver === 'assigned' && !row.truck.currentDriverId) return false;
  if (filters.driver === 'unassigned' && row.truck.currentDriverId) return false;
  if (
    filters.telematics === 'down' &&
    row.truck.telematicsStatus !== 'disconnected' &&
    row.truck.telematicsStatus !== 'error'
  ) {
    return false;
  }

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      row.truck.unitNumber,
      row.truck.vin,
      row.truck.make,
      row.truck.model,
      row.truck.plate,
      row.truck.currentDriverName,
      row.truck.location ? `${row.truck.location.city} ${row.truck.location.state}` : null,
      row.currentLoad?.loadNumber,
      row.trailer?.unitNumber,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }

  return true;
}

import { z } from 'zod';
import type { ViolationState } from '@neway/shared';
import { searchPage, searchText } from '@/features/fleet/search-fields';
import { presetFrom } from './inspections-search';
import type { SafetyViolation } from './useSafety';

/** The Violations list URL. */
export const violationsSearchSchema = z.object({
  q: searchText,
  /** A derived `ViolationState`. */
  state: searchText,
  /** One of the seven CSA BASICs. */
  category: searchText,
  severity: searchText,
  source: searchText,
  driver: searchText,
  unit: searchText,
  st: searchText,
  /** `linked` narrows to violations that came from a roadside inspection. */
  inspection: searchText,
  /** `open` narrows to violations with an outstanding corrective action. */
  action: searchText,
  range: searchText,
  from: searchText,
  to: searchText,
  ids: searchText,
  sort: searchText,
  page: searchPage,
});

export type ViolationsSearch = z.infer<typeof violationsSearchSchema>;

export function parseIds(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/** The one predicate the table filters on and the summary strip counts with. */
export function matchesViolation(
  row: SafetyViolation,
  filters: ViolationsSearch,
  today: string,
): boolean {
  const ids = parseIds(filters.ids);
  if (ids.length > 0 && !ids.includes(row.violation.id)) return false;

  if (filters.state) {
    // `open` on the strip means "anything still outstanding", which is what a safety manager
    // means by it — not only the one state literally named `open`.
    if (filters.state === 'open') {
      if (row.state.state === 'resolved') return false;
    } else if (row.state.state !== (filters.state as ViolationState)) {
      return false;
    }
  }
  if (filters.category && row.violation.category !== filters.category) return false;
  if (filters.severity && row.violation.severity !== filters.severity) return false;
  if (filters.source && row.violation.source !== filters.source) return false;
  if (filters.driver && row.violation.driverId !== filters.driver) return false;
  if (filters.unit && row.violation.truckId !== filters.unit) return false;
  if (filters.st && row.violation.location?.state !== filters.st) return false;
  if (filters.inspection === 'linked' && !row.violation.inspectionId) return false;
  if (filters.inspection === 'none' && row.violation.inspectionId) return false;
  if (filters.action === 'open' && !row.correctiveActions.some((a) => a.state.outstanding)) {
    return false;
  }
  if (filters.action === 'none' && row.correctiveActions.length > 0) return false;

  const from = filters.range === 'custom' ? filters.from : presetFrom(filters.range, today);
  const to = filters.range === 'custom' ? filters.to : undefined;
  if (from && row.violation.onDate < from) return false;
  if (to && row.violation.onDate > to) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      row.violation.violationNumber,
      row.violation.driverName,
      row.violation.unitNumber,
      row.violation.code,
      row.violation.description,
      row.violation.citationNumber,
      row.violation.location
        ? `${row.violation.location.city} ${row.violation.location.state}`
        : null,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }

  return true;
}

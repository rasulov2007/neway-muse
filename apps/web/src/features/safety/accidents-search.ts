import { z } from 'zod';
import { searchPage, searchText } from '@/features/fleet/search-fields';
import { presetFrom } from './inspections-search';
import type { SafetyAccident } from './useSafety';

/** The Accidents list URL. */
export const accidentsSearchSchema = z.object({
  q: searchText,
  /** An `AccidentStatus`, or `open` for anything not closed. */
  status: searchText,
  severity: searchText,
  kind: searchText,
  driver: searchText,
  unit: searchText,
  preventable: searchText,
  /** `yes` narrows to files with an injury; `fatality` to files with a fatality. */
  injury: searchText,
  /** `unassigned`, or a user id. */
  owner: searchText,
  /** `linked` narrows to files with a claim; `none` to those without. */
  claim: searchText,
  /** `missing` narrows to DOT recordable files short of required evidence. */
  evidence: searchText,
  /** `yes` narrows to DOT recordable files. */
  recordable: searchText,
  range: searchText,
  from: searchText,
  to: searchText,
  ids: searchText,
  sort: searchText,
  page: searchPage,
});

export type AccidentsSearch = z.infer<typeof accidentsSearchSchema>;

export function parseIds(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/** The one predicate the table filters on and the summary strip counts with. */
export function matchesAccident(
  row: SafetyAccident,
  filters: AccidentsSearch,
  today: string,
): boolean {
  const ids = parseIds(filters.ids);
  if (ids.length > 0 && !ids.includes(row.accident.id)) return false;

  if (filters.status) {
    if (filters.status === 'open') {
      if (!row.review.open) return false;
    } else if (row.accident.status !== filters.status) {
      return false;
    }
  }
  if (filters.severity && row.accident.severity !== filters.severity) return false;
  if (filters.kind && row.accident.kind !== filters.kind) return false;
  if (filters.driver && row.accident.driverId !== filters.driver) return false;
  if (filters.unit && row.accident.truckId !== filters.unit) return false;
  if (filters.preventable && row.accident.preventable !== filters.preventable) return false;
  if (filters.injury === 'yes' && row.accident.injuries.length === 0) return false;
  if (filters.injury === 'none' && row.accident.injuries.length > 0) return false;
  if (filters.injury === 'fatality' && row.accident.fatalities === 0) return false;
  if (filters.owner) {
    if (filters.owner === 'unassigned') {
      if (row.accident.ownerId !== null) return false;
    } else if (row.accident.ownerId !== filters.owner) {
      return false;
    }
  }
  if (filters.claim === 'linked' && !row.accident.claimId) return false;
  if (filters.claim === 'none' && row.accident.claimId) return false;
  if (filters.evidence === 'missing' && row.review.missingEvidence.length === 0) return false;
  if (filters.recordable === 'yes' && !row.accident.dotRecordable) return false;
  if (filters.recordable === 'no' && row.accident.dotRecordable) return false;

  const from = filters.range === 'custom' ? filters.from : presetFrom(filters.range, today);
  const to = filters.range === 'custom' ? filters.to : undefined;
  const day = row.accident.at.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      row.accident.accidentNumber,
      row.accident.driverName,
      row.accident.unitNumber,
      row.accident.trailerUnit,
      row.accident.loadNumber,
      row.accident.description,
      row.accident.policeReportNumber,
      `${row.accident.location.city} ${row.accident.location.state}`,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }

  return true;
}

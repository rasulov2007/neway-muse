import { z } from 'zod';
import type { InspectionState } from '@neway/shared';
import { searchPage, searchText } from '@/features/fleet/search-fields';
import type { SafetyInspection } from './useSafety';

/**
 * The Inspections list URL.
 *
 * Every filter lives here so a safety manager can send "the four units with open defects" to a
 * shop foreman as a link, and so an exception tile can hand the list ids rather than a re-derived
 * predicate.
 */
export const inspectionsSearchSchema = z.object({
  q: searchText,
  /** A derived `InspectionState` — the lifecycle, not the stored pass/fail. */
  state: searchText,
  kind: searchText,
  result: searchText,
  driver: searchText,
  unit: searchText,
  inspector: searchText,
  /** A `DefectSeverity`: narrows to inspections that raised a defect at that severity. */
  severity: searchText,
  /** `open` narrows to inspections with an unresolved defect. */
  defects: searchText,
  /** Date preset: `today` | `7d` | `30d` | `90d`, or a custom `from`/`to` pair. */
  range: searchText,
  from: searchText,
  to: searchText,
  ids: searchText,
  sort: searchText,
  page: searchPage,
});

export type InspectionsSearch = z.infer<typeof inspectionsSearchSchema>;

/** Days each preset looks back. `custom` uses `from`/`to` instead. */
export const DATE_PRESETS: ReadonlyArray<{ value: string; label: string; days: number | null }> = [
  { value: 'today', label: 'Today', days: 0 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: 'custom', label: 'Custom', days: null },
];

const MS_PER_DAY = 86_400_000;

/** Resolves a preset to an inclusive `from` date, or null when it does not bound the range. */
export function presetFrom(range: string | undefined, today: string): string | null {
  const preset = DATE_PRESETS.find((p) => p.value === range);
  if (!preset || preset.days === null) return null;
  const base = Date.parse(`${today}T00:00:00Z`);
  return new Date(base - preset.days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function parseIds(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/**
 * The one predicate the table filters on **and** the summary strip counts with.
 *
 * Deriving the counts separately from the rows is how a tile that says 12 opens a list of 9.
 */
export function matchesInspection(
  row: SafetyInspection,
  filters: InspectionsSearch,
  today: string,
): boolean {
  const ids = parseIds(filters.ids);
  if (ids.length > 0 && !ids.includes(row.inspection.id)) return false;

  if (filters.state && row.state.state !== (filters.state as InspectionState)) return false;
  if (filters.kind && row.inspection.kind !== filters.kind) return false;
  if (filters.result && row.inspection.result !== filters.result) return false;
  if (filters.driver && row.inspection.driverId !== filters.driver) return false;
  if (filters.unit && row.inspection.assetId !== filters.unit) return false;
  if (filters.inspector && row.inspection.inspector !== filters.inspector) return false;
  if (filters.severity && !row.defects.some((d) => d.defect.severity === filters.severity)) {
    return false;
  }
  if (filters.defects === 'open' && row.openDefects === 0) return false;
  if (filters.defects === 'blocking' && !row.defects.some((d) => d.urgency.blocksDispatch)) {
    return false;
  }
  if (filters.defects === 'overdue' && !row.defects.some((d) => d.urgency.overdue)) return false;

  const from = filters.range === 'custom' ? filters.from : presetFrom(filters.range, today);
  const to = filters.range === 'custom' ? filters.to : undefined;
  const day = row.inspection.at.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      row.inspection.inspectionNumber,
      row.inspection.unitNumber,
      row.inspection.driverName,
      row.inspection.inspector,
      row.inspection.inspectorAgency,
      row.inspection.reportNumber,
      row.inspection.location
        ? `${row.inspection.location.city} ${row.inspection.location.state}`
        : null,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }

  return true;
}

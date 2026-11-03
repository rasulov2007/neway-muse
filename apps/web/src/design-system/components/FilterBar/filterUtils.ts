import type { DateRange } from '../DatePicker';

/** True when a filter value should count as "set" (non-empty string, array or date range). */
export function isFilterActive(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Boolean((value as DateRange).from);
  return true;
}

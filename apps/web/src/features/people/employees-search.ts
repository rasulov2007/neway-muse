import { z } from 'zod';
import { searchPage, searchText } from '@/features/fleet/search-fields';

/**
 * The URL is the state.
 *
 * Every filter, the page and the sort live here so a filtered view is a link somebody can send.
 * Kept apart from the page component because Fast Refresh cannot preserve state across an edit to
 * a module that exports both components and values.
 */
export const employeesSearchSchema = z.object({
  q: searchText,
  status: searchText,
  department: searchText,
  position: searchText,
  employmentType: searchText,
  location: searchText,
  manager: searchText,
  workforce: searchText,
  hiredFrom: searchText,
  hiredTo: searchText,
  sort: searchText,
  sortDir: searchText,
  includeInactive: searchText,
  /** `incomplete` = the "Not yet filled" view; anything else = profile complete (owner, 2026-10-26). */
  view: searchText,
  page: searchPage,
  pageSize: searchPage,
  /** Which 360 tab is open, so a tab is linkable too. */
  tab: searchText,
});

export type EmployeesSearch = z.infer<typeof employeesSearchSchema>;

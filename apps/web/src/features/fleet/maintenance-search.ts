import { z } from 'zod';

import { searchPage, searchText } from './search-fields';

/**
 * The maintenance URL.
 *
 * `view` carries the five stages the nav links to, so they are filters on one command centre
 * rather than five routes with five chances for a count to drift.
 */
export const maintenanceSearchSchema = z.object({
  q: searchText,
  /** `active` | a `RepairOrderStatus` | `overdue`. */
  view: searchText,
  unit: searchText,
  priority: searchText,
  ids: searchText,
  page: searchPage,
  /** Opens Create work order on arrival; `tires` opens it on the Tires type (the old Tire work order). */
  create: searchText,
});

export type MaintenanceSearch = z.infer<typeof maintenanceSearchSchema>;

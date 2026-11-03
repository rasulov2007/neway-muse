import { z } from 'zod';
import {
  FLEET_EXPENSE_CATEGORIES,
  FLEET_EXPENSE_CHARGE_TO,
  FLEET_EXPENSE_PAYERS,
  FLEET_EXPENSE_SOURCES,
  FLEET_PAYMENT_STATUSES,
  FLEET_RECOVERY_STATUSES,
  type FleetExpenseListQueryInput,
} from '@neway/shared';
import { searchPage, searchText } from '../search-fields';

/**
 * The Fleet Expenses URL, for the dashboard and the list alike.
 *
 * Every filter lives in the URL so a KPI on the dashboard can open the list already narrowed to
 * the rows behind it, and so a filtered list can be sent as a link. A malformed value degrades to
 * "no filter" rather than an error screen, as on every fleet page.
 */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined);

export const EXPENSE_FIGURES = ['company', 'driver_outstanding', 'unpaid_bills', 'efs_remaining', 'external', 'investigation'] as const;
export type ExpenseFigure = (typeof EXPENSE_FIGURES)[number];

/** What a KPI drill-down shows, as the removable chip on the list says it. */
export const EXPENSE_FIGURE_LABEL: Record<ExpenseFigure, string> = {
  company: 'Company cost',
  driver_outstanding: 'Driver charge outstanding',
  unpaid_bills: 'Unpaid vendor bills',
  efs_remaining: 'EFS recovery remaining',
  external: 'Paid and borne externally',
  investigation: 'Under investigation',
};

export const EXPENSE_SORTS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'truck', 'category'] as const;
export type ExpenseSort = (typeof EXPENSE_SORTS)[number];

export const fleetExpensesSearchSchema = z.object({
  from: isoDay,
  to: isoDay,
  truckId: searchText,
  category: z.enum(FLEET_EXPENSE_CATEGORIES).optional().catch(undefined),
  paidBy: z.enum(FLEET_EXPENSE_PAYERS).optional().catch(undefined),
  chargeTo: z.enum(FLEET_EXPENSE_CHARGE_TO).optional().catch(undefined),
  paymentStatus: z.enum(FLEET_PAYMENT_STATUSES).optional().catch(undefined),
  recoveryStatus: z.enum(FLEET_RECOVERY_STATUSES).optional().catch(undefined),
  source: z.enum(FLEET_EXPENSE_SOURCES).optional().catch(undefined),
  figure: z.enum(EXPENSE_FIGURES).optional().catch(undefined),
  /** Free text: reference, unit, vendor, place. */
  search: searchText,
  sort: z.enum(EXPENSE_SORTS).optional().catch(undefined),
  page: searchPage,
  /** The expense open in the side panel. */
  expense: searchText,
  /** Drafts are not spend; they are listed only when asked for. */
  drafts: z.coerce.boolean().optional().catch(undefined),
  /** Void expenses are kept and hidden; listed only when asked for. */
  voided: z.coerce.boolean().optional().catch(undefined),
});

export type FleetExpensesSearch = z.infer<typeof fleetExpensesSearchSchema>;

export const EXPENSE_PAGE_SIZE = 25;

/** The URL's filters as the list endpoint takes them. */
export function listQueryOf(search: FleetExpensesSearch, lockedTruckId?: string): FleetExpenseListQueryInput {
  return {
    from: search.from,
    to: search.to,
    truckId: lockedTruckId ?? search.truckId,
    category: search.category,
    paidBy: search.paidBy,
    chargeTo: search.chargeTo,
    paymentStatus: search.paymentStatus,
    recoveryStatus: search.recoveryStatus,
    source: search.source,
    figure: search.figure,
    search: search.search,
    sort: search.sort ?? 'amount_desc',
    page: search.page ?? 1,
    pageSize: EXPENSE_PAGE_SIZE,
    includeDrafts: search.drafts || undefined,
    includeVoid: search.voided || undefined,
  };
}

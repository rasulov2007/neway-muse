/** The single company the demo reporting data source knows about. */
export const DEMO_COMPANY = {
  // Must match the company the roster is stored under: a principal whose companyId does not
  // match the rows is a principal that sees an empty fleet and no explanation.
  id: 'co_northwind',
  name: 'Northwind Freight',
  timezone: 'America/Chicago',
  weekStart: 'monday',
} as const;

export type DemoCompany = typeof DEMO_COMPANY;

/** The pinned "today" the demo dataset is built around (a Sunday; its week starts 2026-08-31). */
export const DEMO_TODAY = '2026-09-06';

/** Inclusive calendar window the pinned demo dataset covers. */
export const DEMO_DATASET_RANGE = { from: '2026-05-01', to: '2026-09-30' } as const;

/** Reporting week with no expense data at all (demonstrates the honesty rule). */
export const DEMO_WEEK_WITHOUT_EXPENSES = '2026-08-10';

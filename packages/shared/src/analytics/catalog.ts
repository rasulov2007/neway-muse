import { z } from 'zod';

/**
 * The report catalogue.
 *
 * One declaration per report, naming the data it needs and whether that data exists yet. A report
 * whose source is not wired up is listed as `unavailable` with the reason, rather than hidden or —
 * worse — shipped as an empty table that looks like a successful run over a quiet week.
 *
 * Nothing here computes anything. Reports are produced by the reporting engines that already exist
 * in `apps/api/src/modules/reporting/engines`, so profit, RPM, CPM and margin have exactly one
 * definition across the dashboard, reports and analytics.
 */

export const REPORT_CATEGORIES = [
  'operations',
  'financial',
  'fleet',
  'driver',
  'safety',
  'people',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  operations: 'Operations',
  financial: 'Financial',
  fleet: 'Fleet',
  driver: 'Driver',
  safety: 'Safety',
  people: 'People',
};

/** Which filters a report actually honours. A filter it ignores is never offered. */
export const REPORT_FILTERS = [
  'dateRange',
  'truck',
  'driver',
  'department',
  'status',
  'policy',
] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

/** How a report's rows may be grouped. Not every report groups. */
export const REPORT_GROUPINGS = [
  'truck',
  'driver',
  'week',
  'month',
  'category',
  'department',
] as const;
export type ReportGrouping = (typeof REPORT_GROUPINGS)[number];

export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'percent' | 'status';
  /** Included in the totals row. Only sums that mean something: you cannot sum an RPM. */
  total?: 'sum' | 'derived';
  align?: 'left' | 'right';
}

export interface ReportDefinition {
  key: string;
  name: string;
  category: ReportCategory;
  description: string;
  /** Where the numbers come from, in the words of somebody deciding whether to trust them. */
  dataSource: string;
  filters: ReportFilter[];
  groupings: ReportGrouping[];
  defaultGrouping: ReportGrouping | null;
  columns: ReportColumn[];
  /**
   * Present when this report cannot be produced today. The catalogue still lists it, because
   * "we do not collect that yet" is a more useful answer than a missing menu entry.
   */
  unavailable?: string;
  /** Reports that expose money are gated separately from ones that do not. */
  permission: string;
}

const money = (key: string, label: string, total: 'sum' | 'derived' = 'sum'): ReportColumn => ({
  key,
  label,
  type: 'money',
  total,
  align: 'right',
});
const number = (key: string, label: string, total: 'sum' | 'derived' = 'sum'): ReportColumn => ({
  key,
  label,
  type: 'number',
  total,
  align: 'right',
});
const text = (key: string, label: string): ReportColumn => ({ key, label, type: 'text' });

// ------------------------------------------------------------------------------------ financial

const FINANCIAL_ROW_COLUMNS: ReportColumn[] = [
  money('gross', 'Gross revenue'),
  money('cost', 'Cost'),
  money('profit', 'Operating profit'),
  number('miles', 'Miles'),
  money('rpm', 'RPM', 'derived'),
  money('cpm', 'CPM', 'derived'),
  money('ppm', 'PPM', 'derived'),
  { key: 'marginPct', label: 'Margin', type: 'percent', total: 'derived', align: 'right' },
];

export const REPORTS: ReportDefinition[] = [
  // ------------------------------------------------------------------------------- financial
  {
    key: 'profit_and_loss',
    name: 'Profit & loss',
    category: 'financial',
    description:
      'Gross revenue, cost by category and operating profit for the period, with the previous period beside it.',
    dataSource: 'Revenue lines and expense lines from the reporting facts.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [
      text('label', 'Line'),
      money('amount', 'Amount'),
      { key: 'share', label: '% of revenue', type: 'percent', total: 'derived', align: 'right' },
      money('perMile', 'Per mile', 'derived'),
    ],
    permission: 'reports.view_financial',
  },
  {
    key: 'revenue_by_week',
    name: 'Revenue by week',
    category: 'financial',
    description:
      'Gross, cost and profit per reporting week. The same figures the weekly board uses.',
    dataSource: 'Revenue and expense lines, bucketed by the company reporting week.',
    filters: ['dateRange'],
    groupings: ['week'],
    defaultGrouping: 'week',
    columns: [
      text('label', 'Week'),
      ...FINANCIAL_ROW_COLUMNS.slice(0, 4),
      money('rpm', 'RPM', 'derived'),
    ],
    permission: 'reports.view_financial',
  },
  {
    key: 'cost_per_mile',
    name: 'Cost per mile',
    category: 'financial',
    description: 'Every cost category as a rate per mile, ranked, with its share of revenue.',
    dataSource: 'Expense lines and the mileage the engines use for CPM.',
    filters: ['dateRange'],
    groupings: ['category'],
    defaultGrouping: 'category',
    columns: [
      text('label', 'Category'),
      money('amount', 'Cost'),
      money('perMile', 'Cost per mile', 'derived'),
      { key: 'share', label: '% of revenue', type: 'percent', total: 'derived', align: 'right' },
    ],
    permission: 'reports.view_financial',
  },
  {
    key: 'accounts_receivable',
    name: 'Accounts receivable',
    category: 'financial',
    description: 'Open invoices by ageing bucket and customer.',
    dataSource: 'The accounting module.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Customer'), money('amount', 'Outstanding')],
    unavailable:
      'Invoices are generated in the browser session and are not in the reporting facts, so an AR report here would not match the AR page.',
    permission: 'reports.view_financial',
  },

  // ------------------------------------------------------------------------------------ fleet
  {
    key: 'truck_profitability',
    name: 'Truck profitability',
    category: 'fleet',
    description:
      'Revenue, cost, profit and margin for every truck, with the rates per mile that explain them.',
    dataSource: 'The truck P&L engine — the same one behind the dashboard widget.',
    filters: ['dateRange', 'truck', 'status'],
    groupings: ['truck'],
    defaultGrouping: 'truck',
    columns: [
      text('label', 'Truck'),
      { key: 'status', label: 'Status', type: 'status' },
      number('miles', 'Miles'),
      money('gross', 'Gross'),
      money('cost', 'Cost'),
      money('profit', 'Profit'),
      money('rpm', 'RPM', 'derived'),
      money('cpm', 'CPM', 'derived'),
      { key: 'marginPct', label: 'Margin', type: 'percent', total: 'derived', align: 'right' },
    ],
    permission: 'reports.view_financial',
  },
  {
    key: 'fleet_utilization',
    name: 'Fleet utilisation',
    category: 'fleet',
    description: 'Active and idle trucks, and revenue per active truck.',
    dataSource: 'Truck facts and revenue lines.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Measure'), number('value', 'Value', 'derived')],
    permission: 'reports.view',
  },
  {
    key: 'fuel',
    name: 'Fuel',
    category: 'fleet',
    description:
      'Gallons, spend, price per gallon and fuel cost per mile by truck, with potential anomalies flagged.',
    dataSource: 'The fuel analytics engine over fuel transactions.',
    filters: ['dateRange', 'truck'],
    groupings: ['truck'],
    defaultGrouping: 'truck',
    columns: [
      text('label', 'Truck'),
      number('gallons', 'Gallons'),
      money('amount', 'Fuel spend'),
      money('pricePerGallon', 'Price/gal', 'derived'),
      number('miles', 'Miles'),
      number('mpg', 'MPG', 'derived'),
      money('perMile', 'Fuel CPM', 'derived'),
    ],
    permission: 'reports.view',
  },
  {
    key: 'maintenance_cost',
    name: 'Maintenance cost',
    category: 'fleet',
    description: 'Maintenance and repair spend by truck, and what it costs per mile.',
    dataSource: 'Expense lines in the maintenance and repair categories.',
    filters: ['dateRange', 'truck'],
    groupings: ['truck'],
    defaultGrouping: 'truck',
    columns: [
      text('label', 'Truck'),
      money('amount', 'Maintenance cost'),
      number('miles', 'Miles'),
      money('perMile', 'Cost per mile', 'derived'),
    ],
    permission: 'reports.view',
  },
  {
    key: 'maintenance_downtime',
    name: 'Maintenance downtime',
    category: 'fleet',
    description: 'Days out of service, repair frequency and vendor by truck.',
    dataSource: 'Work orders.',
    filters: ['dateRange', 'truck'],
    groupings: ['truck'],
    defaultGrouping: 'truck',
    columns: [text('label', 'Truck'), number('value', 'Downtime days')],
    unavailable:
      'Work orders are generated in the browser session. Only maintenance *cost* reaches the reporting facts, so downtime, vendor and repair frequency cannot be reported.',
    permission: 'reports.view',
  },

  // ------------------------------------------------------------------------------------ driver
  {
    key: 'driver_performance',
    name: 'Driver performance',
    category: 'driver',
    description: 'Loads, miles, revenue and the rates per mile for every driver who ran freight.',
    dataSource: 'Revenue lines attributed to a driver, plus driver facts.',
    filters: ['dateRange', 'driver'],
    groupings: ['driver'],
    defaultGrouping: 'driver',
    columns: [
      text('label', 'Driver'),
      number('loads', 'Loads'),
      number('miles', 'Miles'),
      money('gross', 'Revenue'),
      money('rpm', 'RPM', 'derived'),
      number('emptyMiles', 'Empty miles'),
      { key: 'emptyPct', label: 'Empty %', type: 'percent', total: 'derived', align: 'right' },
    ],
    permission: 'reports.view',
  },

  // -------------------------------------------------------------------------------- operations
  {
    key: 'miles',
    name: 'Miles',
    category: 'operations',
    description: 'Loaded, empty and total miles for the period, and the empty share.',
    dataSource: 'Revenue lines and mileage records.',
    filters: ['dateRange', 'truck'],
    groupings: ['week', 'truck'],
    defaultGrouping: 'week',
    columns: [
      text('label', 'Period'),
      number('loadedMiles', 'Loaded miles'),
      number('emptyMiles', 'Empty miles'),
      number('miles', 'Total miles'),
      { key: 'emptyPct', label: 'Empty %', type: 'percent', total: 'derived', align: 'right' },
    ],
    permission: 'reports.view',
  },
  {
    key: 'load_profitability',
    name: 'Load profitability',
    category: 'operations',
    description: 'Every delivered load with its revenue, miles and rate per mile.',
    dataSource: 'Revenue lines. Cost is not attributed per load by the current facts.',
    filters: ['dateRange', 'truck', 'driver'],
    groupings: [],
    defaultGrouping: null,
    columns: [
      text('label', 'Load'),
      text('truck', 'Truck'),
      text('driver', 'Driver'),
      { key: 'deliveredOn', label: 'Delivered', type: 'date' },
      number('loadedMiles', 'Loaded'),
      number('emptyMiles', 'Empty'),
      money('gross', 'Revenue'),
      money('rpm', 'RPM', 'derived'),
    ],
    permission: 'reports.view_financial',
  },
  {
    key: 'dispatch_performance',
    name: 'Dispatch performance',
    category: 'operations',
    description: 'Loads, revenue and truck utilisation by dispatch team and week.',
    dataSource: 'The dispatch performance engine over dispatch team weeks.',
    filters: ['dateRange'],
    groupings: ['week'],
    defaultGrouping: 'week',
    columns: [
      text('label', 'Team'),
      number('loads', 'Loads'),
      money('gross', 'Revenue'),
      number('activeTrucks', 'Active trucks'),
      {
        key: 'utilization',
        label: 'Utilisation',
        type: 'percent',
        total: 'derived',
        align: 'right',
      },
    ],
    permission: 'reports.view',
  },
  {
    key: 'customer_performance',
    name: 'Customer performance',
    category: 'operations',
    description: 'Revenue, loads, margin and on-time performance by customer.',
    dataSource: 'Loads joined to customers.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Customer'), money('gross', 'Revenue'), number('loads', 'Loads')],
    unavailable:
      'Revenue lines carry a truck and a driver but no customer, so revenue cannot be attributed to a customer without inventing the link.',
    permission: 'reports.view_financial',
  },
  {
    key: 'broker_performance',
    name: 'Broker performance',
    category: 'operations',
    description: 'Revenue, loads and margin by broker.',
    dataSource: 'Loads joined to brokers.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Broker'), money('gross', 'Revenue'), number('loads', 'Loads')],
    unavailable: 'Revenue lines carry no broker, for the same reason as customer performance.',
    permission: 'reports.view_financial',
  },
  {
    key: 'on_time_performance',
    name: 'On-time performance',
    category: 'operations',
    description: 'On-time pickup and delivery, dwell and detention.',
    dataSource: 'Load stop appointments and arrival times.',
    filters: ['dateRange'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Measure'), number('value', 'Value')],
    unavailable:
      'Stop appointments and arrival times are not in the reporting facts, so on-time percentages cannot be computed here.',
    permission: 'reports.view',
  },

  // ------------------------------------------------------------------------------------ people
  {
    key: 'headcount',
    name: 'Employee headcount',
    category: 'people',
    description: 'Headcount by department and employment status, from the workforce records.',
    dataSource: 'The employees table. Live data, not a generated dataset.',
    filters: ['department'],
    groupings: ['department'],
    defaultGrouping: 'department',
    columns: [
      text('label', 'Department'),
      number('headcount', 'Headcount'),
      number('drivers', 'Drivers'),
      number('staff', 'Office & operations'),
    ],
    permission: 'reports.view_people',
  },
  {
    key: 'pto_report',
    name: 'PTO',
    category: 'people',
    description: 'Requests, hours and balances by employee.',
    dataSource: 'The PTO request and transaction ledger. Live data.',
    filters: ['dateRange', 'department', 'status'],
    groupings: ['department'],
    defaultGrouping: null,
    columns: [
      text('label', 'Employee'),
      text('policy', 'Type'),
      { key: 'startsOn', label: 'From', type: 'date' },
      { key: 'endsOn', label: 'To', type: 'date' },
      number('hours', 'Hours'),
      { key: 'status', label: 'Status', type: 'status' },
    ],
    permission: 'reports.view_people',
  },
  {
    key: 'attendance_report',
    name: 'Attendance',
    category: 'people',
    description: 'Days recorded, hours worked, overtime and open exceptions by employee.',
    dataSource: 'Attendance entries. Live data; hours are computed from the punches.',
    filters: ['dateRange', 'department'],
    groupings: ['department'],
    defaultGrouping: null,
    columns: [
      text('label', 'Employee'),
      number('days', 'Days'),
      number('hours', 'Hours worked'),
      number('overtime', 'Overtime'),
      number('exceptions', 'Open exceptions'),
    ],
    permission: 'reports.view_people',
  },
  {
    key: 'onboarding_report',
    name: 'Onboarding',
    category: 'people',
    description: 'Plans in progress, completion and overdue items.',
    dataSource: 'Onboarding checklists and items. Live data.',
    filters: ['status', 'department'],
    groupings: [],
    defaultGrouping: null,
    columns: [
      text('label', 'Employee'),
      { key: 'status', label: 'Status', type: 'status' },
      number('completed', 'Completed'),
      number('total', 'Items'),
      number('overdue', 'Overdue'),
    ],
    permission: 'reports.view_people',
  },
  {
    key: 'recruiting_report',
    name: 'Recruiting',
    category: 'people',
    description: 'Candidates by stage, and how many became employees.',
    dataSource: 'Applicants. Live data.',
    filters: ['dateRange', 'department'],
    groupings: [],
    defaultGrouping: null,
    columns: [text('label', 'Stage'), number('count', 'Candidates')],
    permission: 'reports.view_people',
  },

  // ------------------------------------------------------------------------------------ safety
  {
    key: 'safety_summary',
    name: 'Safety',
    category: 'safety',
    description: 'Inspections, violations, accidents and open corrective actions by driver.',
    dataSource: 'The safety module.',
    filters: ['dateRange', 'driver'],
    groupings: ['driver'],
    defaultGrouping: 'driver',
    columns: [text('label', 'Driver'), number('value', 'Events')],
    unavailable:
      'Inspections, violations and accidents are generated in the browser session and are not in the reporting facts. A safety report served from here would not match the Safety pages.',
    permission: 'reports.view_safety',
  },
];

export function reportByKey(key: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.key === key);
}

export function availableReports(): ReportDefinition[] {
  return REPORTS.filter((r) => !r.unavailable);
}

// -------------------------------------------------------------------------------------- running

export const RunReportSchema = z.object({
  reportKey: z.string().min(1),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  preset: z.string().max(40).optional(),
  grouping: z.enum(REPORT_GROUPINGS).optional(),
  truckId: z.string().max(40).optional(),
  driverId: z.string().max(40).optional(),
  department: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  sort: z.string().max(40).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type RunReportRequest = z.infer<typeof RunReportSchema>;

export type ReportCell = string | number | null;

export interface ReportRow {
  /** Stable id so a row can link to the record it describes. */
  id: string;
  cells: Record<string, ReportCell>;
  /** Where a drill-down on this row should go, when there is somewhere. */
  href?: string;
}

export interface ReportResult {
  reportKey: string;
  name: string;
  category: ReportCategory;
  /** The exact range that produced these rows, so an export can state it. */
  range: { from: string; to: string; label: string };
  grouping: ReportGrouping | null;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** `null` in a total means the figure could not be computed, never zero. */
  totals: Record<string, ReportCell>;
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
  /** Where the numbers came from, carried through to the export header. */
  source: 'demo' | 'database';
  /** Checks that could not run, and what they would need. */
  notes: string[];
}

// -------------------------------------------------------------------------------- saved reports

export const SaveReportSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(80),
  reportKey: z.string().min(1),
  /** The exact configuration to reproduce: filters, grouping, sort, range. */
  config: z.record(z.string(), z.unknown()),
});
export type SaveReportRequest = z.infer<typeof SaveReportSchema>;

export interface SavedReportRecord {
  id: string;
  name: string;
  reportKey: string;
  reportName: string;
  category: ReportCategory;
  config: Record<string, unknown>;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  ageInvoices,
  compare,
  costPerMile,
  periodFigures,
  previousRange,
  rangeFor,
  receivablesByCustomer,
  runPayroll,
  summarizePayables,
  trialBalance,
  type AgingTotals,
  type Comparison,
  type CostPerMile,
  type CustomerReceivable,
  type DateRange,
  type PayrollResult,
  type PayablesSummary,
  type PeriodFigures,
  type PeriodPreset,
  type VendorPayable,
  payablesByVendor,
} from '@neway/shared';
import {
  listBills,
  listExpenses,
  listInvoiceLines,
  listInvoices,
  listJournal,
  listLedgerPeriods,
  listLoads,
  listPayments,
  listPayrollPeriods,
  listPayslips,
  listSettlements,
  listVendors,
  type Bill,
  type Expense,
  type Invoice,
  type InvoiceLine,
  type JournalEntry,
  type LedgerPeriod,
  type PayrollPeriod,
  type Payment,
  type Payslip,
  type Settlement,
  type Vendor,
} from '@/demo';
import { today as todayInCompanyZone } from '@/lib/clock';

/**
 * Everything Accounting knows, derived once.
 *
 * The figures come from the **ledger**, not from the operational records: revenue is what was
 * credited to 4xxx, cost is what was debited to 5xxx/6xxx. That is what makes a number on the
 * command centre traceable to the entries behind it, and it is why there is one source of truth
 * rather than a dashboard that agrees with the books by coincidence.
 *
 * When the Postgres layer lands, the `list*` calls point at HTTP and nothing above this changes.
 */

const PAGE = 200;

async function drain<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ data: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(1, PAGE);
  const rows = [...first.data];
  const pages = Math.ceil(first.total / PAGE);
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await fetchPage(page, PAGE)).data);
  }
  return rows;
}

export interface AccountingException {
  key: string;
  severity: 'critical' | 'warning' | 'info';
  /** The finding without its count. */
  label: string;
  count: number;
  /** How much money it involves. Null when the exception is not about an amount. */
  amount: number | null;
  ids: string[];
  target: { to: string; search?: Record<string, string> };
  /** Why it matters, and what has to happen. */
  reason: string;
}

export interface AccountingBundle {
  today: string;
  preset: PeriodPreset;
  range: DateRange;
  previous: DateRange;

  invoices: Invoice[];
  invoiceLines: InvoiceLine[];
  payments: Payment[];
  bills: Bill[];
  expenses: Expense[];
  settlements: Settlement[];
  payrollPeriods: PayrollPeriod[];
  payslips: Payslip[];
  vendors: Vendor[];
  journal: JournalEntry[];
  ledgerPeriods: LedgerPeriod[];

  /** Ledger-derived figures for the selected period, and the one before it. */
  figures: PeriodFigures;
  previousFigures: PeriodFigures;
  revenue: Comparison;
  cost: Comparison;
  grossProfit: Comparison;
  operatingProfit: Comparison;

  receivables: AgingTotals;
  payables: PayablesSummary;
  byCustomer: CustomerReceivable[];
  byVendor: VendorPayable[];
  cpm: CostPerMile;
  trial: ReturnType<typeof trialBalance>;

  exceptions: AccountingException[];
  byInvoiceId: Map<string, Invoice>;
  byBillId: Map<string, Bill>;
  bySettlementId: Map<string, Settlement>;
  payrollByPeriodId: Map<string, PayrollResult>;
}

export const ACCOUNTING_QUERY_KEY = ['accounting', 'bundle'] as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A read the account is not allowed to make answers "none"; an outage still throws. Payroll
 * sits behind payroll.view, so an Accounting role without it must still get every other page.
 */
async function refusedAsEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 401 || status === 403) return [];
    throw error;
  }
}

export async function loadAccountingBundle(
  preset: PeriodPreset = 'month',
  custom?: DateRange,
): Promise<AccountingBundle> {
  const [
    invoices,
    invoiceLines,
    payments,
    bills,
    expenses,
    settlements,
    payrollPeriods,
    payslips,
    vendors,
    journal,
    loads,
  ] = await Promise.all([
    drain((page, pageSize) => listInvoices({ page, pageSize })),
    drain((page, pageSize) => listInvoiceLines({ page, pageSize })),
    drain((page, pageSize) => listPayments({ page, pageSize })),
    drain((page, pageSize) => listBills({ page, pageSize })),
    drain((page, pageSize) => listExpenses({ page, pageSize })),
    drain((page, pageSize) => listSettlements({ page, pageSize })),
    refusedAsEmpty(drain((page, pageSize) => listPayrollPeriods({ page, pageSize }))),
    refusedAsEmpty(drain((page, pageSize) => listPayslips({ page, pageSize }))),
    refusedAsEmpty(drain((page, pageSize) => listVendors({ page, pageSize }))),
    drain((page, pageSize) => listJournal({ page, pageSize })),
    refusedAsEmpty(drain((page, pageSize) => listLoads({ page, pageSize }))),
  ]);
  const ledgerPeriods = await listLedgerPeriods();

  const today = todayInCompanyZone();
  const range = rangeFor(preset, today, custom);
  const previous = previousRange(range);

  const figures = periodFigures(journal, range);
  const previousFigures = periodFigures(journal, previous);

  const ageable = invoices.map((i) => ({
    id: i.id,
    billToId: i.billToId,
    billToName: i.billToName,
    dueOn: i.dueOn,
    issuedOn: i.issuedOn,
    total: i.total,
    paid: i.paid,
    balance: i.balance,
    status: i.status,
    paidOn: i.paidOn,
  }));

  const payableRows = bills.map((b) => ({
    id: b.id,
    vendorId: b.vendorId,
    vendorName: b.vendorName,
    dueOn: b.dueOn,
    amount: b.amount,
    paid: b.paid,
    balance: b.balance,
    status: b.status,
    approvedAt: b.approvedAt,
  }));

  const receivables = ageInvoices(ageable, today);
  const payables = summarizePayables(payableRows, today);

  // Miles the fleet actually turned in the period, from delivered loads — the same miles the load
  // board reports, so cost per mile reconciles with operations as well as with the ledger.
  const milesInRange = loads
    .filter((l) => {
      const day = l.deliveryAt?.slice(0, 10);
      return l.status === 'delivered' && day !== undefined && day >= range.from && day <= range.to;
    })
    .reduce((sum, l) => sum + l.loadedMiles + l.emptyMiles, 0);

  const cpm = costPerMile(journal, range, milesInRange > 0 ? milesInRange : null);

  const payrollByPeriodId = new Map<string, PayrollResult>();
  for (const period of payrollPeriods) {
    const slips = payslips.filter((p) => p.payrollPeriodId === period.id);
    payrollByPeriodId.set(
      period.id,
      runPayroll(
        slips.map((s) => ({
          id: s.id,
          employeeId: s.employeeId,
          employeeName: s.employeeName,
          workerType: s.workerType,
          basePay: s.basePay,
          bonuses: s.bonuses,
          taxWithheld: s.taxWithheld,
          deductions: s.deductions,
          hours: s.hours,
          hourly: s.hourly,
        })),
      ),
    );
  }

  return {
    today,
    preset,
    range,
    previous,
    invoices,
    invoiceLines,
    payments,
    bills,
    expenses,
    settlements,
    payrollPeriods,
    payslips,
    vendors,
    journal,
    ledgerPeriods,
    figures,
    previousFigures,
    revenue: compare(figures.revenue, previousFigures.revenue),
    cost: compare(
      figures.directCost === null && figures.operatingCost === null
        ? null
        : round((figures.directCost ?? 0) + (figures.operatingCost ?? 0)),
      previousFigures.directCost === null && previousFigures.operatingCost === null
        ? null
        : round((previousFigures.directCost ?? 0) + (previousFigures.operatingCost ?? 0)),
    ),
    grossProfit: compare(figures.grossProfit, previousFigures.grossProfit),
    operatingProfit: compare(figures.operatingProfit, previousFigures.operatingProfit),
    receivables,
    payables,
    byCustomer: receivablesByCustomer(ageable, today),
    byVendor: payablesByVendor(payableRows, today),
    cpm,
    trial: trialBalance(journal),
    exceptions: buildExceptions({
      invoices,
      bills,
      settlements,
      payrollPeriods,
      payrollByPeriodId,
      receivables,
      payables,
      journal,
      today,
    }),
    byInvoiceId: new Map(invoices.map((i) => [i.id, i])),
    byBillId: new Map(bills.map((b) => [b.id, b])),
    bySettlementId: new Map(settlements.map((s) => [s.id, s])),
    payrollByPeriodId,
  };
}

/**
 * What in the books needs a person today.
 *
 * Same rule as every other exception queue in this system: the ids behind each count travel with
 * it, and a finding worth zero is not produced. Unlike the others, each one also carries the money
 * involved, because in accounting the size of a problem is most of the decision about it.
 */
function buildExceptions(input: {
  invoices: Invoice[];
  bills: Bill[];
  settlements: Settlement[];
  payrollPeriods: PayrollPeriod[];
  payrollByPeriodId: Map<string, PayrollResult>;
  receivables: AgingTotals;
  payables: PayablesSummary;
  journal: JournalEntry[];
  today: string;
}): AccountingException[] {
  const items: AccountingException[] = [];

  const push = (item: Omit<AccountingException, 'count'>) => {
    if (item.ids.length === 0) return;
    items.push({ ...item, count: item.ids.length });
  };

  const overdue = input.invoices.filter(
    (i) => i.balance > 0 && i.dueOn !== null && i.dueOn < input.today && i.status !== 'void',
  );
  push({
    key: 'invoices_overdue',
    severity: 'critical',
    label: 'invoices are past due',
    amount: round(overdue.reduce((sum, i) => sum + i.balance, 0)),
    ids: overdue.map((i) => i.id),
    target: { to: '/accounting/invoices', search: { view: 'overdue' } },
    reason: 'Every day past terms is a day the money is financing somebody else’s business.',
  });

  const ancient = overdue.filter((i) => (i.dueOn as string) < shift(input.today, -90));
  push({
    key: 'ar_over_90',
    severity: 'critical',
    label: 'invoices are more than 90 days past due',
    amount: round(ancient.reduce((sum, i) => sum + i.balance, 0)),
    ids: ancient.map((i) => i.id),
    target: { to: '/accounting/receivables', search: { bucket: '90+' } },
    reason:
      'Past 90 days, collection rates fall off sharply. These are the ones to escalate today.',
  });

  push({
    key: 'bills_overdue',
    severity: 'critical',
    label: 'bills are past their due date',
    amount: input.payables.overdue,
    ids: input.payables.ids.overdue,
    target: { to: '/accounting/payables', search: { view: 'overdue' } },
    reason: 'Late payment costs terms, and terms are the cheapest credit a carrier has.',
  });

  push({
    key: 'bills_pending_approval',
    severity: 'warning',
    label: 'bills are waiting for approval',
    amount: input.payables.pendingApproval,
    ids: input.payables.ids.pendingApproval,
    target: { to: '/accounting/payables', search: { view: 'pending_approval' } },
    reason: 'Nothing can be scheduled until somebody approves them.',
  });

  push({
    key: 'bills_due_this_week',
    severity: 'info',
    label: 'bills fall due this week',
    amount: input.payables.dueThisWeek,
    ids: input.payables.ids.dueThisWeek,
    target: { to: '/accounting/payables', search: { view: 'due_week' } },
    reason: 'Schedule them now and the cash position stops being a surprise on Friday.',
  });

  // A statement with nothing to pay (an active driver with no work that week) is not waiting for anything.
  const awaiting = input.settlements.filter((s) => s.status === 'pending_review' && s.net !== 0);
  push({
    key: 'settlements_pending',
    severity: 'warning',
    label: 'driver settlements await approval',
    amount: round(awaiting.reduce((sum, s) => sum + s.net, 0)),
    ids: awaiting.map((s) => s.id),
    target: { to: '/accounting/settlements', search: { status: 'pending_review' } },
    reason: 'Drivers are waiting to be paid for work they have already done.',
  });

  const short = input.settlements.filter((s) => s.shortfall !== null && s.status !== 'reversed');
  push({
    key: 'settlements_shortfall',
    severity: 'warning',
    label: 'settlements could not take their full deductions',
    amount: round(short.reduce((sum, s) => sum + (s.shortfall ?? 0), 0)),
    ids: short.map((s) => s.id),
    target: { to: '/accounting/settlements', search: { shortfall: 'yes' } },
    reason:
      'The settlement did not cover what was scheduled. Somebody has to decide whether it carries forward.',
  });

  const excluded = input.settlements.filter((s) => s.excluded.length > 0);
  push({
    key: 'settlements_excluded_loads',
    severity: 'warning',
    label: 'settlements have loads that could not be paid',
    amount: null,
    ids: excluded.map((s) => s.id),
    target: { to: '/accounting/settlements', search: { excluded: 'yes' } },
    reason:
      'A load with no miles or no rate pays nothing. Fix the load, then re-run the settlement.',
  });

  for (const period of input.payrollPeriods) {
    const result = input.payrollByPeriodId.get(period.id);
    if (!result || period.status === 'closed' || period.status === 'paid') continue;
    const critical = result.exceptions.filter((e) => e.severity === 'critical');
    if (critical.length === 0) continue;
    items.push({
      key: `payroll_${period.id}`,
      severity: 'critical',
      label: `payroll exceptions block ${period.periodNumber}`,
      count: critical.reduce((sum, e) => sum + e.ids.length, 0),
      amount: null,
      ids: critical.flatMap((e) => e.ids),
      target: { to: '/accounting/payroll', search: { period: period.id } },
      reason: critical.map((e) => e.reason).join(' '),
    });
  }

  const unbalanced = input.journal.filter((entry) => {
    let debits = 0;
    let credits = 0;
    for (const line of entry.lines) {
      debits += line.debit;
      credits += line.credit;
    }
    return debits !== credits;
  });
  push({
    key: 'journal_unbalanced',
    severity: 'critical',
    label: 'journal entries do not balance',
    amount: null,
    ids: unbalanced.map((e) => e.id),
    target: { to: '/accounting', search: { view: 'ledger' } },
    reason:
      'This should be impossible — an unbalanced entry cannot be constructed. Its presence is a defect, not a data problem.',
  });

  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  return items.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0),
  );
}

function shift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function useAccounting(
  preset: PeriodPreset = 'month',
  custom?: DateRange,
): UseQueryResult<AccountingBundle> {
  return useQuery({
    // Changing the period keeps the previous figures on screen instead of blanking the page.
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    gcTime: 60 * 60_000,
    queryKey: [...ACCOUNTING_QUERY_KEY, preset, custom?.from ?? null, custom?.to ?? null],
    queryFn: () => loadAccountingBundle(preset, custom),
  });
}

/**
 * Invalidates everything an accounting write can change.
 *
 * A payment changes AR, the ledger, the customer's history and the command centre at once. Anything
 * narrower leaves one of them stale, and a stale financial figure is the one people act on.
 */
export function useInvalidateAccounting(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      queryClient.invalidateQueries({ queryKey: ['invoices'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['fleet'] }),
    ]);
  };
}

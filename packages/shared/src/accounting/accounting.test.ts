import { describe, expect, it } from 'vitest';
import {
  CHART_OF_ACCOUNTS,
  DEFAULT_APPROVAL_POLICY,
  ageInvoices,
  bucketFor,
  buildEntry,
  calculateSettlement,
  canPost,
  checkApplication,
  compare,
  costPerMile,
  entryBalances,
  loadPay,
  needsApproval,
  periodFigures,
  postBill,
  postBillPaid,
  postExpense,
  postInvoiceIssued,
  postPayrollFinalized,
  postPaymentReceived,
  postSettlementFinalized,
  previousRange,
  proposeApplication,
  rangeFor,
  receivablesByCustomer,
  runPayroll,
  settlementTransitions,
  summarizePayables,
  toCents,
  trialBalance,
  type AgeableInvoice,
  type JournalEntry,
} from './index.js';

const TODAY = '2026-09-30';

/** Turns a builder result into a stored entry, failing loudly if the builder refused. */
function post(result: ReturnType<typeof buildEntry>, id: string): JournalEntry {
  if (!result.ok) throw new Error(`Expected a valid entry, got: ${result.error}`);
  return { ...result.entry, id, postedAt: `${result.entry.onDate}T12:00:00Z`, postedBy: 'Test' };
}

describe('the ledger refuses anything that would unbalance it', () => {
  it('refuses an entry whose debits and credits differ', () => {
    const result = buildEntry({
      onDate: TODAY,
      source: 'adjustment',
      sourceKey: 'k',
      memo: 'lopsided',
      lines: [
        { accountCode: '1200', debit: 10_000 },
        { accountCode: '4100', credit: 9_900 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not balance');
  });

  it('refuses a posting to a heading account', () => {
    const result = buildEntry({
      onDate: TODAY,
      source: 'adjustment',
      sourceKey: 'k',
      memo: 'heading',
      lines: [
        { accountCode: '1000', debit: 100 },
        { accountCode: '4100', credit: 100 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('heading');
  });

  it('refuses an account that is not in the chart', () => {
    const result = buildEntry({
      onDate: TODAY,
      source: 'adjustment',
      sourceKey: 'k',
      memo: 'unknown',
      lines: [
        { accountCode: '9999', debit: 100 },
        { accountCode: '4100', credit: 100 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('9999');
  });

  it('refuses a line carrying both a debit and a credit', () => {
    const result = buildEntry({
      onDate: TODAY,
      source: 'adjustment',
      sourceKey: 'k',
      memo: 'both sides',
      lines: [
        { accountCode: '1200', debit: 100, credit: 100 },
        { accountCode: '4100', credit: 100 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('both a debit and a credit');
  });

  it('refuses an entry for zero', () => {
    const result = buildEntry({
      onDate: TODAY,
      source: 'adjustment',
      sourceKey: 'k',
      memo: 'nothing',
      lines: [
        { accountCode: '1200', debit: 0 },
        { accountCode: '4100', credit: 0 },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('every account in the chart has a parent that exists', () => {
    const codes = new Set(CHART_OF_ACCOUNTS.map((a) => a.code));
    for (const account of CHART_OF_ACCOUNTS) {
      if (account.parent === null) continue;
      expect(codes.has(account.parent)).toBe(true);
    }
  });
});

describe('every posting rule produces a balanced entry', () => {
  const entries: JournalEntry[] = [];

  it('invoice issued: debit AR, credit revenue by charge type', () => {
    const entry = post(
      postInvoiceIssued({
        invoiceId: 'inv_1',
        invoiceNumber: 'INV-1001',
        issuedOn: '2026-09-02',
        billToName: 'Midwest Foods',
        lines: [
          { chargeType: 'linehaul', description: 'Linehaul', amount: 2_400 },
          { chargeType: 'detention', description: 'Detention 2h', amount: 120.5 },
        ],
      }),
      'je_1',
    );
    entries.push(entry);
    expect(entryBalances(entry)).toBe(true);
    expect(entry.totalCents).toBe(toCents(2_520.5));
    // Revenue lands where the charge belongs, not in one bucket.
    expect(entry.lines.map((l) => l.accountCode).sort()).toEqual(['1200', '4100', '4200']);
  });

  it('payment received: splits applied from unapplied', () => {
    const entry = post(
      postPaymentReceived({
        paymentId: 'pay_1',
        reference: 'ACH-88123',
        receivedOn: '2026-09-20',
        partyName: 'Midwest Foods',
        appliedAmount: 2_000,
        unappliedAmount: 520.5,
      }),
      'je_2',
    );
    entries.push(entry);
    expect(entryBalances(entry)).toBe(true);
    // Unapplied cash is a liability, not revenue: the carrier is holding someone else's money.
    expect(entry.lines.find((l) => l.accountCode === '2200')?.credit).toBe(toCents(520.5));
  });

  it('bill posted then paid: cost recognised once, on the bill', () => {
    const billed = post(
      postBill({
        billId: 'bill_1',
        billNumber: 'B-500',
        issuedOn: '2026-09-05',
        vendorName: 'TA Truck Service',
        categoryCode: 'maintenance',
        amount: 1_800,
      }),
      'je_3',
    );
    const paid = post(
      postBillPaid({
        paymentId: 'pay_2',
        reference: 'CHK-2210',
        paidOn: '2026-09-25',
        vendorName: 'TA Truck Service',
        amount: 1_800,
      }),
      'je_4',
    );
    entries.push(billed, paid);

    expect(entryBalances(billed)).toBe(true);
    expect(entryBalances(paid)).toBe(true);
    // The payment touches no expense account; debiting it again would double the cost.
    expect(paid.lines.some((l) => l.accountCode.startsWith('5'))).toBe(false);
  });

  it('settlement finalised: escrow is a liability, not income', () => {
    const entry = post(
      postSettlementFinalized({
        settlementId: 'set_1',
        settlementNumber: 'SET-9001',
        onDate: '2026-09-08',
        driverName: 'Darnell Price',
        gross: 3_000,
        deductions: 250,
        escrow: 100,
        net: 2_650,
      }),
      'je_5',
    );
    entries.push(entry);
    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines.find((l) => l.accountCode === '1400')?.credit).toBe(toCents(100));
    // The full gross is the carrier's cost, regardless of what was withheld from it.
    expect(entry.lines.find((l) => l.accountCode === '5200')?.debit).toBe(toCents(3_000));
  });

  it('settlement refuses to post when the parts do not sum to the gross', () => {
    const result = postSettlementFinalized({
      settlementId: 'set_2',
      settlementNumber: 'SET-9002',
      onDate: TODAY,
      driverName: 'Test',
      gross: 3_000,
      deductions: 250,
      escrow: 100,
      net: 2_600,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not reconcile');
  });

  it('payroll finalised: withheld tax is a liability from the moment it is withheld', () => {
    const entry = post(
      postPayrollFinalized({
        periodId: 'pp_1',
        periodLabel: 'Sep 1–15',
        onDate: '2026-09-16',
        gross: 40_000,
        taxWithheld: 9_000,
        deductions: 1_500,
        net: 29_500,
      }),
      'je_6',
    );
    entries.push(entry);
    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines.find((l) => l.accountCode === '2320')?.credit).toBe(toCents(9_000));
  });

  it('an expense paid directly credits cash, not payables', () => {
    const direct = post(
      postExpense({
        expenseId: 'exp_1',
        expenseNumber: 'EX-1',
        onDate: '2026-09-10',
        description: 'Fuel',
        categoryCode: 'fuel',
        amount: 480,
        paidDirectly: true,
      }),
      'je_7',
    );
    entries.push(direct);
    expect(direct.lines.find((l) => l.credit > 0)?.accountCode).toBe('1110');
  });

  it('the whole set of postings leaves a balanced trial balance', () => {
    const tb = trialBalance(entries);
    expect(tb.balanced).toBe(true);
    expect(tb.difference).toBe(0);
  });
});

describe('ledger periods', () => {
  const periods = [
    {
      id: '2026-08',
      year: 2026,
      month: 8,
      status: 'closed' as const,
      closedAt: null,
      closedBy: null,
    },
    {
      id: '2026-09',
      year: 2026,
      month: 9,
      status: 'open' as const,
      closedAt: null,
      closedBy: null,
    },
  ];

  it('refuses a posting into a closed period rather than re-dating it', () => {
    const check = canPost('2026-08-15', periods);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('adjustment');
  });

  it('allows a posting into an open period', () => {
    expect(canPost('2026-09-15', periods).allowed).toBe(true);
  });
});

describe('receivables age from the due date, not the invoice date', () => {
  it('an invoice inside its terms is current however old it is', () => {
    // Issued 40 days ago on net-45: not overdue at all.
    expect(bucketFor('2026-10-05', TODAY)).toBe('current');
    expect(bucketFor('2026-09-29', TODAY)).toBe('1-30');
    expect(bucketFor('2026-08-15', TODAY)).toBe('31-60');
    expect(bucketFor('2026-06-01', TODAY)).toBe('90+');
  });

  it('excludes paid, draft and void invoices from the aging', () => {
    const invoices: AgeableInvoice[] = [
      inv('a', 'cust_1', '2026-08-01', 1_000, 0, 1_000, 'sent'),
      inv('b', 'cust_1', '2026-08-01', 500, 500, 0, 'paid'),
      inv('c', 'cust_1', '2026-08-01', 700, 0, 700, 'draft'),
      inv('d', 'cust_1', '2026-08-01', 300, 0, 300, 'void'),
    ];
    const aging = ageInvoices(invoices, TODAY);
    expect(aging.total).toBe(1_000);
    expect(aging.overdue).toBe(1_000);
  });

  it('reports no average days to pay when nothing has settled', () => {
    const rows = receivablesByCustomer(
      [inv('a', 'cust_1', '2026-10-05', 1_000, 0, 1_000, 'sent')],
      TODAY,
    );
    expect(rows[0]?.averageDaysToPay).toBeNull();
    expect(rows[0]?.settledCount).toBe(0);
  });

  it('averages days to pay from issue to payment across settled invoices', () => {
    const rows = receivablesByCustomer(
      [
        {
          ...inv('a', 'cust_1', '2026-09-20', 1_000, 1_000, 0, 'paid'),
          issuedOn: '2026-08-01',
          paidOn: '2026-08-31',
        },
        {
          ...inv('b', 'cust_1', '2026-09-20', 1_000, 1_000, 0, 'paid'),
          issuedOn: '2026-08-01',
          paidOn: '2026-08-21',
        },
      ],
      TODAY,
    );
    expect(rows[0]?.averageDaysToPay).toBe(25);
  });
});

function inv(
  id: string,
  billToId: string,
  dueOn: string,
  total: number,
  paid: number,
  balance: number,
  status: string,
): AgeableInvoice {
  return {
    id,
    billToId,
    billToName: 'Test customer',
    dueOn,
    issuedOn: '2026-08-01',
    total,
    paid,
    balance,
    status,
    paidOn: null,
  };
}

describe('payment application', () => {
  const targets = [
    { invoiceId: 'a', invoiceNumber: 'INV-1', balance: 1_000 },
    { invoiceId: 'b', invoiceNumber: 'INV-2', balance: 500 },
  ];

  it('refuses to overpay an invoice', () => {
    const check = checkApplication(2_000, [{ invoiceId: 'a', amount: 1_200 }], targets);
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toContain('overpay');
  });

  it('refuses to apply more than was received', () => {
    const check = checkApplication(
      1_000,
      [
        { invoiceId: 'a', amount: 1_000 },
        { invoiceId: 'b', amount: 500 },
      ],
      targets,
    );
    expect(check.ok).toBe(false);
    expect(check.errors.some((e) => e.includes('only'))).toBe(true);
  });

  it('refuses the same invoice twice in one payment', () => {
    const check = checkApplication(
      1_000,
      [
        { invoiceId: 'a', amount: 400 },
        { invoiceId: 'a', amount: 400 },
      ],
      targets,
    );
    expect(check.ok).toBe(false);
    expect(check.errors.some((e) => e.includes('twice'))).toBe(true);
  });

  it('holds the remainder as unapplied rather than forcing it somewhere', () => {
    const check = checkApplication(1_800, [{ invoiceId: 'a', amount: 1_000 }], targets);
    expect(check.ok).toBe(true);
    expect(check.unapplied).toBe(800);
  });

  it('proposes oldest-first, which is how a collections clerk works', () => {
    const due = new Map([
      ['a', '2026-09-25'],
      ['b', '2026-06-01'],
    ]);
    const lines = proposeApplication(1_200, targets, TODAY, due);
    // INV-2 is the older debt even though it is the smaller balance.
    expect(lines[0]?.invoiceId).toBe('b');
    expect(lines[0]?.amount).toBe(500);
    expect(lines[1]?.amount).toBe(700);
  });
});

describe('payables', () => {
  const bill = (
    id: string,
    dueOn: string,
    balance: number,
    status: 'open' | 'pending_approval' | 'paid',
  ) => ({
    id,
    vendorId: 'v1',
    vendorName: 'Vendor',
    dueOn,
    amount: balance,
    paid: 0,
    balance,
    status,
    approvedAt: null,
  });

  it('separates overdue from due-today from due-this-week', () => {
    const summary = summarizePayables(
      [
        bill('a', '2026-09-01', 1_000, 'open'),
        bill('b', TODAY, 500, 'open'),
        bill('c', '2026-10-03', 300, 'open'),
        bill('d', '2026-12-01', 900, 'open'),
        bill('e', '2026-09-01', 400, 'paid'),
      ],
      TODAY,
    );
    expect(summary.overdue).toBe(1_000);
    expect(summary.dueToday).toBe(500);
    expect(summary.dueThisWeek).toBe(300);
    expect(summary.total).toBe(2_700);
    expect(summary.ids.overdue).toEqual(['a']);
  });

  it('requires approval above the threshold or for an unknown vendor', () => {
    const known = new Set(['v1']);
    expect(needsApproval({ amount: 100, vendorId: 'v1' }, known).required).toBe(false);
    expect(
      needsApproval({ amount: DEFAULT_APPROVAL_POLICY.reviewAbove, vendorId: 'v1' }, known)
        .required,
    ).toBe(true);
    expect(needsApproval({ amount: 50, vendorId: 'v9' }, known).reason).toContain('not on file');
  });
});

describe('settlement calculation', () => {
  const load = (over: Partial<Parameters<typeof loadPay>[0]> = {}) => ({
    id: 'l1',
    loadNumber: 'L-1',
    deliveredOn: '2026-09-03',
    originLabel: 'Chicago, IL',
    destinationLabel: 'Dallas, TX',
    loadedMiles: 900,
    emptyMiles: 100,
    linehaulRevenue: 2_500,
    driverAccessorials: [],
    ...over,
  });

  it('pays per-mile drivers on every mile turned, loaded and empty', () => {
    const pay = loadPay(load(), { kind: 'per_mile', rate: 0.62 });
    expect('amount' in pay && pay.amount).toBe(620);
    expect('basis' in pay && pay.basis).toContain('1,000 mi');
  });

  it('pays a percentage driver off linehaul only', () => {
    const pay = loadPay(load(), { kind: 'percent_of_linehaul', rate: 27 });
    expect('amount' in pay && pay.amount).toBe(675);
  });

  it('excludes and names a load it cannot pay, rather than paying zero', () => {
    const result = calculateSettlement({
      driverId: 'd1',
      driverName: 'Test',
      payPlan: { kind: 'per_mile', rate: 0.62 },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      loads: [load(), load({ id: 'l2', loadNumber: 'L-2', loadedMiles: null })],
      deductions: [],
      adjustments: [],
    });
    expect(result.paidLoads).toBe(1);
    expect(result.excluded).toEqual([
      { loadId: 'l2', loadNumber: 'L-2', reason: 'No loaded miles recorded on the load' },
    ]);
    expect(result.gross).toBe(620);
  });

  it('never takes a settlement negative, and reports the shortfall', () => {
    const result = calculateSettlement({
      driverId: 'd1',
      driverName: 'Test',
      payPlan: { kind: 'flat_rate', rate: 200 },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      loads: [load()],
      deductions: [{ kind: 'lease', description: 'Truck lease', amountPerPeriod: 500 }],
      adjustments: [],
    });
    expect(result.net).toBe(0);
    expect(result.deductions).toBe(200);
    expect(result.shortfall).toBe(300);
  });

  it('keeps escrow separate from other deductions', () => {
    const result = calculateSettlement({
      driverId: 'd1',
      driverName: 'Test',
      payPlan: { kind: 'flat_rate', rate: 1_000 },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      loads: [load()],
      deductions: [
        { kind: 'escrow', description: 'Escrow', amountPerPeriod: 50 },
        { kind: 'insurance', description: 'Occ/acc', amountPerPeriod: 120 },
      ],
      adjustments: [],
    });
    expect(result.escrow).toBe(50);
    expect(result.deductions).toBe(120);
    expect(result.net).toBe(830);
  });

  it('the lines always sum to the net', () => {
    const result = calculateSettlement({
      driverId: 'd1',
      driverName: 'Test',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      loads: [load(), load({ id: 'l2', loadNumber: 'L-2' })],
      deductions: [{ kind: 'escrow', description: 'Escrow', amountPerPeriod: 50 }],
      adjustments: [{ description: 'Detention correction', amount: 75, reason: 'Missed on L-1' }],
    });
    const sum = Math.round(result.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    expect(sum).toBe(result.net);
  });

  it('locks a finalised settlement to reversal rather than editing', () => {
    expect(settlementTransitions('finalized')).toEqual(['paid', 'reversed']);
    expect(settlementTransitions('reversed')).toEqual([]);
  });
});

describe('payroll', () => {
  const slip = (over: Partial<Parameters<typeof runPayroll>[0][number]> = {}) => ({
    id: 'ps1',
    employeeId: 'u1',
    employeeName: 'Test',
    workerType: 'employee' as const,
    basePay: 2_000,
    bonuses: 0,
    taxWithheld: 400,
    deductions: 100,
    hours: null,
    hourly: false,
    ...over,
  });

  it('never estimates tax, and names the payslips without it', () => {
    const result = runPayroll([slip({ taxWithheld: null })]);
    expect(result.taxUnavailableFor).toEqual(['ps1']);
    expect(result.exceptions.some((e) => e.kind === 'missing_tax')).toBe(true);
  });

  it('blocks finalising on a duplicate worker', () => {
    const result = runPayroll([slip(), slip({ id: 'ps2' })]);
    expect(result.canFinalize).toBe(false);
    const dup = result.exceptions.find((e) => e.kind === 'duplicate_worker');
    expect(dup?.ids.sort()).toEqual(['ps1', 'ps2']);
  });

  it('blocks finalising on a negative net', () => {
    const result = runPayroll([slip({ deductions: 5_000 })]);
    expect(result.canFinalize).toBe(false);
    expect(result.exceptions.some((e) => e.kind === 'negative_net')).toBe(true);
  });

  it('blocks finalising when an hourly worker has no hours', () => {
    const result = runPayroll([slip({ hourly: true, hours: null })]);
    expect(result.canFinalize).toBe(false);
  });

  it('does not ask a contractor for withholding', () => {
    const result = runPayroll([slip({ workerType: 'contractor', taxWithheld: null })]);
    expect(result.exceptions.some((e) => e.kind === 'missing_tax')).toBe(false);
  });

  it('finalises a clean period', () => {
    const result = runPayroll([slip(), slip({ id: 'ps2', employeeId: 'u2' })]);
    expect(result.canFinalize).toBe(true);
    expect(result.gross).toBe(4_000);
    expect(result.net).toBe(3_000);
  });
});

describe('period figures', () => {
  const entries = [
    post(
      postInvoiceIssued({
        invoiceId: 'i1',
        invoiceNumber: 'INV-1',
        issuedOn: '2026-09-10',
        billToName: 'C',
        lines: [{ chargeType: 'linehaul', description: 'Linehaul', amount: 10_000 }],
      }),
      'e1',
    ),
    post(
      postExpense({
        expenseId: 'x1',
        expenseNumber: 'EX-1',
        onDate: '2026-09-11',
        description: 'Fuel',
        categoryCode: 'fuel',
        amount: 3_000,
        paidDirectly: true,
      }),
      'e2',
    ),
  ];

  it('reports null, not zero, for a period with no postings', () => {
    const figures = periodFigures(entries, { from: '2026-01-01', to: '2026-01-31' });
    expect(figures.revenue).toBeNull();
    expect(figures.grossProfit).toBeNull();
  });

  it('computes profit from the ledger, not from the operational records', () => {
    const figures = periodFigures(entries, { from: '2026-09-01', to: '2026-09-30' });
    expect(figures.revenue).toBe(10_000);
    expect(figures.directCost).toBe(3_000);
    expect(figures.grossProfit).toBe(7_000);
    expect(figures.grossMarginPct).toBe(70);
  });

  it('splits cash in from cash out rather than netting them', () => {
    const figures = periodFigures(entries, { from: '2026-09-01', to: '2026-09-30' });
    expect(figures.cashOut).toBe(3_000);
    expect(figures.cashIn).toBe(0);
  });

  it('does not report a percentage change from a period with nothing in it', () => {
    expect(compare(1_000, null).changePct).toBeNull();
    expect(compare(1_000, 0).changePct).toBeNull();
    expect(compare(1_200, 1_000).changePct).toBe(20);
  });

  it('builds the previous range as an equal span immediately before', () => {
    const range = rangeFor('month', '2026-09-30');
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousRange(range)).toEqual({ from: '2026-08-02', to: '2026-08-31' });
  });

  it('reconciles cost per mile with the P&L, and says what it needs without miles', () => {
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const withMiles = costPerMile(entries, range, 10_000);
    expect(withMiles.totalCost).toBe(3_000);
    expect(withMiles.costPerMile).toBe(0.3);
    expect(withMiles.totalCost).toBe(periodFigures(entries, range).directCost);

    const without = costPerMile(entries, range, null);
    expect(without.costPerMile).toBeNull();
    expect(without.unavailable).toContain('miles');
  });
});
